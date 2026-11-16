/**
 * Project a crawled OPC UA model (ua/crawl.ts) onto the i3X 1.0 address space.
 * The rules are docs/gateway/MAPPING.md; section numbers in comments refer to it.
 */
import { AttributeIds } from "node-opcua";
import type { Interpretation } from "../config.js";
import { ID, type Crawler, type UaModel, type UNode, type UType } from "../ua/crawl.js";
import { SchemaMapper, type JsonSchema } from "./schema.js";
import { synthesizeFlow } from "../profiles/ports.js";

export const I3X_NS = "https://cesmii.org/i3x";
export const GW_NS = "https://cesmii.net/i3x-demo/opcua-gateway/";
export const UNKNOWN_TYPE = "gateway:UnknownType";

export type Loss = "dropped" | "flattened" | "approximated" | "renamed" | "synthesized" | "multiPath" | "typeChanged";
export interface Fidelity { aspect: string; loss: Loss; detail: string }

export interface I3xNamespace { uri: string; displayName: string; metadata: Record<string, unknown> }
export interface I3xObjectType { elementId: string; displayName: string; namespaceUri: string; sourceTypeId: string; version?: string; schema: JsonSchema; related?: Record<string, unknown>; metadata: Record<string, unknown> }
export interface I3xRelType { elementId: string; displayName: string; namespaceUri: string; relationshipId: string; reverseOf: string; metadata: Record<string, unknown> }
export interface I3xObject {
  elementId: string; displayName: string; typeElementId: string; parentId: string | null; isComposition: boolean; isExtended: boolean;
  metadata: Record<string, unknown>;
}
/** How to read an i3X Object's value from OPC UA (Phase 5). */
export interface ValueSource { kind: "leaf" | "branch"; node: string; dataType?: string; valueRank?: number; props: Array<{ key: string; node: string; dataType?: string; valueRank?: number }> }

type Cat = "property" | "composition" | "hierarchy" | "graph" | "plumbing";
/** Pseudo reference type for parents synthesized by the singleRoot switch (no OPC UA reference exists). */
const SINGLE_ROOT_REF = "gateway:singleRoot";

export class Projection {
  readonly namespaces = new Map<string, I3xNamespace>();
  readonly objectTypes = new Map<string, I3xObjectType>();
  readonly relTypes = new Map<string, I3xRelType>();
  readonly objects = new Map<string, I3xObject>();
  readonly edges = new Map<string, Array<{ rel: string; target: string }>>();
  readonly values = new Map<string, ValueSource>();
  readonly children = new Map<string, string[]>();        // composition children per Object (for maxDepth)
  readonly stats: Record<string, number> = {};
  private readonly s: SchemaMapper;
  private readonly cat = new Map<string, Cat>();
  private readonly shortNs = new Map<string, string>();
  private readonly propValues = new Map<string, unknown>();
  private readonly isProp = new Set<string>();
  private singleRootDetached: string | null | undefined;

  constructor(private readonly m: UaModel, private readonly c: Crawler, private readonly p: Interpretation) {
    this.s = new SchemaMapper(m, p);
  }

