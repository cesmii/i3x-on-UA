/**
 * OPC UA → i3X gateway ("cesmii", the CESMII interpretation; docs/gateway/MAPPING.md).
 *   npm start -w gateway            config: gateway/gateway.config.yaml (+ env overrides, see config.ts)
 */
import { OPCUAClient } from "node-opcua";
import { loadConfig } from "./config.js";
import { Crawler } from "./ua/crawl.js";
import { project, type Projection } from "./i3x/project.js";
import { buildServer } from "./http/server.js";
import { ValueService } from "./i3x/values.js";
import { Subscriptions } from "./i3x/subs.js";

const cfg = loadConfig();
const client = OPCUAClient.create({
  applicationName: "i3X-on-OPC gateway (CESMII)", endpointMustExist: false,
  connectionStrategy: { maxRetry: 1_000_000, initialDelay: 1000, maxDelay: 10_000 },
});
client.on("connection_lost", () => console.warn("opcua: connection lost, reconnecting…"));
client.on("connection_reestablished", () => console.log("opcua: connection re-established"));

console.log(`opcua: connecting to ${cfg.opcua.endpoint}`);
await client.connect(cfg.opcua.endpoint);
const session = await client.createSession();

const crawler = new Crawler(session, { includeCoreInfrastructure: cfg.interpretation.includeCoreInfrastructure });
const model = await crawler.crawl();
const t0 = Date.now();
const projection: Projection = await project(model, crawler, cfg.interpretation);
console.log(`crawl ${model.crawlMs} ms (${model.nodes.size} nodes, ${model.types.size} types) · projection ${Date.now() - t0} ms ·`, projection.stats);

const values = new ValueService(projection, crawler, model, cfg.interpretation);
const subs = new Subscriptions(session, crawler, projection, values, cfg.subscriptions);
const app = await buildServer(cfg, () => projection, values, subs);
await app.listen({ port: cfg.http.port, host: cfg.http.host });
console.log(`i3X gateway (cesmii) listening on http://${cfg.http.host}:${cfg.http.port}${cfg.http.basePath}/v1 · interpretation:`, cfg.interpretation);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 4000).unref();   // hard deadline: the OPC UA server may be stopping at the same time
  await app.close().catch(() => undefined);
  await subs.close().catch(() => undefined);
  await session.close().catch(() => undefined);
  await client.disconnect().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
