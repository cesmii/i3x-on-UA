/**
 * Phase 6 fidelity audit: "every known loss is described somewhere it can be found".
 *
 * Two independent views of the same plant:
 *   1. the OPC UA server, read as a plain client (Browse + Read only; none of the gateway's crawl/projection code), and
 *   2. the gateway's i3X API over HTTP (what a client actually sees).
 * For every OPC UA feature that i3X 1.0 cannot carry as-is, it checks that the i3X side says so on the Object, its
 * ObjectType, the RelationshipType or the Namespace (metadata.opcua.fidelity), or exposes the fact in metadata.
 *
 *   node --import tsx gateway/src/tools/fidelity-audit.ts [--i3x http://localhost:8081/v1] [--opcua opc.tcp://…] [--json out.json] [--gaps N]
 * Exit code 1 when a loss is not described anywhere.
 */
import fs from "node:fs";
import { AttributeIds, BrowseDirection, NodeClass, NodeId, OPCUAClient, type ClientSession, type ReferenceDescription } from "node-opcua";

const arg = (k: string, d: string) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const I3X = arg("--i3x", process.env.I3X_URL ?? "http://localhost:8081/v1").replace(/\/+$/, "");
const UA = arg("--opcua", process.env.OPCUA_ENDPOINT ?? "opc.tcp://localhost:4840/UA/BeverageFactory");
const JSON_OUT = arg("--json", "");
const SHOW = Number(arg("--gaps", "5"));

// ------------------------------------------------------------------ OPC UA side (plain client)
const client = OPCUAClient.create({ applicationName: "i3x fidelity audit", endpointMustExist: false, connectionStrategy: { maxRetry: 3, initialDelay: 500, maxDelay: 2000 } });
await client.connect(UA);
const session: ClientSession = await client.createSession();
const ns: string[] = await session.readNamespaceArray();
const key = (n: { namespace: number; identifierType: number; value: unknown }) => {
  const s = new NodeId(n.identifierType, n.value as never, n.namespace).toString();
  return n.namespace === 0 ? s.replace(/^ns=0;/, "") : `nsu=${ns[n.namespace]};${s.replace(/^ns=\d+;/, "")}`;
};
const toNodeId = (k: string) => { const m = k.match(/^nsu=([^;]*);(.*)$/); return m ? NodeId.resolveNodeId(`ns=${ns.indexOf(m[1])};${m[2]}`) : NodeId.resolveNodeId(k); };
const chunks = <T>(a: T[], n = 200) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

async function browse(ids: string[], dir = BrowseDirection.Forward, refType = "i=31") {
  const out = new Map<string, ReferenceDescription[]>();
  for (const part of chunks(ids)) {
    const res = await session.browse(part.map((id) => ({ nodeId: toNodeId(id), browseDirection: dir, referenceTypeId: refType, includeSubtypes: true, nodeClassMask: 0, resultMask: 63 })));
    part.forEach((id, i) => out.set(id, res[i].references ?? []));
  }
  return out;
}
async function read(ids: string[], attr: AttributeIds) {
  const out = new Map<string, unknown>();
  for (const part of chunks(ids, 500)) {
    const dvs = await session.read(part.map((id) => ({ nodeId: toNodeId(id), attributeId: attr })));
    part.forEach((id, i) => { if (dvs[i].statusCode.isGood()) out.set(id, dvs[i].value.value); });
  }
  return out;
}

/** Supertype chains (inverse HasSubtype), for ReferenceTypes, ObjectTypes, VariableTypes and DataTypes alike. */
const supertype = new Map<string, string | null>();
async function loadSupertypes(ids: Iterable<string>) {
  let todo = [...new Set(ids)].filter((x) => !supertype.has(x));
  while (todo.length) {
    const res = await browse(todo, BrowseDirection.Inverse, "i=45");
    const next: string[] = [];
    for (const [id, refs] of res) { const s = refs[0] ? key(refs[0].nodeId) : null; supertype.set(id, s); if (s && !supertype.has(s)) next.push(s); }
    todo = [...new Set(next)];
  }
}
const chain = (id: string) => { const c: string[] = []; for (let t: string | null | undefined = id, g = 0; t && g < 64; t = supertype.get(t), g++) c.push(t); return c; };
const isA = (id: string | undefined, base: string) => !!id && chain(id).includes(base);
const builtin = (dt: string | undefined) => (dt ? chain(dt).find((t) => /^i=([1-9]|1\d|2\d)$/.test(t)) : undefined) ?? "i=24";

