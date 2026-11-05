/**
 * "UNS-style" i3X server for the beverage plant: a hand-authored asset model (model.yaml) whose values a
 * simple connector polls from the plant's OPC UA server. Intentionally naive about OPC UA information
 * models: it knows tag paths, not types or references. Third comparison point next to cesmii and i3x2ua.
 *
 *   node --import tsx uns/src/main.ts      (UNS_PORT=8083, OPCUA_ENDPOINT=opc.tcp://localhost:4840/UA/BeverageFactory)
 */
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import compress from "@fastify/compress";
import { AttributeIds, OPCUAClient, type ClientSession, type DataValue } from "node-opcua";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.UNS_PORT ?? 8083);
const ENDPOINT = process.env.OPCUA_ENDPOINT ?? "opc.tcp://localhost:4840/UA/BeverageFactory";
const I3X_NS = "https://cesmii.org/i3x";

// ---------------------------------------------------------------- model
type Spec = string | { path?: string; as?: string | { equals?: string; enum?: Record<string, string> }; fallback?: Spec; derive?: string };
interface TypeDef { description?: string; schema: Record<string, unknown>; tags?: Record<string, Spec> }
interface AssetDef { id: string; name: string; type: string; tag?: string; nameplate?: boolean; tags?: Record<string, Spec>; value?: Record<string, unknown> }
interface AreaDef { id: string; name: string; type: string; value?: Record<string, unknown>; assets: AssetDef[] }
interface Model {
  namespace: string; plantNamespace: string; pollMs: number; types: Record<string, TypeDef>;
  enterprise: AssetDef; site: AssetDef; areas: AreaDef[]; feeds: Array<[string, string]>; supplies: Array<[string, string]>;
}
const model = parse(fs.readFileSync(path.join(HERE, "../model.yaml"), "utf8")) as Model;
const NS = model.namespace;

interface Element {
  elementId: string; displayName: string; typeElementId: string; parentId: string | null; children: string[]; components: string[];
  fields?: Record<string, Spec>; vqt: { value: unknown; quality: string; timestamp: string };
}
const elements = new Map<string, Element>();
const edges = new Map<string, Array<{ rel: string; target: string }>>();
const byAssetId = new Map<string, string>();
const started = new Date().toISOString();
const edge = (from: string, rel: string, to: string) => { (edges.get(from) ?? edges.set(from, []).get(from)!).push({ rel, target: to }); };

function add(elementId: string, displayName: string, type: string, parentId: string | null, opts: { fields?: Record<string, Spec>; value?: Record<string, unknown>; component?: boolean } = {}) {
  if (!model.types[type]) throw new Error(`unknown type ${type} for ${elementId}`);
  elements.set(elementId, { elementId, displayName, typeElementId: type, parentId, children: [], components: [], fields: opts.fields,
    vqt: opts.fields ? { value: null, quality: "GoodNoData", timestamp: started } : { value: opts.value ?? { name: displayName }, quality: "Good", timestamp: started } });
  if (parentId) {
    const p = elements.get(parentId)!;
    p.children.push(elementId);
    edge(parentId, "HasChildren", elementId); edge(elementId, "HasParent", parentId);
    if (opts.component) { p.components.push(elementId); edge(parentId, "HasComponent", elementId); edge(elementId, "ComponentOf", parentId); }
  }
}
const withTag = (specs: Record<string, Spec> | undefined, tag: string) =>
  JSON.parse(JSON.stringify(specs ?? {}).replaceAll("{tag}", tag)) as Record<string, Spec>;