  // ---------- naming ----------
  private nsShort(uri: string): string {
    if (this.shortNs.has(uri)) return this.shortNs.get(uri)!;
    if (uri === "http://opcfoundation.org/UA/") return "UA";
    const seg = uri.replace(/[?#].*$/, "").split(/[/:]/).filter(Boolean).pop() ?? uri;
    const taken = [...this.shortNs.values()].includes(seg) || seg === "UA" || seg === "gateway" || seg === "i3x";
    const name = taken ? uri : seg;
    this.shortNs.set(uri, name);
    return name;
  }
  private projectedNs(uri: string) { return `${uri}?projection=i3X`; }
  typeId(id: string): string {
    if (id === SINGLE_ROOT_REF) return id;
    const t = this.m.types.get(id) ?? this.m.refTypes.get(id);
    if (!t || this.p.typeIds === "nsu") return id;
    return `${this.nsShort(t.browseName.ns)}:${t.browseName.name}`;
  }
  private qname(q: { ns: string; name: string }) { return q.ns === "http://opcfoundation.org/UA/" ? q.name : `${this.nsShort(q.ns)}:${q.name}`; }

  // ---------- §4 reference classification ----------
  private category(rt: string): Cat {
    if (rt === SINGLE_ROOT_REF) return "hierarchy";
    if (this.cat.has(rt)) return this.cat.get(rt)!;
    const sub = (a: string) => this.c.isSubtype(rt, a, "ref");
    const r = this.m.refTypes.get(rt);
    let k: Cat;
    if ([ID.HasTypeDefinition, ID.HasModellingRule, ID.HasSubtype, ID.HasEncoding, ID.HasDescription, ID.HasInterface, ID.HasDictionaryEntry].includes(rt as never)
      || sub(ID.GeneratesEvent) || sub(ID.HasEventSource) || sub(ID.HasHistoricalConfiguration)) k = "plumbing";
    else if (sub(ID.HasProperty)) k = "property";
    else if (sub(ID.HasComponent)) k = "composition";
    else if (sub(ID.HierarchicalReferences) && !r?.symmetric) k = "hierarchy";
    else k = "graph";
    this.cat.set(rt, k);
    return k;
  }
  /** A type member that projects as an attribute: HasProperty, or a PropertyType variable under a HasComponent subtype (§1). */
  private isPropMember(m: { nodeClass: string; refType: string; typeDefinition?: string }) {
    return m.nodeClass === "Variable" && (this.category(m.refType) === "property" || (this.category(m.refType) === "composition" && m.typeDefinition === ID.PropertyType));
  }
  private isFolder(n: UNode | undefined) { return !!n?.typeDefinition && this.c.isSubtype(n.typeDefinition, ID.FolderType, "type"); }

  // ---------- build ----------
  async build() {
    const nodes = this.m.nodes;
    // incoming references and Property detection
    const incoming = new Map<string, Array<{ from: string; type: string }>>();
    for (const n of nodes.values()) for (const r of n.refs) {
      if (!nodes.has(r.target)) continue;
      (incoming.get(r.target) ?? incoming.set(r.target, []).get(r.target)!).push({ from: n.id, type: r.type });
      // §1: a Variable is an attribute if it is a HasProperty target OR typed PropertyType (ISA-95 attaches PropertyType variables with a HasComponent subtype)
      if (this.category(r.type) === "property" || (this.category(r.type) === "composition" && nodes.get(r.target)?.typeDefinition === ID.PropertyType)) this.isProp.add(r.target);
    }
    await this.readPropertyValues();

    // §1 the Object set
    const inSet = (n: UNode) => n.id !== ID.Objects && (n.nodeClass === "Object" || (n.nodeClass === "Variable" && !this.isProp.has(n.id)));
    const set = [...nodes.values()].filter(inSet);
    const setIds = new Set(set.map((n) => n.id));

    // §4 one parent per Object
    const parentOf = new Map<string, { from: string; type: string } | null>();
    for (const n of set) {
      const cands = (incoming.get(n.id) ?? []).filter((x) => (setIds.has(x.from) || x.from === ID.Objects) && ["composition", "hierarchy"].includes(this.category(x.type)));
      cands.sort((a, b) => {
        const ca = this.category(a.type) === "composition" ? 0 : 1, cb = this.category(b.type) === "composition" ? 0 : 1;
        if (ca !== cb) return ca - cb;
        const fa = a.from === ID.Objects ? 2 : this.isFolder(nodes.get(a.from)) ? 1 : 0, fb = b.from === ID.Objects ? 2 : this.isFolder(nodes.get(b.from)) ? 1 : 0;
        if (fa !== fb) return fa - fb;
        const da = nodes.get(a.from)!.depth, db = nodes.get(b.from)!.depth;
        if (da !== db) return da - db;
        return a.from < b.from ? -1 : a.from > b.from ? 1 : 0;
      });
      parentOf.set(n.id, cands[0] ?? null);
    }

    // [switch singleRoot] one Object becomes the only root; every other top-level Object is re-parented under it
    const single = this.p.singleRoot && setIds.has(this.p.singleRoot) ? this.p.singleRoot : undefined;
    if (this.p.singleRoot && !single) console.warn(`gateway: singleRoot ${this.p.singleRoot} is not a projected Object; switch ignored`);
    if (single) {
      for (const n of set) {
        const par = parentOf.get(n.id);
        if (n.id !== single && (!par || par.from === ID.Objects)) parentOf.set(n.id, { from: single, type: SINGLE_ROOT_REF });
      }
      if (parentOf.get(single)?.from !== ID.Objects) this.singleRootDetached = parentOf.get(single)?.from ?? null;
      parentOf.set(single, null);
    }

    this.registerCoreTypes();
    // §6 objects
    for (const n of set) this.objects.set(n.id, this.object(n, parentOf.get(n.id) ?? null, incoming.get(n.id) ?? [], setIds));
    // edges: chosen parents, extra paths, graph references
    for (const n of set) {
      const par = parentOf.get(n.id);
      if (par && par.from !== ID.Objects) {
        if (this.category(par.type) === "composition") {
          this.edge(par.from, "HasComponent", n.id); this.edge(n.id, "ComponentOf", par.from);
          (this.children.get(par.from) ?? this.children.set(par.from, []).get(par.from)!).push(n.id);
        }
        this.edge(par.from, "HasChildren", n.id); this.edge(n.id, "HasParent", par.from);
      }
      for (const r of n.refs) {
        if (!setIds.has(r.target)) continue;
        const k = this.category(r.type);
        if (k === "plumbing" || k === "property") continue;
        const chosen = parentOf.get(r.target);
        if ((k === "composition" || k === "hierarchy") && chosen && chosen.from === n.id && chosen.type === r.type) continue;
        this.graphEdge(n.id, r.type, r.target, k === "graph" ? "graph" : "multiPath");
      }
    }
    for (const id of this.children.keys()) {
      const o = this.objects.get(id)!;
      o.isComposition = true;
      if (nodes.get(id)?.nodeClass === "Variable") (o.metadata.opcua as { fidelity: Fidelity[] }).fidelity.push({ aspect: "complexVariable", loss: "approximated",
        detail: "OPC UA complex Variable: it has a Value of its own and DataVariable children. i3X shows the Value as this leaf's value and the children as components; with maxDepth > 1 both are returned, so the value is not composed only of its components." });
    }
    if (this.p.synthesizeFlow) await synthesizeFlow(this, this.m, this.c);
    for (const [id, o] of this.objects) o.metadata.relationships = this.relationshipsOf(id);
    this.registerNamespaces();
    this.stats.objects = this.objects.size;
    this.stats.objectTypes = this.objectTypes.size;
    this.stats.relationshipTypes = this.relTypes.size;
    this.stats.edges = [...this.edges.values()].reduce((a, e) => a + e.length, 0);
    return this;
  }

  private async readPropertyValues() {
    const ids = [...this.isProp];
    const vals = await this.c.readValues(ids);
    ids.forEach((id, i) => this.propValues.set(id, vals[i].value?.value ?? null));
  }

  // ---------- edges & relationship types ----------
  edge(from: string, rel: string, to: string) {
    const list = this.edges.get(from) ?? this.edges.set(from, []).get(from)!;
    if (!list.some((e) => e.rel === rel && e.target === to)) list.push({ rel, target: to });
  }
  private graphEdge(from: string, rt: string, to: string, role: "graph" | "multiPath") {
    const r = this.m.refTypes.get(rt)!;
    const fwd = this.typeId(rt);
    const inv = r.symmetric ? fwd : this.qnameStr(r.browseName.ns, r.inverseName ?? `${r.browseName.name}Inverse`);
    this.registerRel(fwd, inv, r.browseName.ns, rt, role);
    if (!r.symmetric) this.registerRel(inv, fwd, r.browseName.ns, rt, role, true);
    this.edge(from, fwd, to);
    this.edge(to, inv, from);
  }
  private qnameStr(ns: string, name: string) { return this.p.typeIds === "nsu" ? `${ns}#${name}` : `${this.nsShort(ns)}:${name}`; }
  registerRel(elementId: string, reverseOf: string, nsUri: string, source: string | null, role: string, inverse = false, extra: Record<string, unknown> = {}) {
    if (this.relTypes.has(elementId)) return;
    const r = source ? this.m.refTypes.get(source) : undefined;
    const chain: string[] = [];
    for (let t = source ?? undefined, g = 0; t && g < 32; t = this.m.refTypes.get(t)?.supertype, g++) chain.push(this.m.refTypes.get(t)?.browseName.name ?? t);
    const fidelity: Fidelity[] = [];
    if (role === "multiPath") fidelity.push({ aspect: "hierarchy", loss: "multiPath", detail: "OPC UA reaches the target by more than one hierarchical path; i3X allows one parent, so this non-chosen path is kept as a graph relationship." });
    if (source && this.category(source) === "hierarchy" && r?.symmetric === false && role === "graph") fidelity.push({ aspect: "semantics", loss: "approximated", detail: "Hierarchical in OPC UA but projected as a graph relationship." });
    if (r?.symmetric && this.c.isSubtype(source!, ID.HierarchicalReferences, "ref")) fidelity.push({ aspect: "semantics", loss: "approximated", detail: "Symmetric HierarchicalReference (topology, not containment): projected as a graph relationship, not as parent/child." });
    const ns = source ? this.projectedNs(nsUri) : nsUri;
    this.relTypes.set(elementId, {
      elementId, displayName: elementId.replace(/^[^:]*:/, ""), namespaceUri: ns, relationshipId: source ?? elementId, reverseOf,
      metadata: {
        description: source ? `${inverse ? "Inverse of" : "Projection of"} OPC UA ReferenceType ${r?.browseName.name}` : undefined,
        opcua: source ? { referenceType: source, browseName: r?.browseName.name, inverseName: r?.inverseName, symmetric: r?.symmetric, isAbstract: r?.isAbstract,
          supertypes: chain.slice(1), direction: inverse ? "inverse" : "forward", role, fidelity } : { role, fidelity },
        ...extra,
      },
    });
  }
  private registerCoreTypes() {
    const core = (id: string, rev: string, d: string) => this.registerRel(id, rev, I3X_NS, null, "core", false, { description: d });
    core("HasParent", "HasChildren", "i3X hierarchy: the Object's single parent (from the chosen OPC UA hierarchical or composition reference)");
    core("HasChildren", "HasParent", "i3X hierarchy");
    core("HasComponent", "ComponentOf", "i3X composition: projected from OPC UA HasComponent and its subtypes (HasAddIn, HasOrderedComponent, …)");
    core("ComponentOf", "HasComponent", "i3X composition");
    const gw = (id: string, rev: string, d: string) => this.registerRel(id, rev, GW_NS, null, "gateway", false, { description: d });
    gw("InheritsFrom", "InheritedBy", "ObjectType inheritance (OPC UA HasSubtype). Registered because the IG requires a reverse for every relationship type; it has no standard reverse name (discrepancy #15).");
    gw("InheritedBy", "InheritsFrom", "Inverse of InheritsFrom");
    this.objectTypes.set(UNKNOWN_TYPE, { elementId: UNKNOWN_TYPE, displayName: "UnknownType", namespaceUri: GW_NS, sourceTypeId: UNKNOWN_TYPE, schema: { type: "object" },
      metadata: { description: "Placeholder for Objects whose OPC UA TypeDefinition could not be read (IG: UnknownType)." } });
  }
  relationshipsOf(id: string) {
    const out: Record<string, string[] | string> = {};
    for (const e of this.edges.get(id) ?? []) ((out[e.rel] as string[]) ??= []).push(e.target);
    if (this.p.relationshipsShape === "mixed") for (const k of Object.keys(out)) if ((out[k] as string[]).length === 1) out[k] = (out[k] as string[])[0];
    return out;
  }

  // ---------- §5 types ----------
  private objectType(id: string): string {
    const eid = this.typeId(id);
    if (this.objectTypes.has(eid)) return eid;
    const t = this.m.types.get(id);
    if (!t) return UNKNOWN_TYPE;
    const placeholder: I3xObjectType = { elementId: eid, displayName: t.displayName || t.browseName.name, namespaceUri: this.projectedNs(t.browseName.ns), sourceTypeId: id, schema: {}, metadata: {} };
    this.objectTypes.set(eid, placeholder);   // set first: recursion through supertypes / interfaces
    const superId = t.supertype && this.m.types.has(t.supertype) ? this.objectType(t.supertype) : undefined;
    const props = this.collectProps(t);
    const own = this.p.schemaInheritance === "allOf" ? this.ownProps(t) : props;
    const body: JsonSchema = { type: "object", properties: Object.fromEntries(own.map((x) => [x.key, x.schema])), required: own.filter((x) => x.required).map((x) => x.key) };
    const schema = this.p.schemaInheritance === "allOf" && superId ? { allOf: [{ $ref: superId }, body] } : body;
    const isInterface = this.c.isSubtype(id, ID.BaseInterfaceType, "type");
    const members = t.members;
    const fidelity: Fidelity[] = [];
    const methods = members.filter((m) => m.nodeClass === "Method").map((m) => this.qname(m.browseName));
    if (methods.length) fidelity.push({ aspect: "methods", loss: "dropped", detail: `i3X 1.0 has no method call: ${methods.join(", ")}` });
    const typeOnly = members.filter((m) => !m.modellingRule && m.nodeClass !== "Method").map((m) => this.qname(m.browseName));
    if (typeOnly.length) fidelity.push({ aspect: "typeOnly", loss: "dropped", detail: `Members without a ModellingRule exist only on the type (e.g. state machine States/Transitions): ${typeOnly.slice(0, 8).join(", ")}${typeOnly.length > 8 ? ", …" : ""}` });
    if (t.interfaces.length) fidelity.push({ aspect: "interfaces", loss: "flattened", detail: `Interface members merged into this type: ${t.interfaces.map((i) => this.typeId(i)).join(", ")}` });
    const placeholders = members.filter((m) => m.modellingRule?.endsWith("Placeholder"));
    if (placeholders.length) fidelity.push({ aspect: "placeholders", loss: "approximated", detail: `Placeholders become a variable set of child Objects; the cardinality rule is not in the schema: ${placeholders.map((m) => this.qname(m.browseName)).join(", ")}` });
    fidelity.push({ aspect: "nullability", loss: "approximated", detail: "OPC UA has no non-null constraint; every property is declared nullable and Mandatory maps to `required`." });
    Object.assign(placeholder, {
      version: this.m.namespaceInfo.get(t.browseName.ns)?.version,
      schema,
      ...(superId ? { related: { relationshipType: "InheritsFrom", types: [superId] } } : {}),
      metadata: {
        description: t.description,
        opcua: {
          nodeId: id, browseName: this.qname(t.browseName), nodeClass: t.nodeClass, isAbstract: t.isAbstract, isInterface, namespaceUri: t.browseName.ns,
          interfaces: t.interfaces.map((i) => this.typeId(i)),
          components: members.filter((m) => m.modellingRule && m.nodeClass !== "Method" && !this.isPropMember(m)).map((m) => ({
            browseName: this.qname(m.browseName), nodeClass: m.nodeClass, reference: this.typeId(m.refType), modellingRule: m.modellingRule,
            typeDefinition: m.typeDefinition ? this.typeId(m.typeDefinition) : undefined, ...(m.dataType ? { dataType: this.s.name(m.dataType) } : {}),
          })),
          methods, typeOnly, fidelity,
        },
      },
    });
    for (const i of t.interfaces) this.objectType(i);
    return eid;
  }
  /** Property declarations of a type, its supertypes and interfaces (most-derived wins). */
  private collectProps(t: UType) {
    const seen = new Map<string, { key: string; schema: JsonSchema; required: boolean }>();
    const visit = (tt: UType | undefined, guard = 0) => {
      if (!tt || guard > 32) return;
      for (const p of this.ownProps(tt)) if (!seen.has(p.key)) seen.set(p.key, p);
      for (const i of tt.interfaces) visit(this.m.types.get(i), guard + 1);
      visit(tt.supertype ? this.m.types.get(tt.supertype) : undefined, guard + 1);
    };
    visit(t);
    return [...seen.values()];
  }
  private ownProps(t: UType) {
    return t.members.filter((m) => m.nodeClass === "Variable" && m.modellingRule && this.isPropMember(m))
      .map((m) => ({ key: m.browseName.name, schema: { ...this.s.nullable(this.s.forType(m.dataType, m.valueRank ?? -1)), ...(m.description ? { description: m.description } : {}) }, required: m.modellingRule === "Mandatory" }));
  }
  /** Leaf type for a DataVariable: its VariableType, split by concrete DataType when the VariableType's is abstract or different. */
  private leafType(n: UNode): string {
    const vtId = n.typeDefinition;
    const vt = vtId ? this.m.types.get(vtId) : undefined;
    if (!vt) return UNKNOWN_TYPE;
    const base = this.typeId(vtId!);
    // ValueRank Any (-2) / ScalarOrOneDimension (-3) on a leaf: treated as scalar so clients see a leaf point (fidelity note below)
    const vr = n.valueRank === -2 || n.valueRank === -3 ? -1 : n.valueRank ?? -1;
    const exact = vt.dataType === n.dataType && (vt.valueRank ?? -1) === vr;
    const eid = exact ? base : `${base}[${this.s.name(n.dataType)}${vr >= 1 ? "[]" : ""}]`;
    if (this.objectTypes.has(eid)) return eid;
    const props = vt.members.filter((m) => this.isPropMember(m) && m.modellingRule).map((m) => ({ browseName: this.qname(m.browseName), modellingRule: m.modellingRule, dataType: this.s.name(m.dataType) }));
    const fidelity: Fidelity[] = [];
    if (!exact) fidelity.push({ aspect: "dataType", loss: "synthesized", detail: `One i3X leaf type per concrete DataType: OPC UA VariableType ${vt.browseName.name} declares ${this.s.name(vt.dataType)} (ValueRank ${vt.valueRank ?? -1}); this projection is for ${this.s.name(n.dataType)} (ValueRank ${n.valueRank ?? -1}).` });
    if (vr !== (n.valueRank ?? -1)) fidelity.push({ aspect: "valueRank", loss: "approximated", detail: `OPC UA ValueRank ${n.valueRank} (scalar or array) is projected as a scalar leaf.` });
    const b = this.s.builtin(n.dataType);
    if (b === "i=8" || b === "i=9") fidelity.push(this.int64Note());
    if (props.length) fidelity.push({ aspect: "variableProperties", loss: "flattened", detail: `Properties of the variable (${props.map((p) => p.browseName).join(", ")}) are not part of the leaf value; they appear in each Object's metadata.opcua.properties.` });
    const superId = vt.supertype && this.m.types.has(vt.supertype) ? this.typeId(vt.supertype) : undefined;
    this.objectTypes.set(eid, {
      elementId: eid, displayName: exact ? vt.displayName || vt.browseName.name : `${vt.displayName || vt.browseName.name} [${this.s.name(n.dataType)}]`,
      namespaceUri: this.projectedNs(vt.browseName.ns), sourceTypeId: vtId!, version: this.m.namespaceInfo.get(vt.browseName.ns)?.version,
      schema: this.s.forType(n.dataType, vr),
      ...(superId ? { related: { relationshipType: "InheritsFrom", types: [superId] } } : {}),
      metadata: { description: vt.description, opcua: { nodeId: vtId, browseName: this.qname(vt.browseName), nodeClass: "VariableType", isAbstract: vt.isAbstract,
        namespaceUri: vt.browseName.ns, dataType: this.s.name(n.dataType), valueRank: n.valueRank, declaredProperties: props, fidelity } },
    });
    return eid;
  }

  /** [switch singleRoot] the gateway ObjectType the single root is re-typed to: same schema as its OPC UA type, gateway namespace. */
  private singleRootType(opcType: string): string {
    const eid = `gateway:${this.p.singleRootType}`;
    if (this.objectTypes.has(eid)) return eid;
    const src = this.objectTypes.get(opcType);
    this.objectTypes.set(eid, {
      elementId: eid, displayName: this.p.singleRootType, namespaceUri: GW_NS, sourceTypeId: src?.sourceTypeId ?? opcType, schema: src?.schema ?? { type: "object" },
      metadata: { description: `The single root of this i3X address space (gateway switch singleRoot). Not an OPC UA type: the root Object's OPC UA TypeDefinition is ${opcType}, whose schema this type reuses.`,
        opcua: { projectedFrom: opcType, fidelity: [
          { aspect: "type", loss: "synthesized", detail: `Defined by the gateway's singleRoot switch; the source Object's OPC UA type is ${opcType}.` },
          // it reuses that type's schema, so that type's own losses apply here too
          ...(((src?.metadata.opcua as { fidelity?: Fidelity[] } | undefined)?.fidelity) ?? []),
        ] } },
    });
    return eid;
  }

  // ---------- §6 objects ----------
  private object(n: UNode, par: { from: string; type: string } | null, inc: Array<{ from: string; type: string }>, setIds: Set<string>): I3xObject {
    const isLeaf = n.nodeClass === "Variable";
    const opcType = isLeaf ? this.leafType(n) : n.typeDefinition ? this.objectType(n.typeDefinition) : UNKNOWN_TYPE;
    const isSingleRoot = !!this.p.singleRoot && n.id === this.p.singleRoot && !par;
    const typeElementId = isSingleRoot ? this.singleRootType(opcType) : opcType;
    const t = n.typeDefinition ? this.m.types.get(n.typeDefinition) : undefined;
    const props = n.refs.filter((r) => this.isProp.has(r.target) && this.m.nodes.has(r.target)).map((r) => this.m.nodes.get(r.target)!);
    const fidelity: Fidelity[] = [];
    const others = inc.filter((x) => setIds.has(x.from) && x !== par && ["composition", "hierarchy"].includes(this.category(x.type)))
      .map((x) => ({ elementId: x.from, reference: this.typeId(x.type) }));
    if (others.length) fidelity.push({ aspect: "parent", loss: "multiPath", detail: `Also reached from ${others.map((o) => `${this.m.nodes.get(o.elementId)?.displayName} (${o.reference})`).join(", ")}; kept as graph relationships. parentId follows ${par ? this.typeId(par.type) : "—"} from ${par ? this.m.nodes.get(par.from)?.displayName : "Objects"}.` });
    if (t && this.c.isSubtype(t.id, ID.BaseInterfaceType, "type")) fidelity.push({ aspect: "typeDefinition", loss: "approximated", detail: `TypeDefinition ${t.browseName.name} is an OPC UA Interface (abstract); Interfaces are normally applied with HasInterface, not used as a TypeDefinition.` });
    const methods = n.refs.map((r) => this.m.nodes.get(r.target)).filter((x) => x?.nodeClass === "Method").map((x) => this.qname(x!.browseName));
    if (methods.length) fidelity.push({ aspect: "methods", loss: "dropped", detail: `Not callable through i3X 1.0: ${methods.join(", ")}` });
    if (n.eventNotifier) fidelity.push({ aspect: "events", loss: "dropped", detail: `OPC UA EventNotifier (${[n.eventNotifier & 1 && "SubscribeToEvents", n.eventNotifier & 4 && "HistoryRead", n.eventNotifier & 8 && "HistoryWrite"].filter(Boolean).join(", ")}): events from this Object and its sources are not projected (i3X 1.0 has no event model).` });
    if (par?.type === SINGLE_ROOT_REF) fidelity.push({ aspect: "parent", loss: "synthesized", detail: `Top-level in OPC UA (a child of Objects). Placed under ${this.m.nodes.get(par.from)?.displayName} by the gateway's singleRoot switch, so the i3X address space has one root; no OPC UA reference connects them.` });
    if (isSingleRoot) {
      fidelity.push({ aspect: "typeDefinition", loss: "typeChanged", detail: `Presented as ${typeElementId} (singleRoot switch), the one root containing every other top-level Object. Its OPC UA TypeDefinition is ${opcType}; its value is still that type's Properties.` });
      if (this.singleRootDetached) fidelity.push({ aspect: "parent", loss: "dropped", detail: `Its OPC UA parent ${this.m.nodes.get(this.singleRootDetached)?.displayName} is not shown as an i3X parent: a root has none.` });
    }
    if (n.locale) fidelity.push({ aspect: "displayName", loss: "dropped", detail: `DisplayName locale "${n.locale}" not carried by i3X displayName.` });

    // value source + extension check (§6)
    let isExtended = false;
    const schemaExtensions: Record<string, JsonSchema> = {};
    let opcProps: Record<string, unknown> | undefined;
    if (isLeaf && (n.valueRank === -2 || n.valueRank === -3)) fidelity.push({ aspect: "valueRank", loss: "approximated", detail: `OPC UA ValueRank ${n.valueRank} (${n.valueRank === -2 ? "Any" : "ScalarOrOneDimension"}) is projected as a scalar leaf; an array value would not match the schema.` });
    const dictionaryEntries = n.refs.filter((r) => r.type === ID.HasDictionaryEntry).map((r) => r.target);
    if (isLeaf) {
      this.values.set(n.id, { kind: "leaf", node: n.id, dataType: n.dataType, valueRank: n.valueRank, props: [] });
      if (props.length) {
        opcProps = Object.fromEntries(props.map((p) => [p.browseName.name, this.friendly(this.propValues.get(p.id), p.dataType)]));
        fidelity.push({ aspect: "variableProperties", loss: "flattened", detail: `${props.map((p) => p.browseName.name).join(", ")} moved to metadata.opcua.properties (the leaf value is the bare Variable value).` });
      }
    } else {
      const declared = new Set(t ? this.collectProps(t).map((x) => x.key) : []);
      for (const p of props) if (!declared.has(p.browseName.name)) { isExtended = true; schemaExtensions[p.browseName.name] = this.s.nullable(this.s.forType(p.dataType, p.valueRank ?? -1)); }
      this.values.set(n.id, { kind: "branch", node: n.id, props: props.map((p) => ({ key: p.browseName.name, node: p.id, dataType: p.dataType, valueRank: p.valueRank })) });
    }
    const ifaces = n.refs.filter((r) => r.type === ID.HasInterface).map((r) => this.objectType(r.target));
    const tid = isLeaf ? n.typeDefinition : n.typeDefinition;
    const tdef = tid ? this.m.types.get(tid) : undefined;
    return {
      elementId: n.id, displayName: n.displayName, typeElementId,
      parentId: par && par.from !== ID.Objects ? par.from : null,
      isComposition: false, isExtended,
      metadata: {
        ...(n.description ? { description: n.description } : {}),
        typeNamespaceUri: this.objectTypes.get(typeElementId)?.namespaceUri ?? GW_NS,
        sourceTypeId: tid ?? UNKNOWN_TYPE,
        ...(isExtended ? { schemaExtensions } : {}),
        system: { nodeId: n.id, nodeClass: n.nodeClass, browseName: this.qname(n.browseName) },
        opcua: {
          nodeId: n.id, browseName: this.qname(n.browseName), nodeClass: n.nodeClass, namespaceUri: n.browseName.ns,
          typeDefinition: tid, ...(tdef ? { typeBrowseName: this.qname(tdef.browseName) } : {}),
          ...(isLeaf ? { dataType: this.s.name(n.dataType), valueRank: n.valueRank, writable: ((n.accessLevel ?? 0) & 2) !== 0, historizing: n.historizing === true } : {}),
          ...(!isLeaf && props.some((p) => ((p.accessLevel ?? 0) & 2) !== 0) ? { writableProperties: props.filter((p) => ((p.accessLevel ?? 0) & 2) !== 0).map((p) => p.browseName.name) } : {}),
          parentReference: par ? (par.from === ID.Objects ? "Organizes (from Objects: root)" : par.type === SINGLE_ROOT_REF ? "none (synthesized by singleRoot switch; top-level in OPC UA)" : this.typeId(par.type)) : isSingleRoot ? "Organizes (from Objects: root; singleRoot switch)" : undefined,
          otherParents: others.length ? others : undefined,
          ...(opcProps ? { properties: opcProps } : {}),
          ...(ifaces.length ? { interfaces: ifaces } : {}),
          ...(methods.length ? { methods } : {}),
          ...(dictionaryEntries.length ? { dictionaryEntries } : {}),
          fidelity,
        },
      },
    };
  }

  /** Static property values for metadata: EUInformation / Range / LocalizedText in readable form. */
  friendly(v: unknown, dataType?: string): unknown {
    if (v === null || v === undefined) return null;
    if (typeof v === "object" && v !== null && "unitId" in v) {
      const u = v as { unitId: number; displayName?: { text?: string }; description?: { text?: string } };
      const code = u.unitId > 0 ? String.fromCharCode(...[u.unitId >> 16, (u.unitId >> 8) & 0xff, u.unitId & 0xff].filter((c) => c > 0)) : undefined;
      return { code, symbol: u.displayName?.text, name: u.description?.text };
    }
    if (typeof v === "object" && v !== null && "low" in v && "high" in v) return { low: (v as any).low, high: (v as any).high };
    if (typeof v === "object" && v !== null && "text" in v) return (v as any).text ?? null;
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v) || ArrayBuffer.isView(v)) return Array.from(v as ArrayLike<unknown>).map((x) => this.friendly(x));
    if (typeof v === "object" && "toString" in v && (v as any).constructor?.name?.includes("NodeId")) return this.c.key(v as any);
    void dataType;
    return v;
  }

