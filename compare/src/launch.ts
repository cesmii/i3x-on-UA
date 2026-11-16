/**
 * Gateway switch launcher (decision D9). Config: compare/gateways.yaml.
 *   npm run compare [-- up]        start plant + enabled gateways + front door (:8084); Ctrl-C stops what it started
 *   npm run compare -- status      health and address-space counts per gateway (needs them running)
 *   npm run compare -- conformance i3X conformance suite against each gateway, side by side
 * Each gateway is an opaque backend: a local process or an unmodified upstream container.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CONFIG = path.join(ROOT, "compare/gateways.yaml");
const LOGS = path.join(ROOT, "compare/logs");

interface Gateway {
  enabled: boolean; label: string; docs?: string; kind: "process" | "docker"; port: number; env?: Record<string, string>;
  command?: string; image?: string; containerName?: string; containerPort?: number;
  /** Front door only: displayName → replacement in JSON responses, so Explorer windows are easy to tell apart. */
  relabel?: Record<string, string>;
}
interface Config {
  active: string; frontDoor: { port: number };
  opcua: { endpoint: string; containerEndpoint: string; start: string };
  conformance: { suite: string; timeoutMs: number };
  gateways: Record<string, Gateway>;
}

function loadConfig(): Config {
  const raw = parse(fs.readFileSync(CONFIG, "utf8")) as Config;
  const expand = (s: string) => s.replace(/\$\{opcua\.(\w+)\}/g, (_, k) => (raw.opcua as unknown as Record<string, string>)[k] ?? "").replace(/^~(?=\/)/, os.homedir());
  // ${opcua.*} and ${port} (the gateway's own port) are expanded in env values, so each port is set in one place
  for (const g of Object.values(raw.gateways)) for (const k of Object.keys(g.env ?? {})) g.env![k] = expand(String(g.env![k])).replace(/\$\{port\}/g, String(g.port));
  raw.conformance.suite = expand(raw.conformance.suite);
  if (process.env.FRONT_DOOR_PORT) raw.frontDoor.port = Number(process.env.FRONT_DOOR_PORT);   // per-host override (e.g. systemd)
  return raw;
}
/** Public deployment (COMPARE_READ_ONLY=1): the front door rejects PUT/DELETE/PATCH for every gateway and disables /_switch. */
const READ_ONLY = process.env.COMPARE_READ_ONLY === "1" || process.env.COMPARE_READ_ONLY === "true";
const url = (g: Gateway) => `http://localhost:${g.port}/v1`;
const log = (...a: unknown[]) => console.log(`[compare]`, ...a);

