/**
 * Values (MAPPING.md §7): OPC UA DataValues → i3X VQTs, current values with composition, history, writes.
 */
import { AttributeIds, DataType, StatusCode, StatusCodes, Variant, VariantArrayType, type DataValue } from "node-opcua";
import type { Interpretation } from "../config.js";
import type { Crawler, UaModel } from "../ua/crawl.js";
import type { Projection, ValueSource } from "./project.js";

export interface VQT { value: unknown; quality: string; timestamp: string }
const BASE = new Set(["Good", "GoodNoData", "Bad", "Uncertain"]);
const lowerFirst = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
export const MAX_ELEMENTS = 5000;   // server limit per value/history request (→ 206 when exceeded)

export class ValueService {
  constructor(private readonly p: Projection, private readonly c: Crawler, private readonly m: UaModel, private readonly policy: Interpretation) {}

  // ---------- encoding (§5 table) ----------
  quality(sc: StatusCode | undefined, isNull: boolean): string {
    // node-opcua appends info bits as "#Flag" (e.g. "Good#HistorianInterpolated") → "Good_HistorianInterpolated"
    const [main, ...flags] = (sc?.name ?? "Good").split("#");
    const name = flags.length && BASE.has(main) && this.policy.quality !== "base" ? `${main}${flags.join("")}` : main;
    let q: string;
    const m = name.match(/^(Good|Uncertain|Bad)(.*)$/);
    if (!m || BASE.has(name)) q = m ? name : "Bad";
    else q = this.policy.quality === "base" ? m[1] : `${m[1]}_${m[2]}`;
    const cat = q.startsWith("GoodNoData") ? "GoodNoData" : q.split("_")[0];
    if (isNull && (cat === "Good" || cat === "Uncertain")) return "GoodNoData";   // IG null rules
    return q;
  }