const R = { Hier: "i=33", HasProperty: "i=46", HasComponent: "i=47", HasTypeDefinition: "i=40", HasModellingRule: "i=37", HasInterface: "i=17603",
  HasHistConfig: "i=56", BaseInterfaceType: "i=17602", Structure: "i=22", HasEventSource: "i=36", GeneratesEvent: "i=41" };

interface Ref { type: string; target: string; nodeClass: string; browseName: string; typeDefinition?: string }
interface Node { id: string; nodeClass: string; browseName: string; parent?: string; via?: string; refs: Ref[]; incoming: Array<{ from: string; type: string }>;
  displayLocale?: string; description?: string; descLocale?: string; dataType?: string; valueRank?: number; accessLevel?: number; historizing?: boolean; eventNotifier?: number;
  typeDefinition?: string; role: "candidate" | "excluded" | "histConfig" }
const nodes = new Map<string, Node>();
const refNames = new Map<string, { name: string; symmetric: boolean }>();

// walk Objects (i=85): every hierarchical path, recording what is and is not a model node
const root: Node = { id: "i=85", nodeClass: "Object", browseName: "Objects", refs: [], incoming: [], role: "candidate" };
nodes.set(root.id, root);
let level = [root.id];
while (level.length) {
  const res = await browse(level);
  const rts = new Set<string>(); for (const refs of res.values()) for (const r of refs) rts.add(key(r.referenceTypeId));
  await loadSupertypes(rts);
  const next: string[] = [];
  for (const [id, refs] of res) {
    const n = nodes.get(id)!;
    for (const r of refs) {
      if (!r.isForward) continue;
      const type = key(r.referenceTypeId), target = key(r.nodeId);
      if (type === R.HasTypeDefinition) { n.typeDefinition = target; continue; }
      const nc = NodeClass[r.nodeClass] as string;
      n.refs.push({ type, target, nodeClass: nc, browseName: r.browseName.name ?? "", typeDefinition: r.typeDefinition && !r.typeDefinition.isEmpty() ? key(r.typeDefinition) : undefined });
      if (!isA(type, R.Hier) || !["Object", "Variable"].includes(nc)) continue;
      const t = nodes.get(target);
      if (t) { t.incoming.push({ from: id, type }); continue; }
      const role = isA(type, R.HasHistConfig) ? "histConfig" : r.nodeId.namespace === 0 && n.role === "candidate" ? "excluded" : n.role === "candidate" ? "candidate" : n.role;
      nodes.set(target, { id: target, nodeClass: nc, browseName: r.browseName.name ?? "", parent: id, via: type, refs: [], incoming: [{ from: id, type }], role });
      if (role === "candidate") next.push(target);      // don't descend into Server, historian config, …
    }
  }
  level = next;
}
// attributes
const all = [...nodes.keys()].filter((x) => x !== "i=85");
const vars = all.filter((x) => nodes.get(x)!.nodeClass === "Variable");
const objs = all.filter((x) => nodes.get(x)!.nodeClass === "Object");
const [dn, desc, dt, vr, al, hist, en] = await Promise.all([
  read(all, AttributeIds.DisplayName), read(all, AttributeIds.Description), read(vars, AttributeIds.DataType), read(vars, AttributeIds.ValueRank),
  read(vars, AttributeIds.UserAccessLevel), read(vars, AttributeIds.Historizing), read(objs, AttributeIds.EventNotifier)]);