const root = model.enterprise.id, site = `${root}/${model.site.id}`;
add(root, model.enterprise.name, "Enterprise", null, { value: model.enterprise.value });
add(site, model.site.name, "Site", root, { value: model.site.value });
for (const area of model.areas) {
  const aid = `${site}/${area.id}`;
  add(aid, area.name, area.type, site, { value: area.value });
  for (const a of area.assets) {
    const id = `${aid}/${a.id}`;
    byAssetId.set(a.id, id);
    add(id, a.tag ? `${a.name} (${a.tag})` : a.name, a.type, aid, { fields: { ...withTag(model.types[a.type].tags, a.tag ?? ""), ...withTag(a.tags, a.tag ?? "") } });
    if (a.nameplate && a.tag) add(`${id}/nameplate`, `${a.name} Nameplate`, "Nameplate", id, { fields: withTag(model.types.Nameplate.tags, a.tag), component: true });
  }
}
for (const [kind, fwd, rev] of [["feeds", "Feeds", "FedBy"], ["supplies", "Supplies", "SuppliedBy"]] as const) {
  for (const [a, b] of model[kind]) { edge(byAssetId.get(a)!, fwd, byAssetId.get(b)!); edge(byAssetId.get(b)!, rev, byAssetId.get(a)!); }
}

// ---------------------------------------------------------------- connector (poll the plant's OPC UA server)
const paths = new Set<string>();
const collect = (s: Spec) => { if (typeof s === "string") paths.add(s); else { if (s.path) paths.add(s.path); if (s.fallback) collect(s.fallback); } };
for (const e of elements.values()) for (const s of Object.values(e.fields ?? {})) collect(s);

const raw = (v: unknown): unknown => {
  if (v && typeof v === "object" && "text" in v) return (v as { text: string }).text;   // LocalizedText
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === "number")) return v[0] * 2 ** 32 + v[1];   // Int64
  return v;
};
function convert(spec: Spec, reads: Map<string, DataValue>): unknown {
  const s = typeof spec === "string" ? { path: spec } : spec;
  const dv = reads.get(s.path!);
  if (!dv || !dv.statusCode.isGood() || dv.value.value === null || dv.value.value === undefined) return s.fallback ? convert(s.fallback, reads) : undefined;
  const v = dv.value.value as any;
  const as = s.as ?? "raw";
  if (typeof as === "object") {
    if (as.equals !== undefined) return raw(v) === as.equals;
    if (as.enum) return as.enum[String(v)] ?? String(v);
  }
  switch (as) {
    case "bool": return Boolean(v);
    case "count": return Array.isArray(v) ? Number(v[0]?.count ?? v[0]?.Count ?? 0) : Number(v?.count ?? 0);
    case "message": return v?.message ?? v?.Message ?? "";
    case "code": return Number(v?.ID ?? v?.iD ?? 0);
    default: return raw(v);
  }
}
const round = (x: number, d = 2) => Math.round(x * 10 ** d) / 10 ** d;
const DERIVE: Record<string, (...a: any[]) => unknown> = {
  running: (speed: number) => speed > 1,
  ratio: (a: number, b: number) => (b > 0 ? round(a / b) : 0),
  brix: (density: number) => round(261.3 * (1 - 998 / density)),      // °Bx ≈ 261.3·(1 − 1/SG), SG vs water at 998 kg/m³
  co2volumes: (gl: number) => round(gl / 1.977),                       // 1 volume of CO₂ ≈ 1.977 g/L
  equals: (a: unknown, b: unknown) => a === b,
};

const client = OPCUAClient.create({ applicationName: "uns-i3x connector", endpointMustExist: false, connectionStrategy: { maxRetry: 1_000_000, initialDelay: 1000, maxDelay: 10_000 } });
let session: ClientSession | undefined;
let nsIndex = -1;

