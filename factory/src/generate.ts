/**
 * plant YAML → OPC UA instance NodeSet.
 *   npm run generate -w factory [-- plant/line1.yaml]
 * Writes nodesets/factory/BeverageFactory.NodeSet2.xml.
 */
import fs from "node:fs";
import path from "node:path";
import { loadBase, ROOT } from "./lib/load.js";
import { loadPlant } from "./plant.js";
import { buildPlant } from "./build.js";

export const OUT = path.join(ROOT, "nodesets/factory/BeverageFactory.NodeSet2.xml");

const plantFile = path.resolve(process.argv[2] ?? path.join(ROOT, "factory/plant/line1.yaml"));
const plant = loadPlant(plantFile);
const as = await loadBase();
const t0 = Date.now();
const b = buildPlant(as, plant);
const xml = b.ns.toNodeset2XML();
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, xml);
const count = (xml.match(/<UA(Object|Variable|Method) /g) ?? []).length;
console.log(`built ${path.relative(ROOT, plantFile)} → ${path.relative(ROOT, OUT)}: ${count} nodes, ${(xml.length / 1024).toFixed(0)} KiB, ${Date.now() - t0} ms · variables read-only ${b.accessSummary.readOnly}, writable ${b.accessSummary.writable}`);
as.dispose();
