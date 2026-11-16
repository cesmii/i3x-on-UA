/**
 * Work requests, job orders and material lots in the simulation (PLANT_DESIGN.md §8, SIMULATION.md, "Orders and material lots").
 * Pure TypeScript; PlantSim feeds it the cumulative production counters and it emits readings keyed
 * by our NodeId paths (Orders/<WR>/<JO>/…, Lot/<id>/…).
 *
 * - One work request runs at a time; the others wait as AllowedToStart. Its job orders are Running,
 *   and each one's ActualQuantity counts from the moment the work request started.
 * - A job order that reaches its PlannedQuantity ends on its own (Ended). The work request ends when
 *   its packing job ends; any job still running then is closed with it.
 * - The next work request starts right away. After the last one, the first is reopened with fresh
 *   counts: the instance model is static, so the demo recycles its orders instead of creating new
 *   nodes (a real MES would issue a new work request).
 * State names: OPC 10031-4 ISA95JobOrderStateMachineType (NotAllowedToStart, AllowedToStart, Running,
 * Interrupted, Ended, Aborted).
 */
import type { Plant } from "../../../factory/src/plant.js";

/** What a job order counts: m³ of final syrup made, m³ of beverage blended, bottles packed. */
export type Measure = "syrup" | "blend" | "pack";
export type Counters = Record<Measure, number>;
type Value = number | string | Date | null;

export interface JobSpec { id: string; measure: Measure; planned: number; produces: string[] }
export interface WorkRequestSpec { id: string; jobs: JobSpec[] }
export interface OrdersSpec {
  workRequests: WorkRequestSpec[];
  /** Lots whose Quantity is the live inventory of a simulated vessel: lot id → vessel ("T-202", "CO2-901"). */
  inventoryLots: Record<string, string>;
}

const MEASURE_BY_AREA: Record<string, Measure> = { SyrupRoom: "syrup", BlendingCarbonation: "blend", BottlingLine1: "pack" };
const INVENTORY_VESSELS = new Set(["T-202", "CO2-901"]);

/** Derive the simulation's order spec from the plant definition. */
export function ordersSpec(plant: Plant): OrdersSpec {
  const workRequests = Object.entries(plant.orders ?? {}).map(([id, wr]) => ({
    id,
    jobs: Object.entries(wr.jobOrders).map(([jid, jo]) => {
      const measure = MEASURE_BY_AREA[jo.dispatchedTo.split("/").pop()!];
      if (!measure) throw new Error(`job order ${jid}: the simulation has no measure for ${jo.dispatchedTo}`);
      return { id: jid, measure, planned: jo.plannedQuantity[0], produces: jo.produces ?? [] };
    }),
  }));
  const inventoryLots = Object.fromEntries(Object.entries(plant.materials?.lots ?? {})
    .filter(([, l]) => l.storedIn && INVENTORY_VESSELS.has(l.storedIn)).map(([id, l]) => [id, l.storedIn!]));
  return { workRequests, inventoryLots };
}

export interface JobRun { spec: JobSpec; state: string; actual: number; start: Date | null; end: Date | null }
export interface WrRun { spec: WorkRequestSpec; state: string; base: Counters; jobs: JobRun[]; start: Date | null; end: Date | null }

export class OrderBook {
  readonly wrs: WrRun[];
  private cur = -1;
  completed = 0;

  constructor(private readonly spec: OrdersSpec) {
    this.wrs = spec.workRequests.map((s) => ({
      spec: s, state: "AllowedToStart", base: { syrup: 0, blend: 0, pack: 0 }, start: null, end: null,
      jobs: s.jobs.map((j) => ({ spec: j, state: "AllowedToStart", actual: 0, start: null, end: null })),
    }));
  }

  get active() { return this.cur >= 0 ? this.wrs[this.cur] : undefined; }

  private startNext(c: Counters, now: Date) {
    if (!this.wrs.length) return;
    this.cur = (this.cur + 1) % this.wrs.length;
    const w = this.wrs[this.cur];
    Object.assign(w, { state: "Running", base: { ...c }, start: now, end: null });
    for (const j of w.jobs) Object.assign(j, { state: "Running", actual: 0, start: now, end: null });
  }

  step(c: Counters, now: Date) {
    if (this.cur < 0) this.startNext(c, now);
    const w = this.active;
    if (!w) return;
    for (const j of w.jobs) {
      if (j.state !== "Running") continue;
      j.actual = Math.min(j.spec.planned, c[j.spec.measure] - w.base[j.spec.measure]);
      if (j.actual >= j.spec.planned) Object.assign(j, { state: "Ended", end: now });
    }
    const pack = w.jobs.find((j) => j.spec.measure === "pack") ?? w.jobs[w.jobs.length - 1];
    if (pack && pack.state === "Ended") {
      for (const j of w.jobs) if (j.state === "Running") Object.assign(j, { state: "Ended", end: now });
      Object.assign(w, { state: "Ended", end: now });
      this.completed++;
      this.startNext(c, now);
    }
  }

  readings(r: { set(key: string, value: Value): unknown }, inventory: Record<string, number>) {
    for (const w of this.wrs) {
      const wk = `Orders/${w.spec.id}`;
      r.set(`${wk}/State`, w.state);
      r.set(`${wk}/StartTime`, w.start);
      r.set(`${wk}/EndTime`, w.end);
      for (const j of w.jobs) {
        const jk = `${wk}/${j.spec.id}`;
        r.set(`${jk}/State`, j.state);
        r.set(`${jk}/ActualQuantity`, j.spec.measure === "pack" ? Math.floor(j.actual) : Math.round(j.actual * 1000) / 1000);
        r.set(`${jk}/StartTime`, j.start);
        r.set(`${jk}/EndTime`, j.end);
        // finished-goods lots: their quantity is the packing job's count, their status follows the job
        if (j.spec.measure === "pack") for (const lot of j.spec.produces) {
          r.set(`Lot/${lot}/Quantity`, Math.floor(j.actual));
          r.set(`Lot/${lot}/Status`, j.state === "Running" ? "InProduction" : j.state === "Ended" ? "Released" : "Planned");
        }
      }
    }
    for (const [lot, vessel] of Object.entries(this.spec.inventoryLots)) {
      if (vessel in inventory) r.set(`Lot/${lot}/Quantity`, Math.round(inventory[vessel] * 1000) / 1000);
    }
  }
}