async function poll() {
  if (!session) return;
  const list = [...paths];
  const reads = new Map<string, DataValue>();
  for (let i = 0; i < list.length; i += 500) {
    const part = list.slice(i, i + 500);
    const dvs = await session.read(part.map((p) => ({ nodeId: `ns=${nsIndex};s=${p}`, attributeId: AttributeIds.Value })));
    part.forEach((p, j) => reads.set(p, dvs[j]));
  }
  const now = new Date().toISOString();
  for (const e of elements.values()) {
    if (!e.fields) continue;
    const value: Record<string, unknown> = {};
    let missing = 0, total = 0;
    for (const [k, s] of Object.entries(e.fields)) {
      if (typeof s !== "string" && s.derive) continue;
      total++;
      const v = convert(s, reads);
      if (v === undefined) missing++; else value[k] = v;
    }
    for (const [k, s] of Object.entries(e.fields)) {   // derived values, from fields read above
      if (typeof s === "string" || !s.derive) continue;
      const m = s.derive.match(/^(\w+)\((.*)\)$/);
      const args = (m?.[2] ?? "").split(",").map((x) => x.trim()).map((x) => (x in value ? value[x] : x));
      if (m && DERIVE[m[1]] && args.every((x) => x !== undefined)) value[k] = DERIVE[m[1]](...args);
    }
    const quality = missing === total ? "Bad" : missing ? "Uncertain" : "Good";
    const next = { value: quality === "Bad" ? null : value, quality, timestamp: now };
    if (JSON.stringify(next.value) !== JSON.stringify(e.vqt.value) || next.quality !== e.vqt.quality) {
      e.vqt = next;                                     // timestamp = when the connector saw the change
      publish(e.elementId);
    }
  }
}

// ---------------------------------------------------------------- subscriptions
interface Update { elementId: string; value: unknown; quality: string; timestamp: string }
interface Sub { id: string; clientId: string; displayName: string; regs: Map<string, number>; watch: Set<string>; pending: Update[];
  batches: Array<{ sequenceNumber: number; updates: Update[] }>; seq: number; dropped: boolean; seen: number; stream?: ServerResponse }
const subs = new Map<string, Sub>();
const QUEUE_LIMIT = 10_000, TTL_MS = 300_000;
const expand = (id: string, depth: number): string[] => [id, ...(depth === 1 ? [] : elements.get(id)!.components.flatMap((c) => expand(c, depth === 0 ? 0 : depth - 1)))];
function deliver(s: Sub, u: Update) {
  if (s.stream) { s.stream.write(`data: ${JSON.stringify([u])}\n\n`); s.seen = Date.now(); return; }
  s.pending.push(u);
  while (s.pending.length + s.batches.reduce((a, b) => a + b.updates.length, 0) > QUEUE_LIMIT) {
    s.dropped = true;
    if (s.batches.length) { s.batches[0].updates.shift(); if (!s.batches[0].updates.length) s.batches.shift(); } else s.pending.shift();
  }
}
function publish(id: string) { const e = elements.get(id)!; for (const s of subs.values()) if (s.watch.has(id)) deliver(s, { elementId: id, ...e.vqt }); }
setInterval(() => { for (const [id, s] of subs) if (!s.stream && Date.now() - s.seen > TTL_MS) subs.delete(id); }, 15_000).unref();

