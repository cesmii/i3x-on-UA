#!/usr/bin/env python3
"""Give every InstanceDeclaration in a NodeSet its own node.

OWNERSHIP: only run this on models we own (today: the CESMII Acme profile in
nodesets/vendor/). Never on PMMI or OPC Foundation NodeSets.

Defect repaired: a node X has a forward aggregating reference (HasComponent,
HasProperty, HasAddIn, HasOrderedComponent) to a node Y that X does not own,
either because
  * Y lives in another NodeSet (e.g. ProcessValues' AnalogSignal declaration), or
  * Y is owned by another node in this NodeSet (ParentNodeId != X), typically
    another type's member.
Each such Y is replaced by a fresh copy owned by X, recursively, including Y's
own aggregated children. Copies keep BrowseName, DataType, ValueRank,
TypeDefinition, ModellingRule, DisplayName, Description and Value, with
namespace indexes translated into the target file.

Usage:
  python3 -I tools/repair_shared_declarations.py <target.NodeSet2.xml> <deps-dir> \
      --version 1.01 --date 2026-11-05T00:00:00Z [--out file]
"""
import argparse
import glob
import os
import re
import sys
import xml.etree.ElementTree as ET

UA = 'http://opcfoundation.org/UA/2011/03/UANodeSet.xsd'
U = '{%s}' % UA
TYPES = 'http://opcfoundation.org/UA/2008/02/Types.xsd'
CORE = 'http://opcfoundation.org/UA/'
AGG = {'i=46', 'i=47', 'i=49', 'i=17604'}  # HasProperty, HasComponent, HasOrderedComponent, HasAddIn
ET.register_namespace('', UA)
ET.register_namespace('uax', TYPES)