  private int64Note(): Fidelity {
    return this.p.int64 === "string"
      ? { aspect: "int64", loss: "typeChanged", detail: "Int64/UInt64 are encoded as decimal strings (JSON numbers lose precision above 2^53); switch int64: number." }
      : { aspect: "int64", loss: "approximated", detail: "Int64/UInt64 are encoded as JSON numbers; values above 2^53 lose precision (switch int64: string)." };
  }

  // ---------- §3 namespaces ----------
  private registerNamespaces() {
    const uris = new Set<string>();
    for (const t of this.objectTypes.values()) uris.add(t.namespaceUri);
    for (const r of this.relTypes.values()) uris.add(r.namespaceUri);
    const projectionNotes: Fidelity[] = [
      { aspect: "methods", loss: "dropped", detail: "Methods are not projected (i3X 1.0 has no method call); each Object lists its own in metadata.opcua.methods." },
      { aspect: "events", loss: "dropped", detail: "Events, Alarms & Conditions are not projected (EventNotifier, event types); their Variables are." },
      { aspect: "properties", loss: "flattened", detail: "Properties become attributes of the owning Object's value (or metadata.opcua.properties, for Properties of a Variable)." },
      { aspect: "localizedText", loss: "dropped", detail: "LocalizedText → text only (locale dropped), in values, displayName and description." },
      { aspect: "timestamps", loss: "dropped", detail: "One timestamp per value: the OPC UA SourceTimestamp, else the ServerTimestamp (UTC). The other timestamp and the picoseconds are dropped. A branch Object's timestamp is the newest of its Properties'." },
      { aspect: "quality", loss: "approximated", detail: this.p.quality === "base"
          ? "OPC UA StatusCode → quality reduced to Good / GoodNoData / Bad / Uncertain (switch quality: base); the specific code is dropped. Bad → value null. A branch Object is Uncertain when any of its Properties is not Good (those fields null)."
          : "OPC UA StatusCode → quality = its symbolic name with the severity split off (Good, Bad_NotConnected, Uncertain_LastUsableValue; info bits as e.g. Good_HistorianInterpolated). The numeric code, limit and overflow bits are not carried. Bad → value null. A branch Object is Uncertain when any of its Properties is not Good (those fields null)." },
      { aspect: "nonFinite", loss: "approximated", detail: "Float/Double NaN and ±Infinity have no JSON encoding and are returned as null." },
      this.int64Note(),
      { aspect: "references", loss: "dropped", detail: "ReferenceTypes not projected as relationships: HasTypeDefinition (→ typeElementId), HasModellingRule (→ schema `required`), HasSubtype (→ InheritsFrom on types), HasInterface (→ metadata.opcua.interfaces), HasEncoding, HasDictionaryEntry (→ metadata.opcua.dictionaryEntries), GeneratesEvent, HasEventSource / HasNotifier (event plumbing), HasHistoricalConfiguration (historian configuration Objects are not crawled; metadata.opcua.historizing says whether a Variable is historized)." },
      { aspect: "accessRights", loss: "approximated", detail: "UserAccessLevel is reduced to metadata.opcua.writable / writableProperties and Historizing to metadata.opcua.historizing; the other AccessLevel bits, RolePermissions and UserRolePermissions are not projected." },
    ];
    const infra = this.m.excluded.map((x) => x.browseName);
    const uaOnly: Fidelity[] = [
      { aspect: "notProjected", loss: "dropped", detail: `ns0 infrastructure under Objects is not projected${infra.length ? `: ${infra.join(", ")}` : ""} (switch includeCoreInfrastructure). Views are not projected.` },
    ];
    for (const uri of uris) {
      const raw = uri.replace(/\?projection=i3X$/, "");
      const info = this.m.namespaceInfo.get(raw);
      const ours = uri === I3X_NS || uri === GW_NS;
      this.namespaces.set(uri, {
        uri, displayName: uri === I3X_NS ? "i3X" : uri === GW_NS ? "OPC UA gateway" : this.nsShort(raw),
        metadata: ours ? { description: uri === I3X_NS ? "i3X core relationship types" : "Types and relationship types defined by this gateway (not in any OPC UA NodeSet)" }
          : { description: `i3X projection of OPC UA namespace ${raw}`, opcua: { namespaceUri: raw, version: info?.version, publicationDate: info?.publicationDate, fidelity: raw === "http://opcfoundation.org/UA/" ? [...projectionNotes, ...uaOnly] : projectionNotes } },
      });
    }
  }
}

export async function project(m: UaModel, c: Crawler, p: Interpretation) {
  void AttributeIds;
  return new Projection(m, c, p).build();
}