// ---------------------------------------------------------------- i3X HTTP API
const app = Fastify({ logger: false });
await app.register(compress, { global: true, encodings: ["gzip", "deflate"], threshold: 0 });   // IG: gzip whenever asked
const base = `${(process.env.UNS_BASE_PATH ?? "").replace(/\/+$/, "")}/v1`;
const problem = (status: number, title: string, detail: string) => ({ success: false, responseDetail: { title, status, detail } });
const fail = (r: FastifyReply, status: number, detail: string) => r.code(status).send(problem(status, { 400: "Bad Request", 404: "Not Found", 501: "Not Implemented" }[status] ?? "Error", detail));
const notFound = (key: string, id: string, what = "Element") => ({ success: false, [key]: id, responseDetail: { title: "Not Found", status: 404, detail: `${what} not found: ${id}` } });
const body = (req: FastifyRequest) => (req.body ?? {}) as Record<string, any>;
const ids = (req: FastifyRequest, r: FastifyReply) => {
  const v = body(req).elementIds;
  if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string")) { void fail(r, 400, "elementIds must be a non-empty array of strings"); return null; }
  return v as string[];
};
const depthOf = (req: FastifyRequest, r: FastifyReply) => {
  const d = body(req).maxDepth;
  if (d === undefined || d === null) return 1;
  if (!Number.isInteger(d) || d < 0) { void fail(r, 400, "maxDepth must be an integer >= 0"); return null; }
  return d as number;
};
const relsOf = (id: string) => { const o: Record<string, string[]> = {}; for (const e of edges.get(id) ?? []) (o[e.rel] ??= []).push(e.target); return o; };
const objOut = (e: Element, meta: boolean) => ({
  elementId: e.elementId, displayName: e.displayName, typeElementId: e.typeElementId, parentId: e.parentId, isComposition: e.components.length > 0, isExtended: false,
  ...(meta ? { metadata: { typeNamespaceUri: NS, sourceTypeId: e.typeElementId, description: model.types[e.typeElementId].description, relationships: relsOf(e.elementId) } } : {}),
});
const types = Object.entries(model.types).map(([name, t]) => ({ elementId: name, displayName: name, namespaceUri: NS, sourceTypeId: name, version: "1.0.0", schema: t.schema }));
const relTypes = [
  ["HasParent", "HasChildren", I3X_NS], ["HasChildren", "HasParent", I3X_NS], ["HasComponent", "ComponentOf", I3X_NS], ["ComponentOf", "HasComponent", I3X_NS],
  ["Feeds", "FedBy", NS], ["FedBy", "Feeds", NS], ["Supplies", "SuppliedBy", NS], ["SuppliedBy", "Supplies", NS],
].map(([elementId, reverseOf, namespaceUri]) => ({ elementId, displayName: elementId, namespaceUri, relationshipId: elementId, reverseOf }));
const bulk = <T>(keys: string[], f: (k: string) => T | undefined, what = "Element") => {
  const results = keys.map((k) => { const r = f(k); return r === undefined ? notFound("elementId", k, what) : { success: true, elementId: k, result: r }; });
  return { success: results.every((r) => r.success), results };
};

app.setNotFoundHandler((req, r) => fail(r, 404, `No such endpoint: ${req.method} ${req.url}`));
app.setErrorHandler((err: Error & { statusCode?: number }, _q, r) => fail(r, err.statusCode && err.statusCode < 500 ? 400 : 500, err.message));

app.get(`${base}/info`, async () => ({ success: true, result: { specVersion: "1.0", serverVersion: "0.1.0", serverName: "Demo Beverage UNS (i3X)",
  capabilities: { query: { history: false }, update: { current: false, history: false }, subscribe: { stream: true } } } }));
app.get(`${base}/namespaces`, async () => ({ success: true, result: [{ uri: I3X_NS, displayName: "i3X" }, { uri: NS, displayName: "Demo Beverage UNS" }] }));
app.get(`${base}/objecttypes`, async (req) => { const ns = (req.query as any).namespaceUri; return { success: true, result: types.filter((t) => !ns || t.namespaceUri === ns) }; });
app.post(`${base}/objecttypes/query`, async (req, r) => { const k = ids(req, r); if (!k) return r; return bulk(k, (id) => types.find((t) => t.elementId === id), "Object type"); });
app.get(`${base}/relationshiptypes`, async (req) => { const ns = (req.query as any).namespaceUri; return { success: true, result: relTypes.filter((t) => !ns || t.namespaceUri === ns) }; });
app.post(`${base}/relationshiptypes/query`, async (req, r) => { const k = ids(req, r); if (!k) return r; return bulk(k, (id) => relTypes.find((t) => t.elementId === id), "Relationship type"); });
app.get(`${base}/objects`, async (req) => {
  const q = req.query as Record<string, string>;
  const meta = q.includeMetadata === "true", rootOnly = q.root === "true";
  return { success: true, result: [...elements.values()].filter((e) => (!q.typeElementId || e.typeElementId === q.typeElementId) && (!rootOnly || e.parentId === null)).map((e) => objOut(e, meta)) };
});
app.post(`${base}/objects/list`, async (req, r) => { const k = ids(req, r); if (!k) return r; const meta = body(req).includeMetadata === true;
  return bulk(k, (id) => { const e = elements.get(id); return e && objOut(e, meta); }); });