for (const id of all) {
  const n = nodes.get(id)!;
  const d = dn.get(id) as { locale?: string } | undefined; if (d?.locale) n.displayLocale = d.locale;
  const s = desc.get(id) as { text?: string; locale?: string } | undefined; if (s?.text) { n.description = s.text; if (s.locale) n.descLocale = s.locale; }
  if (dt.has(id)) n.dataType = key(dt.get(id) as NodeId);
  if (vr.has(id)) n.valueRank = vr.get(id) as number;
  if (al.has(id)) n.accessLevel = al.get(id) as number;
  if (hist.has(id)) n.historizing = hist.get(id) as boolean;
  if (en.has(id)) n.eventNotifier = en.get(id) as number;
}
await loadSupertypes([...nodes.values()].flatMap((n) => [n.typeDefinition, n.dataType].filter(Boolean) as string[]));
for (const id of new Set([...nodes.values()].flatMap((n) => n.refs.map((r) => r.type)))) {
  refNames.set(id, { name: ((await read([id], AttributeIds.BrowseName)).get(id) as { name: string })?.name ?? id,
    symmetric: ((await read([id], AttributeIds.Symmetric)).get(id) as boolean) ?? false });
}

// ------------------------------------------------------------------ i3X side (HTTP only)
const get = async (p: string) => { const r = await fetch(`${I3X}${p}`); const j = await r.json() as { result: any }; return j.result; };
const [nsList, typeList, relList, objList] = await Promise.all([get("/namespaces"), get("/objecttypes"), get("/relationshiptypes"), get("/objects?includeMetadata=true")]);
const objects = new Map<string, any>(objList.map((o: any) => [o.elementId, o]));
const types = new Map<string, any>(typeList.map((t: any) => [t.elementId, t]));
const rels = new Map<string, any>(relList.map((t: any) => [t.elementId, t]));
const namespaces = new Map<string, any>(nsList.map((n: any) => [n.uri, n]));
const fid = (e: any): Array<{ aspect: string; loss: string; detail: string }> => e?.metadata?.opcua?.fidelity ?? e?.metadata?.fidelity ?? [];
const nsOf = (o: any) => namespaces.get(o?.metadata?.typeNamespaceUri);
const uaNs = namespaces.get("http://opcfoundation.org/UA/?projection=i3X");

// ------------------------------------------------------------------ rules
type Level = "object" | "type" | "relationshipType" | "namespace" | "metadata";
interface Result { rule: string; what: string; occurrences: number; covered: Record<string, number>; gaps: string[]; example?: string }
const results = new Map<string, Result>();
function check(rule: string, what: string, element: string, found: Level | null) {
  const r = results.get(rule) ?? results.set(rule, { rule, what, occurrences: 0, covered: {}, gaps: [] }).get(rule)!;
  r.occurrences++;
  if (found) { r.covered[found] = (r.covered[found] ?? 0) + 1; r.example ??= element; } else r.gaps.push(element);
}
/** Is the loss described with one of `aspects` on the Object, its type, or its namespace (in that order, if allowed)? */
function noted(o: any, aspects: string[], levels: Level[] = ["object", "type", "namespace"], mention?: string): Level | null {
  const hit = (e: any) => fid(e).some((f) => aspects.includes(f.aspect) && (!mention || f.detail.includes(mention)));
  if (levels.includes("object") && hit(o)) return "object";
  if (levels.includes("type") && hit(types.get(o?.typeElementId))) return "type";
  if (levels.includes("namespace") && (hit(nsOf(o)) || hit(uaNs))) return "namespace";
  return null;
}
const schemaKeys = (typeId: string, seen = new Set<string>()): Set<string> => {
  const t = types.get(typeId); if (!t || seen.has(typeId)) return new Set(); seen.add(typeId);
  const out = new Set<string>(Object.keys(t.schema?.properties ?? {}));
  for (const part of t.schema?.allOf ?? []) { for (const k of Object.keys(part.properties ?? {})) out.add(k); if (part.$ref) for (const k of schemaKeys(part.$ref, seen)) out.add(k); }
  return out;
};
const relTargets = (o: any) => new Set<string>(Object.values(o?.metadata?.relationships ?? {}).flat() as string[]);