  encode(v: unknown, dataType?: string, depth = 0): unknown {
    if (v === null || v === undefined) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "string" || typeof v === "boolean") return v;
    if (v instanceof Date) return v.getTime() <= -11644473600000 ? null : v.toISOString();
    if (Buffer.isBuffer(v)) return v.toString("base64");
    if (ArrayBuffer.isView(v)) return Array.from(v as unknown as ArrayLike<number>).map((x) => this.encode(x, dataType, depth));
    if (Array.isArray(v)) {
      if (v.length === 2 && typeof v[0] === "number" && typeof v[1] === "number" && this.isInt64(dataType)) return this.int64(v as [number, number]);
      return v.map((x) => this.encode(x, dataType, depth));
    }
    const o = v as Record<string, unknown> & { constructor?: { name?: string } };
    const ctor = o.constructor?.name ?? "";
    if ("text" in o && "locale" in o) return (o.text as string) ?? null;                                   // LocalizedText
    if (ctor === "QualifiedName") return `${this.m.namespaces[o.namespaceIndex as number] === "http://opcfoundation.org/UA/" ? "" : `${o.namespaceIndex}:`}${o.name}`;
    if (ctor.includes("NodeId")) return this.c.key(o as never);
    if (ctor === "StatusCode" || ctor.endsWith("StatusCode")) return (o as unknown as StatusCode).name;
    if (ctor === "Variant") return this.encode((o as unknown as Variant).value, undefined, depth);
    // structure: use the DataTypeDefinition field names when we know them
    const dt = dataType ? this.m.dataTypes.get(dataType) : undefined;
    if (dt?.kind === "structure" && dt.fields && depth < 8) {
      return Object.fromEntries(dt.fields.map((f) => [f.name, this.encode(o[f.name] ?? o[lowerFirst(f.name)], f.dataType, depth + 1)]));
    }
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(o)) if (!k.startsWith("_") && typeof x !== "function" && k !== "schema") out[k] = this.encode(x, undefined, depth + 1);
    return out;
  }
  private isInt64(dt?: string) { const b = this.builtin(dt); return b === "i=8" || b === "i=9"; }
  private builtin(id?: string) {
    for (let t = id, g = 0; t && g < 64; t = this.m.dataTypes.get(t)?.supertype, g++) if (/^i=([1-9]|1\d|2\d)$/.test(t)) return t;
    return undefined;
  }
  private int64(v: [number, number]) {
    const big = (BigInt(v[0]) << 32n) + BigInt(v[1] >>> 0);
    return this.policy.int64 === "string" ? big.toString() : Number(big);
  }
  /** Variant → JSON, honouring Int64 and enum switches. */
  encodeVariant(variant: Variant | undefined, dataType?: string): unknown {
    if (!variant || variant.dataType === DataType.Null) return null;
    if (variant.dataType === DataType.Int64 || variant.dataType === DataType.UInt64) {
      return variant.arrayType === VariantArrayType.Scalar ? this.int64(variant.value) : (variant.value as Array<[number, number]>).map((x) => this.int64(x));
    }
    const enc = this.encode(variant.value, dataType);
    const dt = dataType ? this.m.dataTypes.get(dataType) : undefined;
    if (this.policy.enums === "name" && dt?.kind === "enum" && typeof enc === "number") return dt.enumValues?.find((e) => e.value === enc)?.name ?? enc;
    return enc;
  }

  vqt(dv: DataValue | undefined, dataType?: string): VQT {
    // only Bad severity drops the value (IG: Uncertain carries a value; node-opcua's isGoodish() excludes Uncertain)
    const bad = !!dv?.statusCode && (dv.statusCode.value & 0x80000000) !== 0;
    const value = bad ? null : this.encodeVariant(dv?.value, dataType);
    const ts = dv?.sourceTimestamp ?? dv?.serverTimestamp ?? new Date();
    return { value, quality: this.quality(dv?.statusCode, value === null), timestamp: ts.toISOString() };
  }
  /** Branch value = its Properties as an object; quality degrades to Uncertain when any property is not Good. */
  branch(src: ValueSource, dvs: Map<string, DataValue>): VQT {
    if (!src.props.length) return { value: {}, quality: "Good", timestamp: new Date().toISOString() };
    const value: Record<string, unknown> = {};
    let worst = "Good";
    let newest = 0;
    for (const p of src.props) {
      const dv = dvs.get(p.node);
      const q = this.vqt(dv, p.dataType);
      value[p.key] = q.value;
      if (dv && !dv.statusCode.isGood() && !(dv.value?.dataType === DataType.Null && dv.statusCode.isGood())) worst = "Uncertain";
      newest = Math.max(newest, Date.parse(q.timestamp));
    }
    return { value, quality: worst, timestamp: new Date(newest || Date.now()).toISOString() };
  }

  /** Nodes to read for these elements. */
  nodesFor(ids: string[]) {
    const nodes = new Set<string>();
    for (const id of ids) { const s = this.p.values.get(id); if (!s) continue; if (s.kind === "leaf") nodes.add(s.node); else s.props.forEach((x) => nodes.add(x.node)); }
    return [...nodes];
  }
  async readNodes(nodes: string[]) {
    const dvs = await this.c.read(nodes.map((id) => ({ id, attr: AttributeIds.Value })));
    return new Map(nodes.map((n, i) => [n, dvs[i]]));
  }
  vqtOf(id: string, dvs: Map<string, DataValue>): VQT {
    const s = this.p.values.get(id)!;
    return s.kind === "leaf" ? this.vqt(dvs.get(s.node), s.dataType) : this.branch(s, dvs);
  }

  /** Composition descendants to `maxDepth` (1 = none, 0 = unbounded), flattened in breadth-first order. */
  descendants(id: string, maxDepth: number): string[] {
    const out: string[] = [];
    let level = [id];
    for (let d = 1; level.length && (maxDepth === 0 || d < maxDepth); d++) {
      const next = level.flatMap((x) => this.p.children.get(x) ?? []);
      out.push(...next);
      level = next;
    }
    return out;
  }

  // ---------- POST /objects/value ----------
  async current(ids: string[], maxDepth: number) {
    let budget = MAX_ELEMENTS, truncated = false;
    const plan = ids.map((id) => {
      if (!this.p.objects.has(id)) return null;
      let desc = this.descendants(id, maxDepth);
      if (desc.length + 1 > budget) { desc = desc.slice(0, Math.max(0, budget - 1)); truncated = true; }
      budget -= desc.length + 1;
      return { id, desc };
    });
    const dvs = await this.readNodes(this.nodesFor(plan.flatMap((x) => (x ? [x.id, ...x.desc] : []))));
    const items = plan.map((x, i) => {
      if (!x) return { success: false, elementId: ids[i], responseDetail: { title: "Not Found", status: 404, detail: `Element not found: ${ids[i]}` } };
      const o = this.p.objects.get(x.id)!;
      const result: Record<string, unknown> = { isComposition: o.isComposition, ...this.vqtOf(x.id, dvs) };
      if (o.isComposition && maxDepth !== 1) result.components = this.components(x.id, x.desc, (cid) => this.vqtOf(cid, dvs));
      return { success: true, elementId: x.id, result };
    });
    return { items, truncated };
  }
  /** flat (default): every descendant keyed by elementId · nested: each VQT carries its own `components`. */
  private components<T extends object>(root: string, desc: string[], val: (id: string) => T): Record<string, T> {
    if (this.policy.componentsShape !== "nested") return Object.fromEntries(desc.map((d) => [d, val(d)]));
    const keep = new Set(desc);
    const build = (id: string): Record<string, T> => Object.fromEntries((this.p.children.get(id) ?? []).filter((c) => keep.has(c)).map((c) => {
      const sub = build(c);
      return [c, Object.keys(sub).length ? { ...val(c), components: sub } : val(c)];
    }));
    return build(root);
  }

  // ---------- POST /objects/history ----------
  async history(ids: string[], start: Date, end: Date, maxDepth: number) {
    const plan = ids.map((id) => (this.p.objects.has(id) ? { id, desc: this.descendants(id, maxDepth).slice(0, MAX_ELEMENTS) } : null));
    const all = [...new Set(plan.flatMap((x) => (x ? [x.id, ...x.desc] : [])))];
    const leaves = all.filter((id) => this.p.values.get(id)?.kind === "leaf");
    const hist = new Map<string, VQT[]>();
    for (let i = 0; i < leaves.length; i += 100) {
      const part = leaves.slice(i, i + 100);
      const res = await this.c.readHistory(part.map((id) => this.p.values.get(id)!.node), start, end);
      part.forEach((id, j) => {
        const r = res[j];
        const dt = this.p.values.get(id)!.dataType;
        const vals = r && r.statusCode.isGood() ? ((r.historyData as { dataValues?: DataValue[] })?.dataValues ?? []).filter((d) => d.statusCode.value !== StatusCodes.BadBoundNotFound.value) : [];
        hist.set(id, vals.map((d) => this.vqt(d, dt)));
      });
    }
    const noData = (): VQT[] => [{ value: null, quality: "GoodNoData", timestamp: start.toISOString() }];
    const valuesOf = (id: string) => { const h = hist.get(id); return h && h.length ? h : noData(); };
    return plan.map((x, i) => {
      if (!x) return { success: false, elementId: ids[i], responseDetail: { title: "Not Found", status: 404, detail: `Element not found: ${ids[i]}` } };
      const o = this.p.objects.get(x.id)!;
      const result: Record<string, unknown> = { isComposition: o.isComposition, values: valuesOf(x.id) };
      if (o.isComposition && maxDepth !== 1) result.components = this.components(x.id, x.desc, (cid) => ({ isComposition: this.p.objects.get(cid)!.isComposition, values: valuesOf(cid) }));
      return { success: true, elementId: x.id, result };
    });
  }

  // ---------- PUT /objects/value (full-value writes; unchanged attributes are not re-written) ----------
  async write(updates: Array<{ elementId?: unknown; value?: { value?: unknown } }>) {
    const results = [];
    for (const u of updates) {
      const id = typeof u?.elementId === "string" ? u.elementId : "";
      const fail = (status: number, title: string, detail: string) => ({ success: false, elementId: id, responseDetail: { title, status, detail } });
      const src = this.p.values.get(id);
      if (!src) { results.push(fail(404, "Not Found", `Element not found: ${id}`)); continue; }
      if (!u.value || !("value" in u.value)) { results.push(fail(400, "Bad Request", "updates[].value must be a VQT with a `value`")); continue; }
      const nodes = src.kind === "leaf" ? [{ key: "", node: src.node, dataType: src.dataType }] : src.props;
      const dvs = await this.readNodes(nodes.map((n) => n.node));
      const writes: Array<{ node: string; variant: Variant }> = [];
      let problem: string | undefined;
      const want = u.value.value;
      if (src.kind === "branch" && (typeof want !== "object" || want === null || Array.isArray(want))) problem = "value must be an object (the Object's Properties)";
      for (const n of nodes) {
        if (problem) break;
        const target = src.kind === "leaf" ? want : (want as Record<string, unknown>)[n.key];
        if (src.kind === "branch" && !(n.key in (want as object))) { problem = `full-value write required: missing "${n.key}"`; break; }
        const cur = dvs.get(n.node);
        if (JSON.stringify(this.encodeVariant(cur?.value, n.dataType)) === JSON.stringify(target)) continue;   // unchanged
        const dt = cur?.value?.dataType ?? DataType.Null;
        if (dt === DataType.Null || dt === DataType.ExtensionObject) { problem = `"${n.key || id}" cannot be written through this gateway (type ${DataType[dt]})`; break; }
        const raw = dt === DataType.LocalizedText ? { text: target } : dt === DataType.DateTime ? new Date(String(target)) : target;
        writes.push({ node: n.node, variant: new Variant({ dataType: dt, value: raw }) });
      }
      if (problem) { results.push(fail(400, "Bad Request", problem)); continue; }
      // all-or-nothing: refuse before writing anything if a changed attribute is not writable (UserAccessLevel)
      const ro = writes.find((w) => ((this.m.nodes.get(w.node)?.accessLevel ?? 0) & 2) === 0);
      if (ro) { results.push(fail(403, "Forbidden", `Not writable: ${this.m.nodes.get(ro.node)?.browseName.name ?? ro.node} (OPC UA UserAccessLevel). Nothing was written.`)); continue; }
      const codes = writes.length ? await this.c.write(writes) : [];
      const bad = codes.findIndex((s) => !s.isGood());
      results.push(bad >= 0 ? fail(codes[bad].value === StatusCodes.BadNotWritable.value || codes[bad].value === StatusCodes.BadUserAccessDenied.value ? 403 : 400,
        codes[bad].value === StatusCodes.BadNotWritable.value ? "Forbidden" : "Bad Request", `OPC UA Write: ${codes[bad].name}`) : { success: true, elementId: id, result: null });
    }
    return results;
  }
}