app.post(`${base}/objects/related`, async (req, r) => {
  const k = ids(req, r); if (!k) return r;
  const rt = body(req).relationshipType, meta = body(req).includeMetadata === true;
  if (rt && !relTypes.some((t) => t.elementId === rt)) return fail(r, 400, `Unknown relationshipType: ${rt}`);
  return bulk(k, (id) => elements.has(id) ? (edges.get(id) ?? []).filter((e) => !rt || e.rel === rt).map((e) => ({ sourceRelationship: e.rel, object: objOut(elements.get(e.target)!, meta) })) : undefined);
});
app.post(`${base}/objects/value`, async (req, r) => {
  const k = ids(req, r); if (!k) return r; const d = depthOf(req, r); if (d === null) return r;
  return bulk(k, (id) => {
    const e = elements.get(id); if (!e) return undefined;
    const comps = d === 1 ? [] : expand(id, d).slice(1);
    return { isComposition: e.components.length > 0, ...e.vqt, ...(comps.length ? { components: Object.fromEntries(comps.map((c) => [c, elements.get(c)!.vqt])) } : {}) };
  });
});
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
app.post(`${base}/objects/history`, async (req, r) => {   // a UNS keeps current state only: no history
  const k = ids(req, r); if (!k) return r; const d = depthOf(req, r); if (d === null) return r;
  const { startTime, endTime } = body(req);
  if (typeof startTime !== "string" || typeof endTime !== "string" || !RFC3339.test(startTime) || !RFC3339.test(endTime)) return fail(r, 400, "startTime and endTime are required RFC 3339 timestamps");
  const none = () => [{ value: null, quality: "GoodNoData", timestamp: new Date(startTime).toISOString() }];
  return bulk(k, (id) => {
    const e = elements.get(id); if (!e) return undefined;
    const comps = d === 1 ? [] : expand(id, d).slice(1);
    return { isComposition: e.components.length > 0, values: none(), ...(comps.length ? { components: Object.fromEntries(comps.map((c) => [c, { values: none() }])) } : {}) };
  });
});
app.put(`${base}/objects/value`, async (_q, r) => fail(r, 501, "Writes are not supported"));
app.put(`${base}/objects/history`, async (_q, r) => fail(r, 501, "History is not supported"));

