/**
 * i3X subscriptions on OPC UA MonitoredItems (IG "Subscribe Methods").
 * - One OPC UA Subscription for the gateway; MonitoredItems are reference-counted across i3X subscriptions.
 * - Registering with maxDepth N watches the Object and its composition descendants to depth N; each element
 *   reports its own updates (flattened, like `components`). [ours]
 * - Sync: unbatched updates get the next sequenceNumber at /sync; batches stay until acknowledged.
 * - Stream: SSE, at-most-once; opening flushes the queue; one stream per subscription.
 */
import { randomBytes } from "node:crypto";
import type { ServerResponse } from "node:http";
import { AttributeIds, ClientMonitoredItem, ClientSubscription, TimestampsToReturn, type ClientSession, type DataValue } from "node-opcua";
import type { Crawler } from "../ua/crawl.js";
import type { Projection } from "./project.js";
import type { ValueService, VQT } from "./values.js";

export interface Update extends VQT { elementId: string }
interface Batch { sequenceNumber: number; updates: Update[] }
export interface Sub {
  subscriptionId: string; clientId: string; displayName: string;
  registrations: Map<string, number>; watch: Set<string>;
  pending: Update[]; batches: Batch[]; seq: number; dropped: boolean; lastActivity: number;
  stream?: { res: ServerResponse; ping: NodeJS.Timeout };
}

export class Subscriptions {
  readonly subs = new Map<string, Sub>();
  private readonly watchers = new Map<string, Set<string>>();          // elementId → subscriptionIds
  private readonly nodeToElements = new Map<string, Set<string>>();    // OPC UA node → elementIds whose value it feeds
  private readonly cache = new Map<string, DataValue>();
  private readonly items = new Map<string, { mi: ClientMonitoredItem; refs: number }>();
  private opc?: ClientSubscription;
  private readonly sweeper: NodeJS.Timeout;

  constructor(private readonly session: ClientSession, private readonly c: Crawler, private readonly p: Projection, private readonly v: ValueService,
    private readonly cfg: { ttlSeconds: number; queueLimit: number; samplingMs: number }) {
    for (const [el, src] of p.values) for (const n of src.kind === "leaf" ? [src.node] : src.props.map((x) => x.node)) {
      (this.nodeToElements.get(n) ?? this.nodeToElements.set(n, new Set()).get(n)!).add(el);
    }
    this.sweeper = setInterval(() => this.sweep(), 15_000);
  }

  // ---------- lifecycle ----------
  create(clientId: string, displayName?: string) {
    const sub: Sub = { subscriptionId: randomBytes(24).toString("base64url"), clientId, displayName: displayName ?? "", registrations: new Map(), watch: new Set(),
      pending: [], batches: [], seq: 0, dropped: false, lastActivity: Date.now() };
    this.subs.set(sub.subscriptionId, sub);
    return sub;
  }
  /** A subscription owned by another client is indistinguishable from a missing one (IG). */
  get(clientId: string, id: string) { const s = this.subs.get(id); return s && s.clientId === clientId ? s : undefined; }
  describe(s: Sub) { return { subscriptionId: s.subscriptionId, displayName: s.displayName, monitoredObjects: [...s.registrations].map(([elementId, maxDepth]) => ({ elementId, maxDepth })) }; }
  async delete(s: Sub) {
    this.closeStream(s);
    const nodes = this.nodesOf([...s.watch]);
    for (const el of s.watch) this.watchers.get(el)?.delete(s.subscriptionId);
    this.subs.delete(s.subscriptionId);
    await this.release(nodes);
  }
  private sweep() {
    const now = Date.now();
    for (const s of [...this.subs.values()]) if (!s.stream && now - s.lastActivity > this.cfg.ttlSeconds * 1000) void this.delete(s);
  }
  async close() { clearInterval(this.sweeper); for (const s of [...this.subs.values()]) await this.delete(s); await this.opc?.terminate(); }

  // ---------- register / unregister ----------
  async register(s: Sub, ids: string[], maxDepth: number) {
    const results = ids.map((id) => this.p.objects.has(id)
      ? { success: true, elementId: id, result: null }
      : { success: false, elementId: id, responseDetail: { title: "Not Found", status: 404, detail: `Element not found: ${id}` } });
    for (const id of ids) if (this.p.objects.has(id) && !s.registrations.has(id)) s.registrations.set(id, maxDepth);   // re-registration: success, ignored (IG)
    await this.rewatch(s);
    s.lastActivity = Date.now();
    return results;
  }
  async unregister(s: Sub, ids: string[]) {
    const results = ids.map((id) => s.registrations.has(id) || this.p.objects.has(id)
      ? { success: true, elementId: id, result: null }
      : { success: false, elementId: id, responseDetail: { title: "Not Found", status: 404, detail: `Element not found: ${id}` } });
    for (const id of ids) s.registrations.delete(id);   // queued values stay (IG: SHOULD NOT delete prior queued values)
    await this.rewatch(s);
    s.lastActivity = Date.now();
    return results;
  }
  private async rewatch(s: Sub) {
    const want = new Set<string>();
    for (const [id, d] of s.registrations) { want.add(id); for (const x of this.v.descendants(id, d)) want.add(x); }
    const added = [...want].filter((x) => !s.watch.has(x)), removed = [...s.watch].filter((x) => !want.has(x));
    for (const el of removed) this.watchers.get(el)?.delete(s.subscriptionId);
    for (const el of added) (this.watchers.get(el) ?? this.watchers.set(el, new Set()).get(el)!).add(s.subscriptionId);
    s.watch = want;
    await this.release(this.nodesOf(removed));
    const fresh = await this.acquire(this.nodesOf(added));
    // elements whose nodes were already monitored won't get an initial notification: queue the cached value now
    for (const el of added) {
      const nodes = this.nodesOf([el]);
      if (nodes.length && nodes.every((n) => this.cache.has(n)) && !nodes.some((n) => fresh.has(n))) this.push(s, { elementId: el, ...this.v.vqtOf(el, this.cache) });
      if (!nodes.length) this.push(s, { elementId: el, ...this.v.vqtOf(el, this.cache) });   // branch without properties: {}
    }
  }
  private nodesOf(els: string[]) {
    const out = new Set<string>();
    for (const el of els) { const src = this.p.values.get(el); if (!src) continue; for (const n of src.kind === "leaf" ? [src.node] : src.props.map((x) => x.node)) out.add(n); }
    return [...out];
  }

