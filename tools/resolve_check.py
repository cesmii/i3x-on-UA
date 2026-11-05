#!/usr/bin/env python3
"""Check that a set of NodeSet2.xml files is self-consistent.

Usage: python3 -I tools/resolve_check.py <file-or-dir> [<file-or-dir> ...]

Reports, per file:
  * each RequiredModel: present? local version older than required?
  * references, ReferenceTypes, TypeDefinitions and DataTypes that point at
    NodeIds no loaded file defines, grouped by namespace URI.
Exit code 1 if any required model is missing or any reference is unresolved.
"""
import glob
import os
import re
import sys
import xml.etree.ElementTree as ET

U = '{http://opcfoundation.org/UA/2011/03/UANodeSet.xsd}'
CORE = 'http://opcfoundation.org/UA/'


def files_from(args):
    out = []
    for a in args:
        out += sorted(glob.glob(os.path.join(a, '**', '*.xml'), recursive=True)) if os.path.isdir(a) else [a]
    return out


def ver_key(v):
    return tuple(int(x) for x in re.findall(r'\d+', v or ''))


class NodeSet:
    def __init__(self, path):
        self.path = path
        self.root = ET.parse(path).getroot()
        self.uris = [CORE] + [u.text for u in self.root.findall(f'{U}NamespaceUris/{U}Uri')]
        self.aliases = {a.get('Alias'): a.text for a in self.root.findall(f'{U}Aliases/{U}Alias')}
        self.models = self.root.findall(f'{U}Models/{U}Model')

    def qualify(self, nid):
        nid = self.aliases.get(nid, nid).strip()
        m = re.match(r'(?:ns=(\d+);)?(.*)', nid, re.S)
        return self.uris[int(m.group(1) or 0)], m.group(2)

    def nodes(self):
        return (n for n in self.root if n.tag.startswith(U + 'UA'))


def main(argv):
    sets = [NodeSet(p) for p in files_from(argv)]
    defined, models = set(), {}
    for s in sets:
        for n in s.nodes():
            defined.add(s.qualify(n.get('NodeId')))
        for m in s.models:
            models[m.get('ModelUri')] = (m.get('Version'), s.path)

    bad = False
    for s in sets:
        name = os.path.relpath(s.path)
        problems = []
        for m in s.models:
            for r in m.findall(f'{U}RequiredModel'):
                uri, need = r.get('ModelUri'), r.get('Version')
                if uri not in models:
                    problems.append(f'  MISSING model {uri} {need or ""}')
                    bad = True
                elif need and ver_key(models[uri][0]) < ver_key(need):
                    problems.append(f'  older model  {uri}: have {models[uri][0]}, requires {need}')
        unresolved = {}
        for n in s.nodes():
            targets = [(r.text, 'ref') for r in n.findall(f'{U}References/{U}Reference')]
            targets += [(r.get('ReferenceType'), 'refType') for r in n.findall(f'{U}References/{U}Reference')]
            if n.get('DataType'):
                targets.append((n.get('DataType'), 'dataType'))
            for t, kind in targets:
                q = s.qualify(t)
                if q not in defined:
                    unresolved.setdefault(q[0], []).append((n.get('NodeId'), kind, q[1]))
        for uri, items in unresolved.items():
            bad = True
            distinct = len({i[2] for i in items})
            problems.append(f'  unresolved   {len(items)} refs ({distinct} distinct) into {uri}; e.g. {items[0]}')
        print(f'{"OK " if not problems else "!! "} {name}')
        for p in problems:
            print(p)
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:] or ['nodesets']))