const isPropRef = (type: string, targetTd?: string) => isA(type, R.HasProperty) || (isA(type, R.HasComponent) && targetTd === "i=68");
const model = [...nodes.values()].filter((n) => n.role === "candidate" && n.id !== "i=85");

for (const n of model) {
  const parentNode = n.parent ? nodes.get(n.parent) : undefined;
  const asProp = n.nodeClass === "Variable" && n.incoming.some((x) => isPropRef(x.type, n.typeDefinition));
  const o = objects.get(n.id);
  if (asProp) {
    // A Property: an attribute of its owner's value (schema), or metadata.opcua.properties for a Variable's Properties
    const owner = objects.get(n.parent!);
    const found = !owner ? null
      : owner.metadata?.opcua?.nodeClass === "Variable" ? (n.browseName in (owner.metadata.opcua.properties ?? {}) ? "metadata" : null)
      : schemaKeys(owner.typeElementId).has(n.browseName) || n.browseName in (owner.metadata?.schemaExtensions ?? {}) ? "type" : null;
    check("property.findable", "Property → attribute of the owner's value (type schema / schemaExtensions) or metadata.opcua.properties", n.id, found);
    if (owner && owner.metadata?.opcua?.nodeClass !== "Variable" && found) check("property.flattened", "Properties as attributes: noted", n.id, noted(owner, ["properties"]));
    if (n.accessLevel !== undefined && (n.accessLevel & 2) && owner && owner.metadata?.opcua?.nodeClass !== "Variable")
      check("access.writableProperty", "Writable Property → listed in owner's metadata.opcua.writableProperties", n.id, owner.metadata?.opcua?.writableProperties?.includes(n.browseName) ? "metadata" : null);
    continue;
  }
  if (!o) { check("node.projected", "Model Object/Variable reachable from Objects → an i3X Object", n.id, null); continue; }
  check("node.projected", "Model Object/Variable reachable from Objects → an i3X Object", n.id, "object");

  // hierarchy: more than one hierarchical (non-Property) path in
  const parents = n.incoming.filter((x) => !isPropRef(x.type, n.typeDefinition) && !isA(x.type, R.HasEventSource) && !refNames.get(x.type)?.symmetric && nodes.get(x.from)?.role === "candidate");
  if (parents.length > 1) check("hierarchy.multiPath", "Node reached by several hierarchical paths (i3X: one parent)", n.id, noted(o, ["parent"], ["object"]));
  const methods = n.refs.filter((r) => r.nodeClass === "Method");
  if (methods.length) {
    check("methods.listed", "Methods → metadata.opcua.methods", n.id, methods.every((m) => (o.metadata?.opcua?.methods ?? []).some((x: string) => x.endsWith(m.browseName))) ? "metadata" : null);
    check("methods.dropped", "Methods not callable: noted", n.id, noted(o, ["methods"]));
  }
  if (n.typeDefinition && isA(n.typeDefinition, R.BaseInterfaceType)) check("type.interfaceAsTypeDefinition", "Interface used as TypeDefinition: noted", n.id, noted(o, ["typeDefinition"], ["object"]));
  if (n.displayLocale) check("text.displayNameLocale", "DisplayName locale dropped: noted", n.id, noted(o, ["displayName"], ["object"]));
  if (n.descLocale) check("text.descriptionLocale", "Description locale dropped: noted", n.id, noted(o, ["description", "localizedText"]));
  if (n.nodeClass === "Object" && n.eventNotifier) check("events.notifier", "EventNotifier set (events not projected): noted", n.id, noted(o, ["events"], ["object"]));
  if (n.nodeClass === "Variable") {
    const b = builtin(n.dataType);
    if (n.refs.some((r) => isPropRef(r.type, r.typeDefinition))) check("variable.properties", "Variable's Properties (EngineeringUnits, EURange, …) moved to metadata: noted", n.id, noted(o, ["variableProperties"], ["object", "type"]));
    if (n.refs.some((r) => r.nodeClass === "Variable" && isA(r.type, R.Hier) && !isPropRef(r.type, r.typeDefinition) && !refNames.get(r.type)?.symmetric))
      check("variable.complex", "DataVariable with DataVariable children (value and components both): noted", n.id, noted(o, ["complexVariable"], ["object"]));
    if (n.valueRank === -2 || n.valueRank === -3) check("value.valueRank", "ValueRank Any/ScalarOrOneDimension projected as scalar: noted", n.id, noted(o, ["valueRank"], ["object", "type"]));
    if (b === "i=8" || b === "i=9") check("value.int64", "Int64/UInt64 encoding (JSON precision): noted", n.id, noted(o, ["int64"]));
    if (b === "i=21") check("value.localizedText", "LocalizedText value → text only: noted", n.id, noted(o, ["localizedText"]));
    if (b === "i=10" || b === "i=11") check("value.nonFinite", "Float/Double NaN/±Inf → null: noted", n.id, noted(o, ["nonFinite"]));
    if (isA(n.dataType, R.Structure) && n.accessLevel && n.accessLevel & 2) check("write.structure", "Writable Structure value (not writable via i3X): noted", n.id, noted(o, ["write"]));
    check("value.timestamps", "Source/Server timestamp → one i3X timestamp: noted", n.id, noted(o, ["timestamps"]));
    check("value.quality", "StatusCode → quality string: noted", n.id, noted(o, ["quality"]));
    if (n.historizing) check("history.historizing", "Historizing → metadata.opcua.historizing", n.id, o.metadata?.opcua?.historizing === true ? "metadata" : null);
    if (n.accessLevel !== undefined) check("access.writable", "Writability → metadata.opcua.writable", n.id, o.metadata?.opcua?.writable === ((n.accessLevel & 2) !== 0) ? "metadata" : null);
  }
  // every non-plumbing reference to another model node is an i3X edge (or a described omission)
  const targets = relTargets(o);
  for (const r of n.refs) {
    const t = nodes.get(r.target);
    if (r.type === R.HasModellingRule || r.nodeClass === "Method" || isPropRef(r.type, r.typeDefinition)) continue;
    const rn = refNames.get(r.type)?.name ?? r.type;
    if (r.type === R.HasInterface) { check("ref.HasInterface", "HasInterface → metadata.opcua.interfaces", n.id, (o.metadata?.opcua?.interfaces ?? []).length ? "metadata" : null); continue; }
    if (t && t.role === "candidate" && objects.has(r.target)) {
      check(`ref.${rn}`, `${rn} between model nodes → i3X edge`, `${n.id} → ${r.target}`, targets.has(r.target) ? "object" : noted(o, ["references"], ["namespace"], rn));
    } else if (!t || t.role !== "candidate") {
      // target outside the projected model (dictionary entries, historian configuration, types, …)
      const listed = rn === "HasDictionaryEntry" ? (o.metadata?.opcua?.dictionaryEntries ?? []).includes(r.target) : false;
      check(`ref.${rn}(external)`, `${rn} to a node outside the model → listed in metadata or noted`, `${n.id} → ${r.target}`, listed ? "metadata" : noted(o, ["references", "notProjected"], ["object", "namespace"], rn));
    }
  }
}
// what the walk saw but deliberately did not project
for (const n of nodes.values()) {
  if (n.role === "excluded") check("notProjected.infrastructure", "ns0 infrastructure under Objects (Server, …): noted", n.id, fid(uaNs).some((f) => f.aspect === "notProjected" && f.detail.includes(n.browseName)) ? "namespace" : null);
  if (n.role === "histConfig") check("notProjected.historicalConfiguration", "Historian configuration (HasHistoricalConfiguration): noted", n.id, noted(objects.get(n.parent!), ["references", "notProjected"], ["object", "namespace"], "HasHistoricalConfiguration"));
}

