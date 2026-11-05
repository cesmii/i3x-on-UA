/**
 * Crawl an OPC UA server into a plain in-memory model, using only Browse and Read.
 * Nothing here knows about the beverage plant (or any companion spec).
 *
 * Ids are strings: "i=85" for namespace 0, "nsu=<uri>;<id>" otherwise (index-free).
 */
import {
  AttributeIds, BrowseDirection, NodeClass, NodeId, type ClientSession, type ReferenceDescription,
  type BrowseDescriptionOptions, type ReadValueIdOptions, type DataValue, type HistoryReadResult, type StatusCode, type Variant,
} from "node-opcua";

export const ID = {
  Objects: "i=85", References: "i=31", HierarchicalReferences: "i=33", NonHierarchicalReferences: "i=32",
  HasChild: "i=34", Aggregates: "i=44", HasComponent: "i=47", HasProperty: "i=46", HasSubtype: "i=45",
  HasTypeDefinition: "i=40", HasModellingRule: "i=37", HasEncoding: "i=38", HasDescription: "i=39",
  GeneratesEvent: "i=41", HasEventSource: "i=36", HasHistoricalConfiguration: "i=56", HasInterface: "i=17603", HasDictionaryEntry: "i=17597",
  BaseObjectType: "i=58", FolderType: "i=61", BaseInterfaceType: "i=17602", BaseVariableType: "i=62",
  BaseDataVariableType: "i=63", PropertyType: "i=68", BaseDataType: "i=24", Structure: "i=22", Enumeration: "i=29",
  NamespacesFolder: "i=11715",
} as const;

export const MODELLING_RULE: Record<string, string> = {
  "i=78": "Mandatory", "i=80": "Optional", "i=11508": "OptionalPlaceholder", "i=11510": "MandatoryPlaceholder", "i=83": "ExposesItsArray",
};

export interface QName { ns: string; name: string }
export interface URef { type: string; target: string }
export interface UNode {
  id: string;
  nodeClass: keyof typeof NodeClass;
  browseName: QName;
  displayName: string;
  locale?: string;
  description?: string;
  typeDefinition?: string;
  dataType?: string;
  valueRank?: number;
  accessLevel?: number;
  depth: number;
  refs: URef[];          // forward references, all types
}
export interface UMember { browseName: QName; nodeClass: keyof typeof NodeClass; refType: string; modellingRule?: string; typeDefinition?: string; dataType?: string; valueRank?: number; description?: string }
export interface UType {
  id: string; nodeClass: "ObjectType" | "VariableType"; browseName: QName; displayName: string; description?: string;
  isAbstract: boolean; supertype?: string; dataType?: string; valueRank?: number;
  members: UMember[]; interfaces: string[];
}
export interface URefType { id: string; browseName: QName; inverseName?: string; symmetric: boolean; isAbstract: boolean; supertype?: string }
export interface UField { name: string; dataType: string; valueRank: number; isOptional: boolean; description?: string }
export interface UDataType {
  id: string; browseName: QName; isAbstract: boolean; supertype?: string;
  kind: "builtin" | "structure" | "enum" | "other";
  fields?: UField[];                                // structure
  enumValues?: Array<{ value: number; name: string; description?: string }>;
}
export interface UNamespaceInfo { uri: string; version?: string; publicationDate?: string }

export interface UaModel {
  namespaces: string[];
  namespaceInfo: Map<string, UNamespaceInfo>;
  nodes: Map<string, UNode>;
  types: Map<string, UType>;
  refTypes: Map<string, URefType>;
  dataTypes: Map<string, UDataType>;
  crawlMs: number;
}

/** node-opcua returns Int64 as [high, low]. */
export const int64 = (v: unknown): number => Array.isArray(v) ? v[0] * 2 ** 32 + v[1] : Number(v);

