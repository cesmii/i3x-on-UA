/** i3X 1.0 HTTP surface (IG "Response Format" + Exploratory Methods). */
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import compress from "@fastify/compress";
import { GATEWAY_VERSION, type Config } from "../config.js";
import type { I3xObject, Projection } from "../i3x/project.js";
import type { ValueService } from "../i3x/values.js";
import type { Subscriptions } from "../i3x/subs.js";

const problem = (status: number, title: string, detail: string) => ({ success: false, responseDetail: { title, status, detail } });
const TITLES: Record<number, string> = { 400: "Bad Request", 404: "Not Found", 500: "Internal Server Error", 501: "Not Implemented" };

export async function buildServer(cfg: Config, getProjection: () => Projection, values: ValueService, subs: Subscriptions) {
  const app = Fastify({ logger: false, bodyLimit: 10 * 1024 * 1024 });
  await app.register(compress, { global: true, encodings: ["gzip", "deflate"], threshold: 512 });   // before the routes

  const base = `${cfg.http.basePath}/v1`;
  const fail = (reply: FastifyReply, status: number, detail: string) => reply.code(status).send(problem(status, TITLES[status] ?? "Error", detail));
  const bool = (v: unknown) => v === true || v === "true";
  const ids = (req: FastifyRequest, reply: FastifyReply): string[] | null => {
    const b = req.body as { elementIds?: unknown } | undefined;
    if (!b || !Array.isArray(b.elementIds) || b.elementIds.length === 0 || b.elementIds.some((x) => typeof x !== "string")) {
      void fail(reply, 400, "Request body must contain a non-empty `elementIds` array of strings.");
      return null;
    }
    return b.elementIds as string[];
  };
  const bulk = <T>(keys: string[], get: (k: string) => T | undefined, what: string) => {
    const results = keys.map((k) => {
      const r = get(k);
      return r === undefined ? { success: false, elementId: k, responseDetail: { title: "Not Found", status: 404, detail: `${what} not found: ${k}` } } : { success: true, elementId: k, result: r };
    });
    return { success: results.every((r) => r.success), results };
  };
  const obj = (o: I3xObject, meta: boolean) => {
    const { metadata, ...core } = o;
    return meta ? { ...core, metadata } : core;
  };

  app.setNotFoundHandler((req, reply) => fail(reply, 404, `No such endpoint: ${req.method} ${req.url}`));
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 && err.statusCode < 500 ? 400 : 500;
    return fail(reply, status, err.message);
  });

  // ---- GET /info (no authentication; discrepancy #1: envelope is a switch)
  app.get(`${base}/info`, async () => {
    const info = {
      specVersion: "1.0", serverVersion: GATEWAY_VERSION, serverName: cfg.http.serverName,
      capabilities: { query: { history: true }, update: { current: !cfg.http.readOnly, history: false }, subscribe: { stream: true } },
    };
    return cfg.interpretation.infoEnvelope === "bare" ? info : { success: true, result: info };
  });

  // ---- namespaces / types
  app.get(`${base}/namespaces`, async () => ({ success: true, result: [...getProjection().namespaces.values()] }));
  app.get(`${base}/objecttypes`, async (req) => {
    const ns = (req.query as { namespaceUri?: string }).namespaceUri;
    return { success: true, result: [...getProjection().objectTypes.values()].filter((t) => !ns || t.namespaceUri === ns) };
  });
  app.post(`${base}/objecttypes/query`, async (req, reply) => {
    const k = ids(req, reply); if (!k) return reply;
    return bulk(k, (id) => getProjection().objectTypes.get(id), "Object type");
  });
  app.get(`${base}/relationshiptypes`, async (req) => {
    const ns = (req.query as { namespaceUri?: string }).namespaceUri;
    return { success: true, result: [...getProjection().relTypes.values()].filter((t) => !ns || t.namespaceUri === ns) };
  });
  app.post(`${base}/relationshiptypes/query`, async (req, reply) => {
    const k = ids(req, reply); if (!k) return reply;
    return bulk(k, (id) => getProjection().relTypes.get(id), "Relationship type");
  });

  // ---- objects
  app.get(`${base}/objects`, async (req) => {
    const q = req.query as { typeElementId?: string; includeMetadata?: string; root?: string };
    const meta = bool(q.includeMetadata), root = bool(q.root);
    const out = [...getProjection().objects.values()]
      .filter((o) => (!q.typeElementId || o.typeElementId === q.typeElementId) && (!root || o.parentId === null))
      .map((o) => obj(o, meta));
    return { success: true, result: out };
  });
  app.post(`${base}/objects/list`, async (req, reply) => {
    const k = ids(req, reply); if (!k) return reply;
    const meta = bool((req.body as { includeMetadata?: unknown }).includeMetadata);
    return bulk(k, (id) => { const o = getProjection().objects.get(id); return o && obj(o, meta); }, "Element");
  });
  app.post(`${base}/objects/related`, async (req, reply) => {
    const k = ids(req, reply); if (!k) return reply;
    const b = req.body as { relationshipType?: string | null; includeMetadata?: unknown };
    const meta = bool(b.includeMetadata);
    const p = getProjection();
    if (b.relationshipType && !p.relTypes.has(b.relationshipType)) return fail(reply, 400, `Unknown relationshipType: ${b.relationshipType}`);
    return bulk(k, (id) => {
      if (!p.objects.has(id)) return undefined;
      return (p.edges.get(id) ?? [])
        .filter((e) => !b.relationshipType || e.rel === b.relationshipType)
        .map((e) => ({ sourceRelationship: e.rel, object: obj(p.objects.get(e.target)!, meta) }));
    }, "Element");
  });

  // ---- query: current values and history (IG Query Methods)
  const depthOf = (req: FastifyRequest, reply: FastifyReply): number | null => {
    const d = (req.body as { maxDepth?: unknown } | undefined)?.maxDepth;
    if (d === undefined || d === null) return 1;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 0) { void fail(reply, 400, "`maxDepth` must be an integer ≥ 0 (0 = unbounded, 1 = no recursion)."); return null; }
    return d;
  };
  app.post(`${base}/objects/value`, async (req, reply) => {
    const k = ids(req, reply); if (!k) return reply;
    const d = depthOf(req, reply); if (d === null) return reply;
    const { items, truncated } = await values.current(k, d);
    const body = { success: items.every((r) => r.success), results: items };
    if (truncated) return reply.code(206).send({ ...body, responseDetail: { title: "Partial Content", status: 206, detail: "Composition truncated at the server limit; query the remaining elementIds directly." } });
    return body;
  });
  const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  app.post(`${base}/objects/history`, async (req, reply) => {
    const k = ids(req, reply); if (!k) return reply;
    const d = depthOf(req, reply); if (d === null) return reply;
    const b = req.body as { startTime?: unknown; endTime?: unknown };
    if (typeof b.startTime !== "string" || typeof b.endTime !== "string" || !RFC3339.test(b.startTime) || !RFC3339.test(b.endTime))
      return fail(reply, 400, "`startTime` and `endTime` are required RFC 3339 timestamps.");
    const start = new Date(b.startTime), end = new Date(b.endTime);
    if (start > end) return fail(reply, 400, "`startTime` must not be after `endTime`.");
    const items = await values.history(k, start, end, d);
    return { success: items.every((r) => r.success), results: items };
  });
  app.put(`${base}/objects/value`, async (req, reply) => {
    if (cfg.http.readOnly) return fail(reply, 501, "This deployment is read-only (GATEWAY_READ_ONLY): current-value writes are disabled.");
    const u = (req.body as { updates?: unknown } | undefined)?.updates;
    if (!Array.isArray(u) || !u.length) return fail(reply, 400, "Request body must contain a non-empty `updates` array.");
    const results = await values.write(u as never);
    return { success: results.every((r) => r.success), results };
  });
  app.put(`${base}/objects/history`, async (_req, reply) => fail(reply, 501, "Historical writes are not supported (the OPC UA server's history is read-only through this gateway)."));

  // ---- subscriptions (IG Subscribe Methods)
  const client = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const c = (req.body as { clientId?: unknown } | undefined)?.clientId;
    if (typeof c !== "string" || !c.trim()) { void fail(reply, 400, "`clientId` is required on every subscription request."); return null; }
    return c;
  };
  const subOf = (req: FastifyRequest, reply: FastifyReply) => {
    const c = client(req, reply); if (!c) return null;
    const id = (req.body as { subscriptionId?: unknown }).subscriptionId;
    if (typeof id !== "string") { void fail(reply, 400, "`subscriptionId` is required."); return null; }
    const s = subs.get(c, id);
    if (!s) { void fail(reply, 404, `Subscription not found: ${id}`); return null; }
    return s;
  };
  const subIds = (req: FastifyRequest, reply: FastifyReply): string[] | null => {
    const v = (req.body as { subscriptionIds?: unknown }).subscriptionIds;
    if (!Array.isArray(v) || !v.length || v.some((x) => typeof x !== "string")) { void fail(reply, 400, "`subscriptionIds` must be a non-empty array of strings."); return null; }
    return v as string[];
  };
  const notFoundSub = (id: string) => ({ success: false, subscriptionId: id, responseDetail: { title: "Not Found", status: 404, detail: `Subscription not found: ${id}` } });
  app.post(`${base}/subscriptions`, async (req, reply) => {
    const c = client(req, reply); if (!c) return reply;
    const dn = (req.body as { displayName?: unknown }).displayName;
    const s = subs.create(c, typeof dn === "string" ? dn : undefined);
    return { success: true, result: { clientId: c, subscriptionId: s.subscriptionId, displayName: s.displayName } };
  });
  app.post(`${base}/subscriptions/list`, async (req, reply) => {
    const c = client(req, reply); if (!c) return reply;
    const k = subIds(req, reply); if (!k) return reply;
    const results = k.map((id) => { const s = subs.get(c, id); return s ? { success: true, subscriptionId: id, result: subs.describe(s) } : notFoundSub(id); });
    return { success: results.every((r) => r.success), results };
  });
  app.post(`${base}/subscriptions/delete`, async (req, reply) => {
    const c = client(req, reply); if (!c) return reply;
    const k = subIds(req, reply); if (!k) return reply;
    const results = [];
    for (const id of k) { const s = subs.get(c, id); if (s) { await subs.delete(s); results.push({ success: true, subscriptionId: id, result: null }); } else results.push(notFoundSub(id)); }
    return { success: results.every((r) => r.success), results };
  });
  for (const op of ["register", "unregister"] as const) {
    app.post(`${base}/subscriptions/${op}`, async (req, reply) => {
      const s = subOf(req, reply); if (!s) return reply;
      const k = ids(req, reply); if (!k) return reply;
      const d = depthOf(req, reply); if (d === null) return reply;
      const results = op === "register" ? await subs.register(s, k, d) : await subs.unregister(s, k);
      return { success: results.every((r) => r.success), results };
    });
  }
  app.post(`${base}/subscriptions/sync`, async (req, reply) => {
    const s = subOf(req, reply); if (!s) return reply;
    const r = subs.sync(s, (req.body as { lastSequenceNumber?: unknown }).lastSequenceNumber);
    if (!r) return fail(reply, 400, "This subscription has an open stream; close the stream before calling /sync.");
    if (r.dropped) return reply.code(206).send({ success: true, result: r.result,
      responseDetail: { title: "Updates dropped due to queue overflow", status: 206, detail: `Updates were dropped from the subscription queue. The server limit is ${cfg.subscriptions.queueLimit} updates.` } });
    return { success: true, result: r.result };
  });
  app.post(`${base}/subscriptions/stream`, async (req, reply) => {
    const s = subOf(req, reply); if (!s) return reply;
    reply.hijack();
    subs.openStream(s, reply.raw);
  });
  return app;
}
