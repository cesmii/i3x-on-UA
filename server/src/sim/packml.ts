/**
 * PackML (ISA-TR88.00.02) machine behaviour for the simulator: pure logic, no OPC UA.
 * State names/numbers follow the PackML 1.01 NodeSet:
 *   Base:     Cleared 19 | Aborting 8 | Aborted 9
 *   Machine:  Clearing 1 | Stopped 2 | Stopping 7 | Running 18          (inside Cleared)
 *   Execute:  Resetting 15, Idle 4, Starting 3, Execute 6, Suspending 13, Suspended 5,
 *             Unsuspending 14, Holding 10, Held 11, Unholding 12, Completing 16, Complete 17   (inside Running)
 */
import type { Rng } from "./rng.js";

export type ExecState = "Resetting" | "Idle" | "Starting" | "Execute" | "Suspending" | "Suspended" | "Unsuspending"
  | "Holding" | "Held" | "Unholding" | "Completing" | "Complete";
export type MachState = "Clearing" | "Stopped" | "Stopping" | "Running";
export type BaseState = "Cleared" | "Aborting" | "Aborted";

/** Transitional ("acting") states end by themselves after this many seconds. */
const ACTING: Partial<Record<ExecState, [number, ExecState]>> = {
  Resetting: [5, "Idle"], Starting: [5, "Execute"], Suspending: [2, "Suspended"], Unsuspending: [3, "Execute"],
  Holding: [2, "Held"], Unholding: [4, "Execute"], Completing: [3, "Complete"],
};

export interface StopReason { id: number; message: string }

export interface PackmlConfig {
  tag: string;
  designSpeed: number;       // units/min at the machine's input
  unitsPerOutput: number;    // 1 for bottle machines, 24 for the case packer, 80 for the palletizer
  rejectRate: number;        // fraction of inputs rejected
  mtbfMin: number;           // mean time between faults (minutes of Execute)
  mttrMin: [number, number]; // repair time range (minutes)
  reasons: StopReason[];     // machine-specific stop reasons (PackML StopReason ID/Message)
}

export class PackmlMachine {
  base: BaseState = "Cleared";
  machine: MachState = "Stopped";
  exec: ExecState | null = null;
  stateTime = 0;             // s in the current innermost state
  speed = 0;                 // CurMachSpeed (units/min) this tick
  setpoint: number;          // MachSpeed
  starved = false;
  blocked = false;
  consumed = 0;              // ProdConsumedCount (inputs)
  processed = 0;             // ProdProcessedCount (good outputs)
  defective = 0;             // ProdDefectiveCount (rejects, in input units)
  stopReason: StopReason = { id: 0, message: "" };
  powerOnS = 0;              // Machinery OperationCounters
  executeS = 0;
  private repairLeft = 0;
  private partial = 0;       // fractional input units carried between ticks
  private assembling = 0;    // inputs collected toward the next output unit (case/pallet)

  constructor(readonly cfg: PackmlConfig, private readonly rng: Rng) { this.setpoint = cfg.designSpeed; }

  /** Command Reset + Start from Stopped (the operator's start-up sequence). */
  start() { if (this.machine === "Stopped") this.enter("Running", "Resetting"); }

  /** Innermost state name, as the line's HMI would show it. */
  get state(): string { return this.base !== "Cleared" ? this.base : this.machine === "Running" ? this.exec! : this.machine; }

  private enter(m: MachState, e: ExecState | null) { this.machine = m; this.exec = e; this.stateTime = 0; }
  private go(e: ExecState) { this.exec = e; this.stateTime = 0; }

  /**
   * Advance by dt seconds. `available` = input units the upstream can hand over this tick,
   * `room` = output units the downstream can accept. Returns units actually taken and produced.
   */
  step(dt: number, available: number, room: number, upstreamRate: number): { took: number; produced: number } {
    this.stateTime += dt;
    this.powerOnS += dt;
    this.speed = 0;
    let took = 0, produced = 0;
    if (this.machine !== "Running" || !this.exec) return { took, produced };

    const acting = ACTING[this.exec];
    if (acting && this.stateTime >= acting[0]) this.go(acting[1]);

    switch (this.exec) {
      case "Idle":
        if (this.stateTime >= 2) this.go("Starting");
        break;
      case "Held":
        this.repairLeft -= dt;
        if (this.repairLeft <= 0) this.go("Unholding");
        break;
      case "Suspended":
        // wait for material (starved) or space (blocked) with some margin, then resume
        // resume once ~5 s of flow is waiting (input units) or there's ~5 s of room (output units)
        if ((this.starved && available >= Math.max(2, this.cfg.designSpeed / 12)) ||
            (this.blocked && room >= Math.max(2, this.cfg.designSpeed / this.cfg.unitsPerOutput / 12))) {
          this.starved = this.blocked = false;
          this.go("Unsuspending");
        } else if (!this.starved && !this.blocked) this.go("Unsuspending");
        break;
      case "Execute": {
        this.executeS += dt;
        // random fault → Holding → Held (operator repair), with a machine-specific stop reason
        if (this.rng.next() < dt / (this.cfg.mtbfMin * 60)) {
          const r = this.cfg.reasons[Math.floor(this.rng.next() * this.cfg.reasons.length)];
          this.stopReason = r;
          this.repairLeft = (this.cfg.mttrMin[0] + this.rng.next() * (this.cfg.mttrMin[1] - this.cfg.mttrMin[0])) * 60;
          this.go("Holding");
          break;
        }
        // run at design speed, or follow the upstream rate when the infeed is running low
        const target = available < this.cfg.designSpeed * 0.5 ? Math.min(this.cfg.designSpeed, Math.max(upstreamRate, this.cfg.designSpeed * 0.6)) : this.cfg.designSpeed;
        this.setpoint = target;
        const want = (target / 60) * dt + this.partial;
        const canOut = room * this.cfg.unitsPerOutput - this.assembling;
        const n = Math.floor(Math.min(want, available, Math.max(0, canOut)));
        this.partial = Math.min(want - n, 1);
        if (n === 0 && available < 1) { this.starved = true; this.stopReason = { id: 101, message: "Starved: no material at infeed" }; this.go("Suspending"); break; }
        if (n === 0 && canOut < 1) { this.blocked = true; this.stopReason = { id: 102, message: "Blocked: outfeed full" }; this.go("Suspending"); break; }
        took = n;
        this.consumed += n;
        let rejects = 0;
        for (let i = 0; i < n; i++) if (this.rng.next() < this.cfg.rejectRate) rejects++;
        this.defective += rejects;
        this.assembling += n - rejects;
        produced = Math.floor(this.assembling / this.cfg.unitsPerOutput);
        this.assembling -= produced * this.cfg.unitsPerOutput;
        this.processed += produced;
        this.speed = (n / dt) * 60;
        break;
      }
    }
    return { took, produced };
  }

  /** Inputs inside the machine, waiting to become a case/pallet (for conservation checks). */
  get inProcess() { return this.assembling; }

  /** Machinery MachineryItemState mapped from PackML (documented mapping, see SIMULATION.md). */
  get machineryState(): "Executing" | "NotExecuting" | "OutOfService" | "NotAvailable" {
    if (this.base === "Aborted" || this.base === "Aborting") return "OutOfService";
    return this.exec === "Execute" ? "Executing" : "NotExecuting";
  }
}