const BATCH = 200;
const chunks = <T>(a: T[], n = BATCH) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export class Crawler {
  private ns: string[] = [];
  readonly m: UaModel = { namespaces: [], namespaceInfo: new Map(), nodes: new Map(), types: new Map(), refTypes: new Map(), dataTypes: new Map(), crawlMs: 0 };

  constructor(private readonly session: ClientSession, private readonly opts: { includeCoreInfrastructure: boolean }) {}

  // ---------- id helpers ----------
  key(n: NodeId | { namespace: number; identifierType: number; value: unknown }): string {
    // rebuild as a plain NodeId: ExpandedNodeIds from Browse may stringify with server/namespace extras
    const nid = new NodeId(n.identifierType, n.value as any, n.namespace);
    const s = nid.toString();
    if (nid.namespace === 0) return s.replace(/^ns=0;/, "");
    return `nsu=${this.ns[nid.namespace]};${s.replace(/^ns=\d+;/, "")}`;
  }
  /** "nsu=…;s=x" / "i=85" → NodeId usable with this session's namespace table. */
  nodeId(key: string): NodeId {
    const m = key.match(/^nsu=([^;]*);(.*)$/);
    if (!m) return NodeId.resolveNodeId(key);
    const idx = this.ns.indexOf(m[1]);
    if (idx < 0) throw new Error(`namespace not on server: ${m[1]}`);
    return NodeId.resolveNodeId(`ns=${idx};${m[2]}`);
  }
  qn(q: { namespaceIndex: number; name: string | null }): QName { return { ns: this.ns[q.namespaceIndex] ?? "", name: q.name ?? "" }; }

  // ---------- service wrappers (batched, with continuation points) ----------
  async browse(ids: string[], dir = BrowseDirection.Forward, refType: string = ID.References): Promise<Map<string, ReferenceDescription[]>> {
    const out = new Map<string, ReferenceDescription[]>();
    for (const part of chunks(ids)) {
      const req: BrowseDescriptionOptions[] = part.map((id) => ({ nodeId: this.nodeId(id), browseDirection: dir, referenceTypeId: this.nodeId(refType), includeSubtypes: true, nodeClassMask: 0, resultMask: 63 }));
      const res = await this.session.browse(req);
      for (let i = 0; i < part.length; i++) {
        const refs = [...(res[i].references ?? [])];
        let cp = res[i].continuationPoint;
        while (cp && cp.length) {
          const next = await this.session.browseNext(cp, false);
          refs.push(...(next.references ?? []));
          cp = next.continuationPoint;
        }
        out.set(part[i], refs);
      }
    }
    return out;
  }
  async read(items: Array<{ id: string; attr: AttributeIds }>): Promise<DataValue[]> {
    const out: DataValue[] = [];
    for (const part of chunks(items, 500)) {
      const req: ReadValueIdOptions[] = part.map((x) => ({ nodeId: this.nodeId(x.id), attributeId: x.attr }));
      out.push(...(await this.session.read(req)));
    }
    return out;
  }
  async readValues(ids: string[]) { return this.read(ids.map((id) => ({ id, attr: AttributeIds.Value }))); }
  async readHistory(ids: string[], start: Date, end: Date): Promise<HistoryReadResult[]> {
    if (!ids.length) return [];
    return this.session.readHistoryValue(ids.map((id) => this.nodeId(id)), start, end);
  }
  async write(items: Array<{ node: string; variant: Variant }>): Promise<StatusCode[]> {
    return this.session.write(items.map((x) => ({ nodeId: this.nodeId(x.node), attributeId: AttributeIds.Value, value: { value: x.variant } })));
  }

  // ---------- crawl ----------
  async crawl(): Promise<UaModel> {
    const t0 = Date.now();
    this.ns = await this.session.readNamespaceArray();
    this.m.namespaces = [...this.ns];
    await this.crawlInstances();
    await this.readInstanceAttributes();
    await this.crawlTypes();
    await this.crawlRefTypes();
    await this.crawlDataTypes();
    await this.crawlNamespaceInfo();
    this.m.crawlMs = Date.now() - t0;
    return this.m;
  }

  private async crawlInstances() {
    const root: UNode = { id: ID.Objects, nodeClass: "Object", browseName: { ns: this.ns[0], name: "Objects" }, displayName: "Objects", depth: 0, refs: [] };
    this.m.nodes.set(root.id, root);
    let level = [root.id];
    const hier = new Set<string>();      // ReferenceTypes known to be hierarchical (filled lazily)
    while (level.length) {
      const browsed = await this.browse(level);
      // classify any new ReferenceTypes before following them
      const unknown = new Set<string>();
      for (const refs of browsed.values()) for (const r of refs) { const t = this.key(r.referenceTypeId); if (!this.m.refTypes.has(t)) unknown.add(t); }
      await this.loadRefTypes([...unknown]);
      for (const t of this.m.refTypes.keys()) if (this.isSubtype(t, ID.HierarchicalReferences, "ref")) hier.add(t);

      const next: string[] = [];
      for (const [id, refs] of browsed) {
        const node = this.m.nodes.get(id)!;
        for (const r of refs) {
          if (!r.isForward) continue;
          const type = this.key(r.referenceTypeId), target = this.key(r.nodeId as unknown as NodeId);
          if (type === ID.HasTypeDefinition) { node.typeDefinition = target; continue; }
          node.refs.push({ type, target });
          // follow hierarchy only; event notifier paths and historian configuration are server plumbing, not model
          if (!hier.has(type) || this.isSubtype(type, ID.HasEventSource, "ref") || this.isSubtype(type, ID.HasHistoricalConfiguration, "ref")) continue;
          if (this.m.nodes.has(target)) continue;
          const nc = NodeClass[r.nodeClass] as keyof typeof NodeClass;
          if (!["Object", "Variable", "Method"].includes(nc)) continue;
          if (r.nodeId.namespace === 0 && !this.opts.includeCoreInfrastructure) continue;   // ns0 infrastructure (Server, Aliases, …)
          this.m.nodes.set(target, {
            id: target, nodeClass: nc, browseName: this.qn(r.browseName), displayName: r.displayName.text ?? r.browseName.name ?? "",
            locale: r.displayName.locale ?? undefined, depth: node.depth + 1, refs: [],
            typeDefinition: r.typeDefinition && !r.typeDefinition.isEmpty() ? this.key(r.typeDefinition as unknown as NodeId) : undefined,
          });
          if (nc !== "Method") next.push(target);
        }
      }
      level = next;
    }
  }

  private async readInstanceAttributes() {
    const nodes = [...this.m.nodes.values()].filter((n) => n.id !== ID.Objects);
    const desc = await this.read(nodes.map((n) => ({ id: n.id, attr: AttributeIds.Description })));
    nodes.forEach((n, i) => { const t = desc[i].value?.value?.text; if (t) n.description = t; });
    const vars = nodes.filter((n) => n.nodeClass === "Variable");
    const dv = await this.read(vars.flatMap((n) => [{ id: n.id, attr: AttributeIds.DataType }, { id: n.id, attr: AttributeIds.ValueRank }, { id: n.id, attr: AttributeIds.UserAccessLevel }]));
    vars.forEach((n, i) => { n.dataType = this.key(dv[3 * i].value.value); n.valueRank = dv[3 * i + 1].value.value; n.accessLevel = dv[3 * i + 2].value.value; });
  }

  // ---------- types ----------
  private async crawlTypes() {
    let pending = new Set<string>();
    for (const n of this.m.nodes.values()) if (n.typeDefinition) pending.add(n.typeDefinition);
    while (pending.size) {
      const ids = [...pending].filter((t) => !this.m.types.has(t));
      pending = new Set();
      if (!ids.length) break;
      const attrs = await this.read(ids.flatMap((id) => [
        { id, attr: AttributeIds.NodeClass }, { id, attr: AttributeIds.BrowseName }, { id, attr: AttributeIds.DisplayName },
        { id, attr: AttributeIds.Description }, { id, attr: AttributeIds.IsAbstract }, { id, attr: AttributeIds.DataType }, { id, attr: AttributeIds.ValueRank },
      ]));
      const supers = await this.browse(ids, BrowseDirection.Inverse, ID.HasSubtype);
      const fwd = await this.browse(ids);
      const memberIds: string[] = [];
      ids.forEach((id, i) => {
        const a = attrs.slice(7 * i, 7 * i + 7);
        const nc = NodeClass[a[0].value.value] as "ObjectType" | "VariableType";
        const t: UType = {
          id, nodeClass: nc, browseName: this.qn(a[1].value.value), displayName: a[2].value.value?.text ?? "",
          description: a[3].value.value?.text ?? undefined, isAbstract: !!a[4].value.value, members: [], interfaces: [],
          dataType: nc === "VariableType" && a[5].value.value ? this.key(a[5].value.value) : undefined,
          valueRank: nc === "VariableType" ? a[6].value.value : undefined,
        };
        const sup = supers.get(id)?.find((r) => !r.isForward);
        if (sup) { t.supertype = this.key(sup.nodeId as unknown as NodeId); pending.add(t.supertype); }
        for (const r of fwd.get(id) ?? []) {
          const rt = this.key(r.referenceTypeId);
          if (rt === ID.HasInterface) { const iface = this.key(r.nodeId as unknown as NodeId); t.interfaces.push(iface); pending.add(iface); continue; }
          if (rt === ID.HasSubtype || !r.isForward) continue;
          const nc2 = NodeClass[r.nodeClass] as keyof typeof NodeClass;
          if (!["Object", "Variable", "Method"].includes(nc2)) continue;
          const mid = this.key(r.nodeId as unknown as NodeId);
          t.members.push({ browseName: this.qn(r.browseName), nodeClass: nc2, refType: rt,
            typeDefinition: r.typeDefinition && !r.typeDefinition.isEmpty() ? this.key(r.typeDefinition as unknown as NodeId) : undefined,
            ...({ _id: mid } as object) } as UMember);
          memberIds.push(mid);
        }
        this.m.types.set(id, t);
      });
      // member details: modelling rule, DataType, ValueRank, Description
      const rules = await this.browse(memberIds, BrowseDirection.Forward, ID.HasModellingRule);
      const mattr = await this.read(memberIds.flatMap((id) => [{ id, attr: AttributeIds.DataType }, { id, attr: AttributeIds.ValueRank }, { id, attr: AttributeIds.Description }]));
      const byId = new Map(memberIds.map((id, i) => [id, i]));
      for (const id of ids) for (const mem of this.m.types.get(id)!.members as Array<UMember & { _id?: string }>) {
        const k = mem._id!;
        const i = byId.get(k)!;
        const rule = rules.get(k)?.find((r) => r.isForward);
        if (rule) mem.modellingRule = MODELLING_RULE[this.key(rule.nodeId as unknown as NodeId)] ?? this.key(rule.nodeId as unknown as NodeId);
        if (mem.nodeClass === "Variable") { mem.dataType = this.key(mattr[3 * i].value.value); mem.valueRank = mattr[3 * i + 1].value.value; }
        const d = mattr[3 * i + 2].value.value?.text; if (d) mem.description = d;
        if (mem.typeDefinition && !this.m.types.has(mem.typeDefinition)) pending.add(mem.typeDefinition);
        delete mem._id;
      }
    }
  }

  // ---------- reference types ----------
  private async loadRefTypes(ids: string[]) {
    let todo = ids.filter((t) => !this.m.refTypes.has(t));
    while (todo.length) {
      const attrs = await this.read(todo.flatMap((id) => [
        { id, attr: AttributeIds.BrowseName }, { id, attr: AttributeIds.InverseName }, { id, attr: AttributeIds.Symmetric }, { id, attr: AttributeIds.IsAbstract },
      ]));
      const supers = await this.browse(todo, BrowseDirection.Inverse, ID.HasSubtype);
      const next = new Set<string>();
      todo.forEach((id, i) => {
        const a = attrs.slice(4 * i, 4 * i + 4);
        const sup = supers.get(id)?.find((r) => !r.isForward);
        const rt: URefType = { id, browseName: this.qn(a[0].value.value), inverseName: a[1].value.value?.text ?? undefined,
          symmetric: !!a[2].value.value, isAbstract: !!a[3].value.value, supertype: sup ? this.key(sup.nodeId as unknown as NodeId) : undefined };
        this.m.refTypes.set(id, rt);
        if (rt.supertype && !this.m.refTypes.has(rt.supertype)) next.add(rt.supertype);
      });
      todo = [...next];
    }
  }
  private async crawlRefTypes() {
    const used = new Set<string>();
    for (const n of this.m.nodes.values()) for (const r of n.refs) used.add(r.type);
    for (const t of this.m.types.values()) for (const mem of t.members) used.add(mem.refType);
    await this.loadRefTypes([...used]);
  }

  /** true if `id` is `ancestor` or one of its subtypes (ReferenceTypes, ObjectTypes or DataTypes). */
  isSubtype(id: string | undefined, ancestor: string, kind: "ref" | "type" | "data"): boolean {
    const get = (x: string) => kind === "ref" ? this.m.refTypes.get(x)?.supertype : kind === "type" ? this.m.types.get(x)?.supertype : this.m.dataTypes.get(x)?.supertype;
    for (let t = id, guard = 0; t && guard < 64; t = get(t), guard++) if (t === ancestor) return true;
    return false;
  }

  // ---------- data types ----------
  private async crawlDataTypes() {
    let pending = new Set<string>();
    for (const n of this.m.nodes.values()) if (n.dataType) pending.add(n.dataType);
    for (const t of this.m.types.values()) { if (t.dataType) pending.add(t.dataType); for (const mem of t.members) if (mem.dataType) pending.add(mem.dataType); }
    while (pending.size) {
      const ids = [...pending].filter((d) => !this.m.dataTypes.has(d));
      pending = new Set();
      if (!ids.length) break;
      const attrs = await this.read(ids.flatMap((id) => [{ id, attr: AttributeIds.BrowseName }, { id, attr: AttributeIds.IsAbstract }, { id, attr: AttributeIds.DataTypeDefinition }]));
      const supers = await this.browse(ids, BrowseDirection.Inverse, ID.HasSubtype);
      const props = await this.browse(ids, BrowseDirection.Forward, ID.HasProperty);
      const enumProps: Array<{ dt: string; prop: string; name: string }> = [];
      ids.forEach((id, i) => {
        const a = attrs.slice(3 * i, 3 * i + 3);
        const sup = supers.get(id)?.find((r) => !r.isForward);
        const dt: UDataType = { id, browseName: this.qn(a[0].value.value), isAbstract: !!a[1].value.value,
          supertype: sup ? this.key(sup.nodeId as unknown as NodeId) : undefined, kind: "other" };
        const def = a[2].value?.value;
        if (def?.fields && Array.isArray(def.fields) && def.fields.length && "dataType" in def.fields[0]) {
          dt.kind = "structure";
          dt.fields = def.fields.map((f: any) => ({ name: f.name, dataType: this.key(f.dataType), valueRank: f.valueRank ?? -1, isOptional: !!f.isOptional, description: f.description?.text ?? undefined }));
          for (const f of dt.fields!) pending.add(f.dataType);
        } else if (def?.fields && Array.isArray(def.fields)) {
          dt.kind = "enum";
          dt.enumValues = def.fields.map((f: any) => ({ value: int64(f.value), name: f.name, description: f.description?.text ?? undefined }));
        }
        if (/^i=([1-9]|1\d|2[0-5])$/.test(id)) dt.kind = "builtin";
        for (const r of props.get(id) ?? []) if (r.browseName.name === "EnumStrings" || r.browseName.name === "EnumValues") enumProps.push({ dt: id, prop: this.key(r.nodeId as unknown as NodeId), name: r.browseName.name });
        if (dt.supertype) pending.add(dt.supertype);
        this.m.dataTypes.set(id, dt);
      });
      // enums without a DataTypeDefinition (older NodeSets): EnumStrings / EnumValues properties
      if (enumProps.length) {
        const vals = await this.readValues(enumProps.map((e) => e.prop));
        enumProps.forEach((e, i) => {
          const dt = this.m.dataTypes.get(e.dt)!;
          if (dt.enumValues) return;
          const v = vals[i].value.value;
          if (!Array.isArray(v)) return;
          dt.kind = "enum";
          dt.enumValues = e.name === "EnumStrings"
            ? v.map((t: any, j: number) => ({ value: j, name: t.text ?? String(t) }))
            : v.map((x: any) => ({ value: int64(x.value), name: x.displayName?.text ?? String(x.value), description: x.description?.text ?? undefined }));
        });
      }
    }
  }

  // ---------- namespace metadata (Server/Namespaces) ----------
  private async crawlNamespaceInfo() {
    for (const uri of this.ns) this.m.namespaceInfo.set(uri, { uri });
    const children = (await this.browse([ID.NamespacesFolder], BrowseDirection.Forward, ID.HasComponent)).get(ID.NamespacesFolder) ?? [];
    const objs = children.map((r) => this.key(r.nodeId as unknown as NodeId));
    const props = await this.browse(objs, BrowseDirection.Forward, ID.HasProperty);
    const want: Array<{ obj: string; name: string; id: string }> = [];
    for (const o of objs) for (const r of props.get(o) ?? []) {
      if (["NamespaceUri", "NamespaceVersion", "NamespacePublicationDate"].includes(r.browseName.name ?? "")) want.push({ obj: o, name: r.browseName.name!, id: this.key(r.nodeId as unknown as NodeId) });
    }
    const vals = await this.readValues(want.map((w) => w.id));
    const byObj = new Map<string, Record<string, unknown>>();
    want.forEach((w, i) => { const rec = byObj.get(w.obj) ?? {}; rec[w.name] = vals[i].value?.value; byObj.set(w.obj, rec); });
    for (const rec of byObj.values()) {
      const uri = rec.NamespaceUri as string | undefined;
      if (!uri || !this.m.namespaceInfo.has(uri)) continue;
      const info = this.m.namespaceInfo.get(uri)!;
      if (rec.NamespaceVersion) info.version = String(rec.NamespaceVersion);
      if (rec.NamespacePublicationDate instanceof Date && rec.NamespacePublicationDate.getTime() > 0) info.publicationDate = rec.NamespacePublicationDate.toISOString();
    }
  }
}