// ---------------- types: re-read each projected OPC UA type's declarations
const typeIds = [...types.values()].filter((t) => /^(i=|nsu=)/.test(t.sourceTypeId)).map((t) => t.sourceTypeId as string);
const decl = await browse([...new Set(typeIds)]);
const memberRules = await (async () => {
  const members = [...decl.values()].flat().filter((r) => r.isForward && isA(key(r.referenceTypeId), R.Hier)).map((r) => key(r.nodeId));
  const mr = await browse([...new Set(members)], BrowseDirection.Forward, R.HasModellingRule);
  return new Map([...mr].map(([id, refs]) => [id, refs[0]?.browseName.name ?? ""]));
})();
for (const t of types.values()) {
  const refs = decl.get(t.sourceTypeId);
  if (!refs) continue;
  const fwd = refs.filter((r) => r.isForward);
  const hier = fwd.filter((r) => isA(key(r.referenceTypeId), R.Hier) && !isA(key(r.referenceTypeId), "i=45"));
  const hit = (aspect: string) => fid(t).some((f) => f.aspect === aspect) ? "type" as Level : null;
  if (hier.some((r) => r.nodeClass === NodeClass.Method)) check("type.methods", "ObjectType declares Methods: noted", t.elementId, hit("methods"));
  if (hier.some((r) => r.nodeClass !== NodeClass.Method && !memberRules.get(key(r.nodeId)))) check("type.typeOnly", "Members without ModellingRule (type-only): noted", t.elementId, hit("typeOnly"));
  if (hier.some((r) => memberRules.get(key(r.nodeId))?.endsWith("Placeholder"))) check("type.placeholders", "Placeholder members (cardinality not in schema): noted", t.elementId, hit("placeholders"));
  if (fwd.some((r) => key(r.referenceTypeId) === R.HasInterface)) check("type.interfaces", "HasInterface merged into the schema: noted", t.elementId, hit("interfaces"));
  if (t.elementId.includes("[")) check("type.synthesizedLeaf", "Leaf type split per concrete DataType: noted", t.elementId, hit("dataType"));
  if (t.metadata?.opcua?.nodeClass === "ObjectType" && Object.keys(t.schema?.properties ?? {}).length) check("type.nullability", "Nullable-by-default properties: noted", t.elementId, hit("nullability"));
}
for (const r of rels.values()) {
  const role = r.metadata?.opcua?.role;
  if (role === "multiPath" || role === "synthesized") check(`relationshipType.${role}`, `${role} relationship type: noted`, r.elementId, fid(r).length ? "relationshipType" : null);
  const src = r.metadata?.opcua?.referenceType;
  if (src && refNames.get(src)?.symmetric && isA(src, R.Hier)) check("relationshipType.symmetricHierarchical", "Symmetric hierarchical reference as graph edge: noted", r.elementId, fid(r).some((f) => f.aspect === "semantics") ? "relationshipType" : null);
}
for (const n of namespaces.values()) if (n.uri.endsWith("?projection=i3X")) check("namespace.projection", "Inexact projection namespace carries fidelity notes", n.uri, fid(n).length ? "namespace" : null);

