/**
 * OPC UA server for the virtual beverage factory, with the Line 1 process simulation.
 *   npm start -w server            (opc.tcp://localhost:4840/UA/BeverageFactory)
 *
 * Environment:
 *   OPCUA_PORT      (4840)
 *   SIM_SPEED       simulated seconds per wall-clock second (1)
 *   SIM_SEED        PRNG seed (42)
 *   SIM_HISTORY     in-memory history depth per variable, in values (3600; 0 = off)
 *   SIM_FAULTS      quality overrides, e.g. "PT-902=BadNotConnected,FL-401/Status=UncertainLastUsableValue"
 *                   (key prefix = NodeId path; code = node-opcua StatusCodes name). Line 1 default: none.
 *
 * Local development: anonymous access and SecurityMode None are allowed; production sits behind
 * the deployment's own network controls (the i3X side is fronted by Nginx, decision D8).
 */
import path from "node:path";
import { MessageSecurityMode, OPCUACertificateManager, OPCUAServer, SecurityPolicy, StatusCodes, type StatusCode } from "node-opcua";
import type { AddressSpace } from "node-opcua-address-space";
import { BASE_NODESETS, ROOT } from "../../factory/src/lib/load.js";
import { loadPlant } from "../../factory/src/plant.js";
import { PlantSim } from "./sim/model.js";
import { UaBinder } from "./sim/bind.js";

const PORT = Number(process.env.OPCUA_PORT ?? 4840);
const SPEED = Math.max(1, Math.floor(Number(process.env.SIM_SPEED ?? 1)));
const SEED = Number(process.env.SIM_SEED ?? 42);
const HISTORY = Number(process.env.SIM_HISTORY ?? 3600);
const FACTORY = path.join(ROOT, "nodesets/factory/BeverageFactory.NodeSet2.xml");

const faults: Array<[string, StatusCode]> = (process.env.SIM_FAULTS ?? "").split(",").filter(Boolean).map((f) => {
  const [prefix, code] = f.split("=");
  const sc = (StatusCodes as unknown as Record<string, StatusCode>)[code];
  if (!sc) throw new Error(`SIM_FAULTS: unknown StatusCode ${code}`);
  return [prefix, sc];
});

const plant = loadPlant(path.join(ROOT, "factory/plant/line1.yaml"));
const serverCertificateManager = new OPCUACertificateManager({ rootFolder: path.join(ROOT, "server/pki"), automaticallyAcceptUnknownCertificate: true });
const server = new OPCUAServer({
  port: PORT,
  resourcePath: "/UA/BeverageFactory",
  nodesets: [...BASE_NODESETS, FACTORY],
  serverCertificateManager,
  buildInfo: { productName: "i3X-on-OPC Virtual Beverage Factory", manufacturerName: "CESMII i3X WG (demo)", softwareVersion: "0.3.0" },
  serverInfo: { applicationName: { text: "Virtual Beverage Factory" }, applicationUri: "urn:cesmii:i3x-demo:beverage-factory", productUri: "urn:cesmii:i3x-demo:beverage-factory" },
  allowAnonymous: true,
  securityModes: [MessageSecurityMode.None, MessageSecurityMode.Sign, MessageSecurityMode.SignAndEncrypt],
  securityPolicies: [SecurityPolicy.None, SecurityPolicy.Basic256Sha256],
});

const t0 = Date.now();
await server.initialize();

// ---- simulation
const as = server.engine.addressSpace as unknown as AddressSpace;
const lineSpecs = plant.areas.find((a) => a.id === "BottlingLine1")!.equipment.map((e) => ({ tag: e.tag, designSpeed: e.designSpeed! }));
const sim = new PlantSim(lineSpecs, SEED);
const binder = new UaBinder(as, plant.namespace, { historyValues: HISTORY });
const quality = (key: string) => faults.find(([p]) => key === p || key.startsWith(`${p}/`))?.[1];
binder.write(sim.readings(), new Date(), quality);
if (binder.missing.size) console.warn(`sim: ${binder.missing.size} readings have no node, e.g. ${[...binder.missing].slice(0, 5).join(", ")}`);
setTimeout(() => sim.startLine(), 3000);
const timer = setInterval(() => {
  for (let i = 0; i < SPEED; i++) sim.step(1);
  binder.write(sim.readings(), new Date(), quality);
}, 1000);

await server.start();
console.log(`OPC UA server up in ${Date.now() - t0} ms: ${server.getEndpointUrl()} · sim speed ×${SPEED}, seed ${SEED}, history ${HISTORY} values/variable${faults.length ? ` · faults: ${faults.map(([p, c]) => `${p}=${c.name}`).join(", ")}` : ""}`);
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => process.exit(0), 4000).unref();   // hard deadline: a hanging session must not keep the server alive
  clearInterval(timer);
  await server.shutdown(1000);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