function portOpen(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
  });
}
async function getJson(u: string, timeoutMs = 5000): Promise<any> {
  const r = await fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`);
  return r.json();
}
async function waitHealthy(u: string, timeoutMs: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { await getJson(`${u}/info`, 3000); return Date.now() - t0; } catch { await new Promise((r) => setTimeout(r, 1000)); }
  }
  throw new Error(`${u}/info not healthy after ${timeoutMs / 1000}s`);
}
function dockerAvailable() { try { execFileSync("docker", ["info", "--format", "{{.ServerVersion}}"], { stdio: "pipe" }); return true; } catch { return false; } }

// ---------------------------------------------------------------- up
/**
 * Everything this launcher started. Stopping is two-phase so one Ctrl-C reliably stops it all:
 * `signal()` is instant (SIGTERM to a process group, or start `docker rm`), `done()` resolves once it's gone
 * (process groups that ignore SIGTERM are SIGKILLed after a grace period).
 */
const started: Array<{ name: string; signal: () => void; done: () => Promise<void> }> = [];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const groupAlive = (pgid: number) => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

function startProcess(name: string, command: string, env: Record<string, string> = {}): ChildProcess {
  fs.mkdirSync(LOGS, { recursive: true });
  const out = fs.openSync(path.join(LOGS, `${name}.log`), "w");
  // own process group (detached), so the launcher can stop the whole tree: shell, node and anything they spawn
  const child = spawn(command, { cwd: ROOT, shell: true, detached: true, stdio: ["ignore", out, out], env: { ...process.env, ...env } });
  const pgid = child.pid!;
  started.push({
    name,
    signal: () => { try { process.kill(-pgid, "SIGTERM"); } catch { /* gone */ } },
    done: async () => {
      for (let i = 0; i < 30 && groupAlive(pgid); i++) await sleep(200);           // 6 s grace
      if (groupAlive(pgid)) { log(`${name} did not stop in 6 s; killing it`); try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
    },
  });
  child.on("exit", (code) => code && !stopping && log(`${name} exited with ${code}; see compare/logs/${name}.log`));
  return child;
}

let stopping = false;
/** Ctrl-C / SIGTERM / SIGHUP: stop everything this launcher started, once, however many signals arrive. */
function installStop(onStopped: () => void = () => undefined) {
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log("stopping…");
    for (const s of [...started].reverse()) s.signal();
    await Promise.all(started.map((s) => s.done()));
    onStopped();
    log("stopped");
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => void stop());
}
function startDocker(name: string, g: Gateway) {
  const cname = g.containerName ?? `i3x-compare-${name}`;
  execFileSync("docker", ["rm", "-f", cname], { stdio: "ignore" });
  const args = ["run", "-d", "--name", cname, "-p", `127.0.0.1:${g.port}:${g.containerPort ?? 8000}`, "--add-host", "host.docker.internal:host-gateway"];
  for (const [k, v] of Object.entries(g.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(g.image!);
  log(`${name}: docker ${args.slice(0, 4).join(" ")} … ${g.image}`);
  execFileSync("docker", args, { stdio: "pipe" });
  // container logs → compare/logs/<name>.log
  fs.mkdirSync(LOGS, { recursive: true });
  const out = fs.openSync(path.join(LOGS, `${name}.log`), "w");
  const tail = spawn("docker", ["logs", "-f", cname], { stdio: ["ignore", out, out] });
  let rm: ChildProcess | undefined;
  started.push({
    name,
    signal: () => { tail.kill(); rm = spawn("docker", ["rm", "-f", cname], { stdio: "ignore" }); },
    done: () => new Promise<void>((resolve) => { if (!rm || rm.exitCode !== null) return resolve(); rm.on("exit", () => resolve()); setTimeout(resolve, 15_000); }),
  });
}

async function up() {
  let cfg = loadConfig();
  if (await portOpen(cfg.frontDoor.port)) {
    console.error(`[compare] the front door port :${cfg.frontDoor.port} is already in use (another launcher running?). Stop it, or change frontDoor.port in compare/gateways.yaml (or set FRONT_DOOR_PORT).`);
    process.exit(1);
  }
  let frontDoor: http.Server | undefined;
  installStop(() => frontDoor?.close());   // before starting anything, so Ctrl-C during start-up cleans up too
  // 1. the plant
  const opcPort = Number(new URL(cfg.opcua.endpoint.replace(/^opc\.tcp/, "http")).port || 4840);
  if (await portOpen(opcPort)) log(`OPC UA server already listening on :${opcPort}; using it (not managed by this launcher)`);
  else {
    log(`starting OPC UA server: ${cfg.opcua.start}`);
    startProcess("opcua-server", cfg.opcua.start);
    for (let i = 0; i < 60 && !(await portOpen(opcPort)); i++) await new Promise((r) => setTimeout(r, 500));
  }
  // 2. gateways
  const ready: Record<string, string> = {};
  for (const [name, g] of Object.entries(cfg.gateways)) {
    if (!g.enabled) { ready[name] = "disabled"; continue; }
    if (await portOpen(g.port)) { log(`${name}: something already listens on :${g.port}; using it as-is (not managed)`); }
    else if (g.kind === "process") startProcess(name, g.command!, g.env);
    else if (g.kind === "docker") {
      if (!dockerAvailable()) { log(`${name}: Docker is not running; start Docker Desktop and re-run to include it`); ready[name] = "docker not running"; continue; }
      try { startDocker(name, g); } catch (e) { log(`${name}: docker run failed: ${(e as Error).message.split("\n")[0]}`); ready[name] = "failed to start"; continue; }
    }
    try { const ms = await waitHealthy(url(g), 240_000); ready[name] = `ready in ${(ms / 1000).toFixed(1)} s`; }
    catch (e) { ready[name] = (e as Error).message; }
    log(`${name}: ${ready[name]} → ${url(g)}`);
  }
  // 3. front door
  const server = (frontDoor = http.createServer((req, res) => route(req, res, cfg, ready)));
  server.listen(cfg.frontDoor.port, () => {
    log(`front door http://localhost:${cfg.frontDoor.port}/v1 → active "${cfg.active}"   (${Object.keys(cfg.gateways).map((n) => `/${n}/v1`).join(", ")} always direct)`);
    if (READ_ONLY) log("read-only (COMPARE_READ_ONLY): PUT/DELETE/PATCH and /_switch are refused");
    log("edit compare/gateways.yaml `active:` to switch live; Ctrl-C stops everything this launcher started");
  });
  // poll mtime: editors (and sed -i) replace the file, which breaks fs.watch on macOS after the first save
  fs.watchFile(CONFIG, { interval: 500 }, () => {
    try {
      const next = loadConfig();
      if (next.active !== cfg.active) {
        if (!next.gateways[next.active]) { log(`ignoring active: "${next.active}" (no such gateway)`); return; }
        log(`active gateway: ${cfg.active} → ${next.active}`);
      }
      cfg = { ...cfg, active: next.active };
    } catch (e) { log(`config not reloaded: ${(e as Error).message}`); }
  });
}