const sub = (req: FastifyRequest, r: FastifyReply) => {
  const { clientId, subscriptionId } = body(req);
  if (typeof clientId !== "string" || !clientId) { void fail(r, 400, "clientId is required"); return null; }
  const s = subs.get(subscriptionId);
  if (!s || s.clientId !== clientId) { void fail(r, 404, `Subscription not found: ${subscriptionId}`); return null; }
  return s;
};
const needClient = (req: FastifyRequest, r: FastifyReply) => { const c = body(req).clientId; if (typeof c !== "string" || !c) { void fail(r, 400, "clientId is required"); return null; } return c; };
const subIds = (req: FastifyRequest, r: FastifyReply) => { const v = body(req).subscriptionIds; if (!Array.isArray(v) || !v.length) { void fail(r, 400, "subscriptionIds must be a non-empty array"); return null; } return v as string[]; };
app.post(`${base}/subscriptions`, async (req, r) => {
  const c = needClient(req, r); if (!c) return r;
  const s: Sub = { id: randomBytes(24).toString("base64url"), clientId: c, displayName: String(body(req).displayName ?? ""), regs: new Map(), watch: new Set(),
    pending: [], batches: [], seq: 0, dropped: false, seen: Date.now() };
  subs.set(s.id, s);
  return { success: true, result: { clientId: c, subscriptionId: s.id, displayName: s.displayName } };
});
app.post(`${base}/subscriptions/list`, async (req, r) => {
  const c = needClient(req, r); if (!c) return r; const k = subIds(req, r); if (!k) return r;
  const results = k.map((id) => { const s = subs.get(id); return s && s.clientId === c
    ? { success: true, subscriptionId: id, result: { subscriptionId: id, displayName: s.displayName, monitoredObjects: [...s.regs].map(([elementId, maxDepth]) => ({ elementId, maxDepth })) } }
    : notFound("subscriptionId", id, "Subscription"); });
  return { success: results.every((x) => x.success), results };
});
app.post(`${base}/subscriptions/delete`, async (req, r) => {
  const c = needClient(req, r); if (!c) return r; const k = subIds(req, r); if (!k) return r;
  const results = k.map((id) => { const s = subs.get(id); if (!s || s.clientId !== c) return notFound("subscriptionId", id, "Subscription"); s.stream?.end(); subs.delete(id); return { success: true, subscriptionId: id, result: null }; });
  return { success: results.every((x) => x.success), results };
});
for (const op of ["register", "unregister"] as const) {
  app.post(`${base}/subscriptions/${op}`, async (req, r) => {
    const s = sub(req, r); if (!s) return r; const k = ids(req, r); if (!k) return r; const d = depthOf(req, r); if (d === null) return r;
    const results = k.map((id) => elements.has(id) ? { success: true, elementId: id, result: null } : notFound("elementId", id));
    for (const id of k) if (elements.has(id)) { if (op === "register") { if (!s.regs.has(id)) s.regs.set(id, d); } else s.regs.delete(id); }
    const before = new Set(s.watch);
    s.watch = new Set([...s.regs].flatMap(([id, depth]) => expand(id, depth)));
    for (const id of s.watch) if (!before.has(id)) deliver(s, { elementId: id, ...elements.get(id)!.vqt });   // current value on registration
    s.seen = Date.now();
    return { success: results.every((x) => x.success), results };
  });
}
app.post(`${base}/subscriptions/sync`, async (req, r) => {
  const s = sub(req, r); if (!s) return r;
  if (s.stream) return fail(r, 400, "Subscription has an open stream; close it before calling sync");
  const last = body(req).lastSequenceNumber;
  if (last === -1) { s.batches = []; s.pending = []; }
  else if (Number.isInteger(last) && last >= 0) s.batches = s.batches.filter((b) => b.sequenceNumber > last);
  if (s.pending.length) { s.batches.push({ sequenceNumber: ++s.seq, updates: s.pending }); s.pending = []; }
  s.seen = Date.now();
  const dropped = s.dropped; s.dropped = false;
  const out = { success: true, result: s.batches };
  return dropped ? r.code(206).send({ ...out, responseDetail: { title: "Updates dropped due to queue overflow", status: 206, detail: `Queue limit is ${QUEUE_LIMIT} updates` } }) : out;
});
app.post(`${base}/subscriptions/stream`, async (req, r) => {
  const s = sub(req, r); if (!s) return r;
  s.stream?.end();
  r.hijack();
  const res = r.raw;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": stream open\n\n");          // flush headers right away, even with nothing queued
  s.stream = res;
  const queued = [...s.batches.flatMap((b) => b.updates), ...s.pending];
  s.batches = []; s.pending = [];
  if (queued.length) res.write(`data: ${JSON.stringify(queued)}\n\n`);
  const ping = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
  res.on("close", () => { clearInterval(ping); if (s.stream === res) s.stream = undefined; s.seen = Date.now(); });
});

// ---------------------------------------------------------------- start
console.log(`uns: ${elements.size} objects (${[...elements.values()].filter((e) => e.fields).length} with live data), ${paths.size} tags · connecting to ${ENDPOINT}`);
await client.connect(ENDPOINT);
const s0 = await client.createSession();
session = s0;
nsIndex = (await s0.readNamespaceArray()).indexOf(model.plantNamespace);
if (nsIndex < 0) throw new Error(`plant namespace ${model.plantNamespace} not on ${ENDPOINT}`);
await poll();
const timer = setInterval(() => void poll().catch((e) => console.warn("uns: poll failed:", e.message)), model.pollMs);
await app.listen({ port: PORT, host: "0.0.0.0" });
console.log(`uns i3X server listening on http://0.0.0.0:${PORT}${base}`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return; stopping = true;
  setTimeout(() => process.exit(0), 4000).unref();
  clearInterval(timer);
  for (const s of subs.values()) s.stream?.end();
  await app.close().catch(() => undefined);
  await session?.close().catch(() => undefined);
  await client.disconnect().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
