/** Gateway configuration: gateway.config.yaml (or GATEWAY_CONFIG) + environment overrides. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface Interpretation {
  includeCoreInfrastructure: boolean;
  typeIds: "short" | "nsu";
  schemaInheritance: "resolved" | "allOf";
  int64: "string" | "number";
  enums: "number" | "name";
  relationshipsShape: "arrays" | "mixed";
  infoEnvelope: "wrapped" | "bare";
  synthesizeFlow: boolean;
  quality: "detailed" | "base";
  componentsShape: "flat" | "nested";
}
export interface Config {
  opcua: { endpoint: string };
  http: { port: number; host: string; basePath: string; serverName: string };
  subscriptions: { ttlSeconds: number; queueLimit: number; samplingMs: number };
  interpretation: Interpretation;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const GATEWAY_VERSION = "0.5.0";

export function loadConfig(): Config {
  const file = process.env.GATEWAY_CONFIG ?? path.join(here, "../gateway.config.yaml");
  const c = parse(fs.readFileSync(file, "utf8")) as Config;
  const env = process.env;
  if (env.OPCUA_ENDPOINT) c.opcua.endpoint = env.OPCUA_ENDPOINT;
  if (env.GATEWAY_PORT) c.http.port = Number(env.GATEWAY_PORT);
  if (env.GATEWAY_HOST) c.http.host = env.GATEWAY_HOST;
  if (env.GATEWAY_BASE_PATH !== undefined) c.http.basePath = env.GATEWAY_BASE_PATH;
  c.http.basePath = (c.http.basePath ?? "").replace(/\/+$/, "");
  // interpretation switches: I3X_<KEY>=value, e.g. I3X_ENUMS=name
  for (const k of Object.keys(c.interpretation) as Array<keyof Interpretation>) {
    const v = env[`I3X_${k.replace(/[A-Z]/g, (m) => "_" + m).toUpperCase()}`];
    if (v !== undefined) (c.interpretation as any)[k] = typeof c.interpretation[k] === "boolean" ? v === "true" : v;
  }
  return c;
}