function route(req: http.IncomingMessage, res: http.ServerResponse, cfg: Config, ready: Record<string, string>) {
  const u = req.url ?? "/";
  if (u === "/" || u === "/_status") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ active: cfg.active, frontDoor: `/v1 → ${cfg.active}`, gateways: Object.fromEntries(Object.entries(cfg.gateways).map(([n, g]) =>
      [n, { label: g.label, status: ready[n], direct: `/${n}/v1`, upstream: url(g), docs: g.docs }])) }, null, 2));
    return;
  }
  const sw = u.match(/^\/_switch\/([^/?]+)/);
  if (READ_ONLY && (sw || !["GET", "HEAD", "POST", "OPTIONS"].includes(req.method ?? ""))) {
    res.writeHead(sw ? 403 : 501, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, responseDetail: sw
      ? { title: "Forbidden", status: 403, detail: "Switching the active gateway is disabled on this read-only deployment." }
      : { title: "Not Implemented", status: 501, detail: "This deployment is read-only: writes are disabled for every gateway." } }));
    return;
  }
  if (sw) {
    const ok = !!cfg.gateways[sw[1]];
    if (ok) { log(`active gateway (runtime, not saved): ${cfg.active} → ${sw[1]}`); cfg.active = sw[1]; }
    res.writeHead(ok ? 200 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ active: cfg.active }));
    return;
  }
  const m = u.match(/^\/([^/]+)(\/v1(?:\/.*)?)$/);
  const name = m && cfg.gateways[m[1]] ? m[1] : cfg.active;
  const pathOut = m && cfg.gateways[m[1]] ? m[2] : u;
  const g = cfg.gateways[name];
  const up = http.request({ host: "127.0.0.1", port: g.port, method: req.method, path: pathOut,
    headers: { ...req.headers, host: `localhost:${g.port}`, "x-forwarded-host": req.headers.host ?? "", "x-forwarded-prefix": m ? `/${m[1]}` : "", "x-i3x-gateway": name } },
  (r) => {
    const json = String(r.headers["content-type"] ?? "").includes("application/json");
    if (!g.relabel || !json) { res.writeHead(r.statusCode ?? 502, { ...r.headers, "x-i3x-gateway": name }); r.pipe(res); return; }
    relabelBody(r, res, g.relabel, req.headers["accept-encoding"], name);
  });
  up.on("error", (e) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ success: false, responseDetail: { title: "Bad Gateway", status: 502, detail: `gateway "${name}" (${url(g)}) unreachable: ${e.message}` } }));
  });
  req.pipe(up);
  res.on("close", () => up.destroy());
}

/**
 * Cosmetic relabel (gateways.yaml `relabel:`): rewrite matching `displayName` values in a JSON response so three
 * Explorer windows are easy to tell apart. Applied the same way to every gateway, only on the front door;
 * the gateways' own ports are untouched. Marked with an `x-i3x-relabeled` header.
 */
function relabelBody(r: http.IncomingMessage, res: http.ServerResponse, map: Record<string, string>, acceptEncoding: string | string[] | undefined, name: string) {
  const chunks: Buffer[] = [];
  r.on("data", (c: Buffer) => chunks.push(c));
  r.on("end", () => {
    const original = Buffer.concat(chunks);
    const enc = String(r.headers["content-encoding"] ?? "");
    let buf: Buffer;
    try {
      const plain = enc === "gzip" ? zlib.gunzipSync(original) : enc === "deflate" ? zlib.inflateSync(original) : enc === "br" ? zlib.brotliDecompressSync(original) : original;
      const walk = (v: unknown): unknown => {
        if (Array.isArray(v)) return v.map(walk);
        if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) =>
          [k, k === "displayName" && typeof x === "string" && x in map ? map[x] : walk(x)]));
        return v;
      };
      buf = Buffer.from(JSON.stringify(walk(JSON.parse(plain.toString("utf8")))));
    } catch {                                   // not JSON after all: pass through unchanged
      res.writeHead(r.statusCode ?? 502, { ...r.headers, "x-i3x-gateway": name });
      res.end(original);
      return;
    }
    const headers: http.OutgoingHttpHeaders = { ...r.headers, "x-i3x-gateway": name, "x-i3x-relabeled": "1" };
    delete headers["content-length"]; delete headers["content-encoding"]; delete headers["transfer-encoding"];
    if (/\bgzip\b/.test(String(acceptEncoding ?? ""))) { buf = zlib.gzipSync(buf); headers["content-encoding"] = "gzip"; }   // IG: gzip when asked
    headers["content-length"] = buf.length;
    res.writeHead(r.statusCode ?? 502, headers);
    res.end(buf);
  });
}