class Doc:
    def __init__(self, path):
        self.path = path
        self.root = ET.parse(path).getroot()
        self.uris = [CORE] + [u.text for u in self.root.findall(f'{U}NamespaceUris/{U}Uri')]
        self.aliases = {a.get('Alias'): a.text.strip() for a in self.root.findall(f'{U}Aliases/{U}Alias')}
        self.nodes = [n for n in self.root if n.tag.startswith(U + 'UA')]

    def key(self, nid):
        nid = self.aliases.get(nid, nid).strip()
        m = re.match(r'(?:ns=(\d+);)?(.*)', nid, re.S)
        return self.uris[int(m.group(1) or 0)], m.group(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('target')
    ap.add_argument('deps')
    ap.add_argument('--version', required=True)
    ap.add_argument('--date', required=True)
    ap.add_argument('--out')
    a = ap.parse_args()

    tgt = Doc(a.target)
    text = open(a.target, encoding='utf-8').read()
    own_uri = tgt.uris[1]
    docs = [tgt] + [Doc(p) for p in sorted(glob.glob(os.path.join(a.deps, '*.xml')))
                    if os.path.abspath(p) != os.path.abspath(a.target)]
    index = {}
    for d in docs:
        for n in d.nodes:
            index.setdefault(d.key(n.get('NodeId')), (n, d))
    alias_by_key = {tgt.key(v): k for k, v in tgt.aliases.items()}
    added_uris = []

    def to_tgt(k):
        uri, ident = k
        if uri not in tgt.uris:
            tgt.uris.append(uri)  # a copied declaration points into a namespace the target didn't list yet
            added_uris.append(uri)
        i = tgt.uris.index(uri)
        return ident if i == 0 else f'ns={i};{ident}'

    def name_or_id(k):  # prefer the target's alias (keeps the file's style)
        return alias_by_key.get(k, to_tgt(k))

    new_aliases = {}

    def ref_alias(k):  # reference types are written by alias, as in the rest of the file; add one if missing
        if k in alias_by_key:
            return alias_by_key[k]
        if k[0] == CORE and k in index:
            name = index[k][0].get('BrowseName')
            new_aliases[name] = to_tgt(k)
            alias_by_key[k] = name
            return name
        return to_tgt(k)

    def bn_to_tgt(bn, d):
        m = re.match(r'(\d+):(.*)', bn)
        if not m:
            return bn
        uri = d.uris[int(m.group(1))]
        i = tgt.uris.index(uri)
        return m.group(2) if i == 0 else f'{i}:{m.group(2)}'

    used = {int(m) for m in re.findall(r'NodeId="ns=1;i=(\d+)"', text)}
    nxt = {'UAObject': max(x for x in used if 5000 <= x < 6000) + 1,
           'UAVariable': max(x for x in used if 6000 <= x < 7000) + 1}

    def alloc(tag):
        n = nxt[tag]
        while n in used:
            n += 1
        used.add(n)
        nxt[tag] = n + 1
        return f'ns=1;i={n}'

    def esc(s):
        return s.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;').replace('"', '&quot;')

    copies_made = []

    def copy(k, parent):
        node, d = index[k]
        tag = node.tag[len(U):]
        if tag not in nxt:
            sys.exit(f'cannot copy {tag} {k}')
        nid = alloc(tag)
        attrs = []
        if node.get('DataType'):
            attrs.append(('DataType', name_or_id(d.key(node.get('DataType')))))
        for at in ('ValueRank', 'ArrayDimensions'):
            if node.get(at) is not None:
                attrs.append((at, node.get(at)))
        attrs += [('NodeId', nid), ('BrowseName', bn_to_tgt(node.get('BrowseName'), d)), ('ParentNodeId', parent)]
        for at, v in node.attrib.items():
            if at not in ('DataType', 'ValueRank', 'ArrayDimensions', 'NodeId', 'BrowseName', 'ParentNodeId', 'SymbolicName'):
                attrs.append((at, v))
        lines = ['    <%s %s>' % (tag, ' '.join(f'{x}="{esc(y)}"' for x, y in attrs))]
        for el in ('DisplayName', 'Description'):
            e = node.find(f'{U}{el}')
            if e is not None and e.text:
                loc = f' Locale="{e.get("Locale")}"' if e.get('Locale') else ''
                lines.append(f'        <{el}{loc}>{esc(e.text)}</{el}>')
        refs, children = [], []
        for r in node.findall(f'{U}References/{U}Reference'):
            if r.get('IsForward', 'true') != 'true':
                continue  # parent link is implied by ParentNodeId + the parent's forward reference
            rk = d.key(r.get('ReferenceType'))
            if to_tgt(rk) in AGG:
                cid, cl = copy(d.key(r.text), nid)
                refs.append((name_or_id(rk), cid))
                children += cl
            else:
                refs.append((ref_alias(rk), to_tgt(d.key(r.text))))
        lines.append('        <References>')
        lines += [f'            <Reference ReferenceType="{rt}">{t}</Reference>' for rt, t in refs]
        lines.append('        </References>')
        v = node.find(f'{U}Value')
        if v is not None:
            body = re.sub(r' xmlns(?::\w+)?="[^"]*"', '', ET.tostring(v, encoding='unicode').strip())  # root already declares them
            raw = [l.strip() for l in body.splitlines() if l.strip()]
            depth, out = 0, []
            for l in raw:  # re-indent to the file's 4-space style
                if l.startswith('</'):
                    depth -= 1
                out.append('    ' * (2 + depth) + l)
                if not l.startswith('</') and not l.endswith('/>') and '</' not in l:
                    depth += 1
            body = '\n'.join(out).lstrip()
            if re.search(r'ns=\d+;', body):
                print(f'warning: value of {k} contains namespace-indexed ids; review', file=sys.stderr)
            lines.append('        ' + body)
        lines.append(f'    </{tag}>')
        copies_made.append((nid, k))
        return nid, ['\n'.join(lines) + '\n'] + children

    # one pass over the original nodes, in file order
    edits = []  # (nodeId, [(refTypeText, oldTarget, newTarget)], insertedXml)
    for n in tgt.nodes:
        x = n.get('NodeId')
        fixes, inserted = [], []
        for r in n.findall(f'{U}References/{U}Reference'):
            if r.get('IsForward', 'true') != 'true' or to_tgt(tgt.key(r.get('ReferenceType'))) not in AGG:
                continue
            k = tgt.key(r.text)
            owned = k[0] == own_uri and k in index and index[k][0].get('ParentNodeId') == x
            if owned:
                continue
            new, xml = copy(k, x)
            fixes.append((r.get('ReferenceType'), r.text.strip(), new))
            inserted += xml
        if fixes:
            edits.append((x, fixes, inserted))

    for x, fixes, inserted in edits:
        m = re.search(r'(    <(UA\w+)\b[^>]*\bNodeId="%s"[^>]*>.*?</\2>\n)' % re.escape(x), text, re.S)
        if not m:
            sys.exit(f'block for {x} not found')
        block = m.group(1)
        for rt, old, new in fixes:
            line = f'<Reference ReferenceType="{rt}">{old}</Reference>'
            if block.count(line) != 1:
                sys.exit(f'{x}: expected exactly one "{line}"')
            block = block.replace(line, f'<Reference ReferenceType="{rt}">{new}</Reference>')
        text = text[:m.start(1)] + block + ''.join(inserted) + text[m.end(1):]

    for name, nid in new_aliases.items():
        text = text.replace('    </Aliases>', f'        <Alias Alias="{name}">{nid}</Alias>\n    </Aliases>', 1)
        print(f'added alias {name} = {nid}')

    # namespaces the copies introduced: NamespaceUris entry + RequiredModel (from the dependency's own Model element)
    for uri in added_uris:
        text = text.replace('    </NamespaceUris>', f'        <Uri>{uri}</Uri>\n    </NamespaceUris>', 1)
        dep = next((d for d in docs if any(m.get('ModelUri') == uri for m in d.root.findall(f'{U}Models/{U}Model'))), None)
        if not dep:
            sys.exit(f'no NodeSet in deps defines model {uri}')
        m = next(m for m in dep.root.findall(f'{U}Models/{U}Model') if m.get('ModelUri') == uri)
        # declare the highest version any dependency requires (a local copy may be older than what the deps need)
        cands = [(m.get('Version'), m.get('PublicationDate'))] + [
            (r.get('Version'), r.get('PublicationDate')) for d in docs for r in d.root.findall(f'{U}Models/{U}Model/{U}RequiredModel')
            if r.get('ModelUri') == uri and r.get('Version')]
        ver, pub = max(cands, key=lambda c: tuple(int(x) for x in re.findall(r'\d+', c[0])))
        req = f'            <RequiredModel ModelUri="{uri}" PublicationDate="{pub}" Version="{ver}"/>\n'
        text = re.sub(r'(<Model ModelUri="%s".*?)(        </Model>)' % re.escape(own_uri), lambda mm: mm.group(1) + req + mm.group(2), text, count=1, flags=re.S)
        print(f'added namespace + RequiredModel {uri} {ver}')

    # version bump
    text, n1 = re.subn(r'(<Model ModelUri="%s"[^>]*?)PublicationDate="[^"]*"' % re.escape(own_uri), r'\1PublicationDate="%s"' % a.date, text)
    text, n2 = re.subn(r'(<Model ModelUri="%s"[^>]*?)Version="[^"]*"' % re.escape(own_uri), r'\1Version="%s"' % a.version, text)
    text = re.sub(r'(<UANodeSet LastModified=")[^"]*"', r'\g<1>%s"' % a.date, text, count=1)
    if not (n1 and n2):
        sys.exit('Model element not updated')
    open(a.out or a.target, 'w', encoding='utf-8').write(text)
    print(f'{len(edits)} nodes fixed, {sum(len(f) for _, f, _ in edits)} references re-pointed, '
          f'{len(copies_made)} nodes created; version {a.version}')


if __name__ == '__main__':
    main()
