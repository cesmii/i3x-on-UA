/**
 * Headless simulation check (Phase 3 exit criterion): run the model for N simulated hours at full
 * speed and assert the conservation laws every simulated minute.
 *   npx tsx src/sim/check.ts [hours=8] [seed=42]
 */
import path from "node:path";
import { loadPlant } from "../../../factory/src/plant.js";
import { ROOT } from "../../../factory/src/lib/load.js";
import { PlantSim } from "./model.js";
import { ordersSpec } from "./orders.js";

const hours = Number(process.argv[2] ?? 8), seed = Number(process.argv[3] ?? 42);
const plant = loadPlant(path.join(ROOT, "factory/plant/line1.yaml"));
const lineSpecs = plant.areas.find((a) => a.id === "BottlingLine1")!.equipment.map((e) => ({ tag: e.tag, designSpeed: e.designSpeed! }));
const sim = new PlantSim(lineSpecs, seed, ordersSpec(plant));
const inv0 = sim.inventory;
sim.startLine();

const fails: string[] = [];
const fail = (msg: string) => { if (fails.length < 20) fails.push(`t=${(sim.t / 3600).toFixed(2)}h ${msg}`); };
const stateTime = new Map<string, Map<string, number>>();
const lastActual = new Map<string, number>();
let maxResidual = 0, sdBatches = 0, lastPhase = sim.sdPhase, backwashes = 0, lastBw = 0, co2Refills = 0, lastRefill = false;

for (let s = 0; s < hours * 3600; s++) {
  sim.step(1);
  for (const m of sim.line) {
    const st = stateTime.get(m.cfg.tag) ?? new Map();
    st.set(m.state, (st.get(m.state) ?? 0) + 1);
    stateTime.set(m.cfg.tag, st);
  }
  if (sim.sdPhase !== lastPhase && sim.sdPhase === "Transfer") sdBatches++;
  lastPhase = sim.sdPhase;
  if (sim.backwashLeft > lastBw) backwashes++;
  lastBw = sim.backwashLeft;
  if (sim.co2Refill && !lastRefill) co2Refills++;
  lastRefill = sim.co2Refill;

  if (s % 60 !== 59) continue;
  // 1. volume balance across the plant boundary
  const residual = sim.totIn - sim.totOut - (sim.inventory - inv0);
  maxResidual = Math.max(maxResidual, Math.abs(residual));
  if (Math.abs(residual) > 1e-6) fail(`volume balance off by ${residual.toExponential(2)} m³`);
  // 2. vessels within limits, no NaN
  for (const v of sim.vessels) if (!(v.v >= -1e-9 && v.v <= v.cap + 1e-9) || !Number.isFinite(v.density) || !Number.isFinite(v.temp)) fail(`${v.name} out of range: v=${v.v} d=${v.density} T=${v.temp}`);
  // 3. unit conservation along the line: good out of i == taken by i+1 + waiting in accumulation i
  for (let i = 0; i < sim.line.length - 1; i++) {
    const up = sim.line[i], dn = sim.line[i + 1];
    if (up.processed !== dn.consumed + sim.acc[i]) fail(`${up.cfg.tag}→${dn.cfg.tag}: ${up.processed} ≠ ${dn.consumed} + ${sim.acc[i]}`);
    if (sim.acc[i] < 0 || sim.acc[i] > sim.accCap[i]) fail(`accumulation ${i} = ${sim.acc[i]} outside [0, ${sim.accCap[i]}]`);
  }
  // 4. inside each machine: consumed − rejects == outputs × unitsPerOutput + in process
  for (const m of sim.line) if (m.consumed - m.defective !== m.processed * m.cfg.unitsPerOutput + m.inProcess) fail(`${m.cfg.tag}: unit balance broken`);
  // 5. readings are finite
  const r = sim.readings();
  for (const [k, v] of r) if (typeof v === "number" && !Number.isFinite(v)) fail(`reading ${k} = ${v}`);
  // 6. orders: exactly one work request running; job actuals within [0, planned] and never decreasing
  //    while it runs; a finished-goods lot holds exactly what its packing job counted
  const book = sim.orders!;
  const running = book.wrs.filter((w) => w.state === "Running");
  if (running.length !== 1) fail(`${running.length} work requests running`);
  for (const w of book.wrs) for (const j of w.jobs) {
    if (j.actual < 0 || j.actual > j.spec.planned) fail(`${j.spec.id}: actual ${j.actual} outside [0, ${j.spec.planned}]`);
    const key = `${w.spec.id}/${j.spec.id}`;
    if (w.state === "Running" && j.actual < (lastActual.get(key) ?? 0) - 1e-9) fail(`${j.spec.id}: actual went down`);
    lastActual.set(key, w.state === "Running" ? j.actual : 0);
    if (j.spec.measure === "pack") for (const lot of j.spec.produces)
      if (r.get(`Lot/${lot}/Quantity`) !== Math.floor(j.actual)) fail(`lot ${lot}: quantity ${r.get(`Lot/${lot}/Quantity`)} ≠ ${j.spec.id} ${Math.floor(j.actual)}`);
  }
}

const [FL, , , CK, PZ] = sim.line;
console.log(`simulated ${hours} h (seed ${seed})`);
console.log(`  volume balance: max residual ${maxResidual.toExponential(2)} m³ · in ${sim.totIn.toFixed(1)} m³ · out ${sim.totOut.toFixed(1)} m³`);
console.log(`  filler: ${FL.processed.toLocaleString()} good bottles (${Math.round(FL.processed / hours).toLocaleString()}/h vs 24,000 design), ${FL.defective} rejects`);
console.log(`  case packer: ${CK.processed.toLocaleString()} cases · palletizer: ${PZ.processed} pallets · in accumulation: ${sim.acc.join(" / ")}`);
console.log(`  syrup batches: ${sdBatches} · filter backwashes: ${backwashes} · CO₂ refills: ${co2Refills} · CO₂ now ${sim.co2Pct.toFixed(1)} %`);
const wr = sim.orders?.active;
console.log(`  orders: ${sim.orders?.completed ?? 0} work requests completed · running ${wr?.spec.id ?? "none"}: ${wr?.jobs.map((j) => `${j.spec.id} ${j.state} ${+j.actual.toFixed(1)}/${j.spec.planned}`).join(", ")}`);
console.log(`  levels now: ${sim.vessels.map((v) => `${v.name} ${Math.round((v.v / v.cap) * 100)}%`).join(", ")}`);
for (const [tag, st] of stateTime) {
  const total = [...st.values()].reduce((a, b) => a + b, 0);
  const pct = (k: string) => (((st.get(k) ?? 0) / total) * 100).toFixed(1);
  console.log(`  ${tag}: Execute ${pct("Execute")}% · Held ${pct("Held")}% · Suspended ${pct("Suspended")}% · other ${(100 - +pct("Execute") - +pct("Held") - +pct("Suspended")).toFixed(1)}%`);
}
for (const f of fails) console.log(`  ❌ ${f}`);
console.log(fails.length ? `FAILED (${fails.length}${fails.length === 20 ? "+" : ""} problems)` : "all invariants held ✅");
process.exitCode = fails.length ? 1 : 0;