  // ---------- OPC UA monitored items ----------
  private async acquire(nodes: string[]) {
    const fresh = new Set<string>();
    if (!nodes.length) return fresh;
    this.opc ??= ClientSubscription.create(this.session, { requestedPublishingInterval: this.cfg.samplingMs, requestedLifetimeCount: 600, requestedMaxKeepAliveCount: 20,
      maxNotificationsPerPublish: 0, publishingEnabled: true, priority: 10 });
    const todo = nodes.filter((n) => { const it = this.items.get(n); if (it) { it.refs++; return false; } return true; });
    for (let i = 0; i < todo.length; i += 100) {
      await Promise.all(todo.slice(i, i + 100).map(async (n) => {
        const mi = ClientMonitoredItem.create(this.opc!, { nodeId: this.c.nodeId(n), attributeId: AttributeIds.Value },
          { samplingInterval: this.cfg.samplingMs, discardOldest: true, queueSize: 10 }, TimestampsToReturn.Both);
        this.items.set(n, { mi, refs: 1 });
        fresh.add(n);
        mi.on("changed", (dv: DataValue) => this.onChange(n, dv));
        await new Promise<void>((resolve) => { mi.once("initialized", () => resolve()); mi.once("err", () => resolve()); });
      }));
    }
    return fresh;
  }
  private async release(nodes: string[]) {
    for (const n of nodes) {
      const it = this.items.get(n);
      if (!it) continue;
      if (--it.refs > 0) continue;
      this.items.delete(n);
      this.cache.delete(n);
      await it.mi.terminate().catch(() => undefined);
    }
  }
  private onChange(node: string, dv: DataValue) {
    this.cache.set(node, dv);
    for (const el of this.nodeToElements.get(node) ?? []) {
      const subs = this.watchers.get(el);
      if (!subs?.size) continue;
      const u: Update = { elementId: el, ...this.v.vqtOf(el, this.cache) };
      for (const id of subs) { const s = this.subs.get(id); if (s) this.push(s, u); }
    }
  }

  // ---------- delivery ----------
  private push(s: Sub, u: Update) {
    if (s.stream) { this.send(s, [u]); return; }
    s.pending.push(u);
    let total = s.pending.length + s.batches.reduce((a, b) => a + b.updates.length, 0);
    while (total > this.cfg.queueLimit) {   // drop the oldest first (IG)
      s.dropped = true;
      if (s.batches.length) { s.batches[0].updates.shift(); if (!s.batches[0].updates.length) s.batches.shift(); }
      else s.pending.shift();
      total--;
    }
  }
  /** POST /subscriptions/sync. Returns null when a stream is open (caller answers with an error). */
  sync(s: Sub, last: unknown): { result: Batch[]; dropped: boolean } | null {
    if (s.stream) return null;
    s.lastActivity = Date.now();
    if (last === -1) { s.batches = []; s.pending = []; }
    else if (typeof last === "number" && Number.isInteger(last) && last >= 0) s.batches = s.batches.filter((b) => b.sequenceNumber > last);
    if (s.pending.length) { s.batches.push({ sequenceNumber: ++s.seq, updates: s.pending }); s.pending = []; }
    const dropped = s.dropped;
    s.dropped = false;
    return { result: s.batches.map((b) => ({ ...b })), dropped };
  }
  /** POST /subscriptions/stream: replaces any open stream, flushes the queue. */
  openStream(s: Sub, res: ServerResponse) {
    this.closeStream(s);
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write(": i3X stream open\n\n");
    const ping = setInterval(() => res.write(": keep-alive\n\n"), 15_000);
    s.stream = { res, ping };
    s.lastActivity = Date.now();
    const queued = [...s.batches.flatMap((b) => b.updates), ...s.pending];
    s.batches = []; s.pending = [];
    if (queued.length) this.send(s, queued);
    res.on("close", () => { if (s.stream?.res === res) { clearInterval(ping); s.stream = undefined; s.lastActivity = Date.now(); } });
  }
  private send(s: Sub, updates: Update[]) {
    s.lastActivity = Date.now();
    s.stream!.res.write(`data: ${JSON.stringify(updates)}\n\n`);
  }
  private closeStream(s: Sub) {
    if (!s.stream) return;
    clearInterval(s.stream.ping);
    const res = s.stream.res;
    s.stream = undefined;
    res.end();
  }
}