// ---------------------------------------------------------------- status
async function status() {
  const cfg = loadConfig();
  const rows: string[][] = [["", ...Object.keys(cfg.gateways)]];
  const cols = await Promise.all(Object.entries(cfg.gateways).map(async ([, g]) => {
    try {
      const t0 = Date.now();
      const info = await getJson(`${url(g)}/info`);
      const i = info.result ?? info;
      const [ns, ot, rt, objs, roots] = await Promise.all(["namespaces", "objecttypes", "relationshiptypes", "objects", "objects?root=true"].map((p) => getJson(`${url(g)}/${p}`, 120_000)));
      return [`${i.serverName ?? "?"} ${i.serverVersion ?? ""}`, `${i.specVersion}`, JSON.stringify(i.capabilities),
        String(ns.result.length), String(ot.result.length), String(rt.result.length), String(objs.result.length),
        roots.result.map((o: { displayName: string }) => o.displayName).join(", ").slice(0, 60), `${Date.now() - t0} ms`];
    } catch (e) { return [`unavailable: ${(e as Error).message}`, "", "", "", "", "", "", "", ""]; }
  }));
  const labels = ["server", "specVersion", "capabilities", "namespaces", "objectTypes", "relationshipTypes", "objects", "roots", "time (all calls)"];
  labels.forEach((l, i) => rows.push([l, ...cols.map((c) => c[i])]));
  for (const r of rows) console.log(r.map((c, i) => (i === 0 ? c.padEnd(18) : c.padEnd(48))).join(" "));
}

// ---------------------------------------------------------------- conformance
async function conformance() {
  const cfg = loadConfig();
  const cli = path.join(cfg.conformance.suite, "bin/i3x-test.js");
  if (!fs.existsSync(cli)) throw new Error(`conformance suite not found at ${cli}`);
  fs.mkdirSync(LOGS, { recursive: true });
  const summary: Record<string, { verdict: string; passed: number; failed: number; skipped: number; failures: string[] }> = {};
  for (const [name, g] of Object.entries(cfg.gateways)) {
    if (!g.enabled) continue;
    const json = path.join(LOGS, `conformance-${name}.json`);
    log(`conformance: ${name} (${url(g)})…`);
    try {
      execFileSync(process.execPath, [cli, "run", url(g), "--json", json, "--quiet", "--timeout", String(cfg.conformance.timeoutMs)], { cwd: cfg.conformance.suite, stdio: "pipe", timeout: 15 * 60_000 });
    } catch { /* non-zero exit on failures; the JSON report is still written */ }
    if (!fs.existsSync(json)) { summary[name] = { verdict: "no report (gateway unreachable?)", passed: 0, failed: 0, skipped: 0, failures: [] }; continue; }
    const rep = JSON.parse(fs.readFileSync(json, "utf8"));
    const results: Array<{ id: string; status: string }> = rep.results ?? rep.tests ?? [];
    const count = (s: string) => results.filter((r) => r.status === s).length;
    summary[name] = { verdict: rep.verdict?.label ?? rep.verdict ?? rep.summary?.verdict ?? "?", passed: count("pass"), failed: count("fail"), skipped: count("skip"),
      failures: results.filter((r) => r.status === "fail").map((r) => r.id) };
  }
  console.log("\n" + ["", ...Object.keys(summary)].map((c) => c.padEnd(34)).join(""));
  for (const k of ["verdict", "passed", "failed", "skipped", "failures"] as const) {
    console.log([k, ...Object.values(summary).map((s) => (Array.isArray(s[k]) ? (s[k] as string[]).join(" ") || "—" : String(s[k])))].map((c) => c.padEnd(34)).join(""));
  }
  console.log(`\nfull reports: compare/logs/conformance-<name>.json`);
}

const cmd = process.argv[2] ?? "up";
const run = { up, status, conformance }[cmd as "up"];
if (!run) { console.error(`unknown command ${cmd} (up | status | conformance)`); process.exit(2); }
await run();