await session.close(); await client.disconnect();

// ------------------------------------------------------------------ report
const rows = [...results.values()].sort((a, b) => a.rule.localeCompare(b.rule));
const gapCount = rows.reduce((a, r) => a + r.gaps.length, 0);
console.log(`fidelity audit · OPC UA ${UA} (${model.length} model nodes) · i3X ${I3X} (${objects.size} objects, ${types.size} types, ${rels.size} relationship types)\n`);
const w = Math.max(...rows.map((r) => r.rule.length));
for (const r of rows) {
  const cov = Object.entries(r.covered).map(([k, v]) => `${k} ${v}`).join(", ");
  console.log(`${r.gaps.length ? "✗" : "✓"} ${r.rule.padEnd(w)} ${String(r.occurrences).padStart(5)}  ${r.gaps.length ? `${r.gaps.length} NOT DESCRIBED` : `described: ${cov}`}`);
  for (const g of r.gaps.slice(0, SHOW)) console.log(`    ${g}`);
  if (r.gaps.length > SHOW) console.log(`    … ${r.gaps.length - SHOW} more`);
}
console.log(`\n${rows.length} rules, ${rows.reduce((a, r) => a + r.occurrences, 0)} checks, ${gapCount} gaps`);
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify(rows, null, 2));
process.exit(gapCount ? 1 : 0);
