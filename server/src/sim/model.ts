/**
 * Process model of the virtual beverage plant (Line 1): pure TypeScript, no OPC UA.
 * Units: volumes m³, flows m³/h, time s, temperatures °C, densities kg/m³.
 * Every quantity that enters or leaves a vessel goes through `move()`/`addIn()`/`takeOut()` so the
 * volume balance can be checked exactly (see check.ts). Design: docs/factory/PLANT_DESIGN.md §6.
 */
import { Rng } from "./rng.js";
import { PackmlMachine, type PackmlConfig } from "./packml.js";

const H = 3600;
const BOTTLE_M3 = 0.0005;                    // 500 mL
const SUGAR_KG_PER_M3 = 1590;                // dissolved-volume equivalent of sucrose
const CONC_DENSITY = 1050;
const CO2_KG_PER_M3 = 7.3;                   // ≈ 3.7 vol

export interface Vessel { name: string; v: number; cap: number; height: number; temp: number; density: number }
export type BatchPhase = "Idle" | "FillWater" | "Dissolve" | "Hold" | "Transfer";

/** A value for one OPC UA node, keyed by our NodeId path (s=<key>). */
export type Reading =
  | number | boolean | string
  | { state: string }                                            // Machinery / PackML state machine CurrentState
  | { packmlCount: Array<{ id: number; name: string; count: number; acc: number }> }
  | { packmlAlarm: { id: number; value: number; message: string } };

const vessel = (name: string, v: number, cap: number, height: number, temp: number, density: number): Vessel =>
  ({ name, v, cap, height, temp, density });

export interface LineSpec { tag: string; designSpeed: number }

export class PlantSim {
  t = 0;
  readonly rng: Rng;
  // ---- water treatment
  T101 = vessel("T-101", 30, 50, 5, 12, 999.5);
  T102 = vessel("T-102", 18.75, 30, 4, 15, 999.1);
  xv101 = false;
  roOn = false;
  filterDp = 0.4;
  backwashLeft = 0;
  // ---- syrup room
  SD201 = vessel("SD-201", 0, 5, 2.5, 25, 998);
  sdPhase: BatchPhase = "Idle";
  sdPhaseTime = 0;
  sdSugarKg = 0;
  T201 = vessel("T-201", 9, 15, 4, 30, 1320);
  T202 = vessel("T-202", 8, 15, 4, 22, 1270);
  t202Filling = false;
  t202Simple = 0;
  // ---- blending & carbonation
  T301 = vessel("T-301", 6, 10, 3, 3, 1042);
  fillRateEma = 0;
  // ---- utilities
  co2Pct = 70;
  co2Refill = false;
  // ---- flows this tick (m³/h), for instruments and pumps
  f = { raw: 0, p101: 0, perm: 0, reject: 0, p102: 0, sdWater: 0, sugar: 0, p201: 0, p202: 0, conc: 0, p203: 0, water: 0, blend: 0, fill: 0 };
  // ---- cumulative volume across the plant boundary (m³)
  totIn = 0;
  totOut = 0;
  // ---- packaging line
  line: PackmlMachine[];
  acc = [0, 0, 0, 0];                                    // FL→CP, CP→LB, LB→CK (bottles); CK→PZ (cases)
  readonly accCap = [1200, 1200, 1500, 60];
  pallets = 0;

  constructor(lineSpecs: LineSpec[], seed = 42) {
    this.rng = new Rng(seed);
    const reasons = {
      "FL-401": [[201, "Fill valve fault"], [202, "Bottle jam at infeed star"], [203, "Product temperature high"]],
      "CP-402": [[301, "Cap chute empty"], [302, "Torque out of range"]],
      "LB-403": [[401, "Label web break"], [402, "Glue temperature low"], [403, "Label roll change"]],
      "CK-404": [[501, "Case blank jam"], [502, "Bottle grouping fault"]],
      "PZ-405": [[601, "Pallet dispenser empty"], [602, "Layer pusher overload"]],
    } as Record<string, Array<[number, string]>>;
    const base: Record<string, Omit<PackmlConfig, "tag" | "designSpeed" | "reasons">> = {
      "FL-401": { unitsPerOutput: 1, rejectRate: 0.002, mtbfMin: 50, mttrMin: [1, 4] },
      "CP-402": { unitsPerOutput: 1, rejectRate: 0.0005, mtbfMin: 70, mttrMin: [0.5, 2] },
      "LB-403": { unitsPerOutput: 1, rejectRate: 0.001, mtbfMin: 35, mttrMin: [1, 3] },
      "CK-404": { unitsPerOutput: 24, rejectRate: 0.0002, mtbfMin: 60, mttrMin: [1, 3] },
      "PZ-405": { unitsPerOutput: 80, rejectRate: 0, mtbfMin: 120, mttrMin: [2, 5] },
    };
    this.line = lineSpecs.map((s) => new PackmlMachine({
      tag: s.tag, designSpeed: s.designSpeed, ...base[s.tag],
      reasons: reasons[s.tag].map(([id, message]) => ({ id, message })),
    }, this.rng));
  }

  // ---------- bookkeeping primitives ----------
  private mix(to: Vessel, vol: number, density: number, temp: number) {
    if (vol <= 0) return;
    const v = to.v + vol;
    to.density = (to.density * to.v + density * vol) / v;
    to.temp = (to.temp * to.v + temp * vol) / v;
    to.v = v;
  }
  /** Move up to rate·dt from one vessel to another; returns m³/h actually moved. */
  private move(from: Vessel, to: Vessel, rate: number, dt: number) {
    const vol = Math.max(0, Math.min((rate * dt) / H, from.v, to.cap - to.v));
    from.v -= vol;
    this.mix(to, vol, from.density, from.temp);
    return (vol * H) / dt;
  }
  private addIn(to: Vessel, rate: number, dt: number, density: number, temp: number) {
    const vol = Math.max(0, Math.min((rate * dt) / H, to.cap - to.v));
    this.mix(to, vol, density, temp);
    this.totIn += vol;
    return (vol * H) / dt;
  }
  private takeOut(from: Vessel, vol: number) {
    const v = Math.max(0, Math.min(vol, from.v));
    from.v -= v;
    this.totOut += v;
    return v;
  }
  get vessels() { return [this.T101, this.T102, this.SD201, this.T201, this.T202, this.T301]; }
  get inventory() { return this.vessels.reduce((s, v) => s + v.v, 0); }

  /** Command every machine to start, palletizer first (downstream before upstream). */
  startLine() { [...this.line].reverse().forEach((m) => m.start()); }

  // ---------- one step ----------
  step(dt = 1) {
    this.t += dt;
    const f = this.f;
    for (const k of Object.keys(f) as Array<keyof typeof f>) f[k] = 0;

    // --- packaging line (drives demand)
    const bottlesAvailable = Math.max(0, Math.floor((this.T301.v - 0.05) / BOTTLE_M3));
    for (let i = 0; i < this.line.length; i++) {
      const m = this.line[i];
      const available = i === 0 ? bottlesAvailable : this.acc[i - 1];
      const room = i === this.line.length - 1 ? Infinity : this.accCap[i] - this.acc[i];
      // upstream output rate in this machine's input units (the case packer runs in bottles/min but outputs cases)
      const upstreamRate = i === 0 ? Infinity : this.line[i - 1].speed / this.line[i - 1].cfg.unitsPerOutput;
      const { took, produced } = m.step(dt, available, room, upstreamRate);
      if (i === 0) f.fill = (this.takeOut(this.T301, took * BOTTLE_M3) * H) / dt;
      else this.acc[i - 1] -= took;
      if (i < this.line.length - 1) this.acc[i] += produced;
      else this.pallets += produced;
    }
    this.fillRateEma += (f.fill - this.fillRateEma) * Math.min(1, dt / 60);

    // --- blending & carbonation: hold the buffer tank at 60 %
    const frac301 = this.T301.v / this.T301.cap;
    let q = Math.max(0, Math.min(15, this.fillRateEma + 20 * (0.6 - frac301)));
    if (this.T202.v < 0.05 || this.T102.v < 0.5) q = 0;
    q = Math.min(q, (this.T301.cap - this.T301.v) * H / dt);
    const water = (q * 5) / 6, syrup = q / 6;
    const wVol = Math.min((water * dt) / H, this.T102.v), sVol = Math.min((syrup * dt) / H, this.T202.v);
    this.T102.v -= wVol;
    this.T202.v -= sVol;
    const beverageDensity = (999 * wVol + this.T202.density * sVol) / Math.max(1e-9, wVol + sVol) || this.T301.density;
    this.mix(this.T301, wVol + sVol, beverageDensity, 3.0);
    f.water = (wVol * H) / dt;
    f.p203 = (sVol * H) / dt;
    f.blend = f.water + f.p203;
    const co2Kg = ((f.blend * dt) / H) * CO2_KG_PER_M3;
    this.co2Pct -= co2Kg / 300;                                         // 30 t tank
    if (this.co2Pct < 20) this.co2Refill = true;
    if (this.co2Refill) { this.co2Pct += (70 / 3600) * dt; if (this.co2Pct >= 90) this.co2Refill = false; }

    // --- syrup room: dissolver batch → T-201 → T-202 (+ concentrate)
    this.sdPhaseTime += dt;
    const sd = this.SD201;
    switch (this.sdPhase) {
      case "Idle":
        sd.temp += (25 - sd.temp) * Math.min(1, dt / 1800);
        if (this.sdPhaseTime > 60 && this.T201.cap - this.T201.v >= 5.2) this.phase("FillWater");
        break;
      case "FillWater":
        f.sdWater = this.move(this.T102, sd, 9, dt);
        if (sd.v >= 2.25) this.phase("Dissolve");
        break;
      case "Dissolve":
        sd.temp = Math.min(70, sd.temp + 0.05 * dt);
        if (sd.temp >= 50 && this.sdSugarKg < 4300) {
          const kg = Math.min(2.4 * dt, 4300 - this.sdSugarKg);
          this.sdSugarKg += kg;
          const vol = kg / SUGAR_KG_PER_M3;                            // sugar enters across the plant boundary
          sd.density = (sd.density * sd.v + kg) / (sd.v + vol);
          sd.v += vol;
          this.totIn += vol;
          f.sugar = (vol * H) / dt;
        }
        if (this.sdSugarKg >= 4300 && sd.temp >= 70) this.phase("Hold");
        break;
      case "Hold":
        if (this.sdPhaseTime >= 600) this.phase("Transfer");
        break;
      case "Transfer":
        f.p201 = this.move(sd, this.T201, 6, dt);
        if (sd.v <= 1e-6) { sd.v = 0; this.sdSugarKg = 0; sd.density = 998; this.phase("Idle"); }
        break;
    }
    this.T201.temp += (25 - this.T201.temp) * Math.min(1, dt / 20000);
    if (!this.t202Filling && this.T202.v < 3 && this.T201.v >= 9) { this.t202Filling = true; this.t202Simple = 0; }
    if (this.t202Filling) {
      f.p202 = this.move(this.T201, this.T202, 6, dt);
      this.t202Simple += (f.p202 * dt) / H;
      f.conc = this.addIn(this.T202, f.p202 * (2 / 9), dt, CONC_DENSITY, 20);
      if (this.t202Simple >= 9 || this.T201.v <= 1e-6) this.t202Filling = false;
    }

    // --- water treatment: T-101 → P-101 → F-101 → RO-101 → T-102 (+ reject to drain)
    if (this.backwashLeft > 0) this.backwashLeft -= dt;
    const frac102 = this.T102.v / this.T102.cap;
    if (frac102 < 0.55 && this.backwashLeft <= 0) this.roOn = true;
    if (frac102 > 0.9 || this.backwashLeft > 0) this.roOn = false;
    if (this.roOn) {
      const feedVol = Math.min((20 * dt) / H, this.T101.v);
      const perm = feedVol * 0.75, rej = feedVol - perm;
      this.T101.v -= feedVol;
      this.mix(this.T102, Math.min(perm, this.T102.cap - this.T102.v), 999.1, this.T101.temp + 1);
      const overflow = perm - Math.min(perm, this.T102.cap - this.T102.v);
      this.totOut += rej + Math.max(0, overflow);
      f.p101 = (feedVol * H) / dt; f.perm = (perm * H) / dt; f.reject = (rej * H) / dt;
      this.filterDp += feedVol * 0.004;
      if (this.filterDp >= 1.2) { this.backwashLeft = 900; this.filterDp = 0.35; }
    }
    f.p102 = f.water + f.sdWater;
    const frac101 = this.T101.v / this.T101.cap;
    if (frac101 < 0.4) this.xv101 = true;
    if (frac101 > 0.85) this.xv101 = false;
    if (this.xv101) f.raw = this.addIn(this.T101, 30, dt, 999.5, 12);
  }

  private phase(p: BatchPhase) { this.sdPhase = p; this.sdPhaseTime = 0; }

  // ---------- what the OPC UA layer shows ----------
  readings(): Map<string, Reading> {
    const r = new Map<string, Reading>();
    const n = (sd: number) => this.rng.noise(sd);
    const lvl = (v: Vessel) => (v.v / v.cap) * v.height;
    const f = this.f;
    const FL = this.line[0];
    const sig = (tag: string, role: string, value: number) => r.set(`${tag}/SignalSet/${role}/AnalogSignal`, value);
    const valve = (tag: string, value: number | boolean) => r.set(`${tag}/SignalSet/Valve/ControlSignal`, value);

    // instruments (PA-DIM)
    sig("LT-101", "Level", lvl(this.T101) + n(0.005));
    sig("PDT-101", "Pressure", f.p101 > 0 ? this.filterDp + n(0.005) : 0.02 + n(0.002));
    sig("PT-102", "Pressure", this.roOn ? 12 + 0.8 * (this.filterDp - 0.4) + n(0.08) : 0.3 + n(0.02));
    sig("FT-101", "Flow", Math.max(0, f.perm + (f.perm > 0 ? n(0.05) : 0)));
    sig("CT-101", "Conductivity", 8 + 1.5 * (this.filterDp - 0.4) + n(0.15));
    sig("LT-102", "Level", lvl(this.T102) + n(0.005));
    sig("TT-102", "Temperature", this.T102.temp + n(0.04));
    sig("FT-102", "Flow", Math.max(0, f.p102 + (f.p102 > 0 ? n(0.05) : 0)));
    sig("DT-201", "Density", (this.SD201.v > 0.05 ? this.SD201.density : 998) + n(0.3));
    sig("DT-202", "Density", this.T202.density + n(0.3));
    sig("FT-301", "Flow", Math.max(0, f.water + (f.water > 0 ? n(0.04) : 0)));
    sig("FT-302", "Flow", Math.max(0, f.p203 + (f.p203 > 0 ? n(0.01) : 0)));
    sig("DT-301", "Density", this.T301.density + n(0.2));
    sig("AT-301", "Concentration", 0.3 + n(0.02));
    sig("PT-303", "Pressure", 0.1 + n(0.004));
    sig("TT-301", "Temperature", 3.0 + n(0.05));
    sig("AT-302", "Concentration", 7.3 - (this.co2Pct < 5 ? 2 : 0) + n(0.04));
    sig("PT-304", "Pressure", 4.0 + n(0.03));
    sig("LT-301", "Level", (this.T301.v / this.T301.cap) * 100 + n(0.1));
    sig("PT-305", "Pressure", 3.5 + n(0.02));
    sig("TT-305", "Temperature", this.T301.temp + n(0.04));
    sig("LT-901", "Level", this.co2Pct + n(0.05));
    sig("PT-901", "Pressure", 12 + n(0.08));
    sig("PT-902", "Pressure", 7.0 - (FL.state === "Execute" ? 0.15 : 0) + n(0.04));
    valve("XV-101", this.xv101);
    valve("XV-202", this.t202Filling);
    valve("XV-301", FL.state === "Execute");
    valve("FCV-301", Math.min(100, (f.water / 15) * 100 + (f.water > 0 ? n(0.3) : 0)));
    valve("FCV-302", Math.min(100, (f.p203 / 4) * 100 + (f.p203 > 0 ? n(0.3) : 0)));
    valve("PCV-311", f.blend > 0 ? 45 + n(0.5) : 0);

    // pumps (Pumps spec measurements)
    const pump = (tag: string, flow: number, ratedFlow: number, ratedKw: number, head: number, fluidTemp: number) => {
      const on = flow > 1e-6, x = Math.min(1, flow / ratedFlow);
      r.set(`${tag}/Operational/Measurements/Speed`, on ? 2950 * (0.4 + 0.6 * x) + n(3) : 0);
      r.set(`${tag}/Operational/Measurements/PumpPowerInput`, on ? ratedKw * (0.25 + 0.75 * x ** 2) + n(0.03) : 0);
      r.set(`${tag}/Operational/Measurements/DifferentialPressure`, on ? head * (1.1 - 0.2 * x) + n(0.02) : 0);
      r.set(`${tag}/Operational/Measurements/FluidTemperature`, fluidTemp + n(0.05));
    };
    pump("P-101", f.p101, 20, 7.5, 4, this.T101.temp);
    pump("P-102", f.p102, 15, 5.5, 4, this.T102.temp);
    pump("P-201", f.p201, 6, 4, 6, this.SD201.temp);
    pump("P-202", f.p202, 6, 4, 6, this.T201.temp);
    pump("P-203", f.p203, 3, 2.2, 6, this.T202.temp);

    // Acme mixing tanks (vendor type)
    const acme = (tag: string, v: Vessel, agitating: boolean, executing: boolean) => {
      const pv = (p: string, value: number) => r.set(`${tag}/${p}/AnalogSignal`, value);
      pv("Monitoring/Process/Tank/Level", lvl(v) + n(0.003));
      pv("Monitoring/Process/Tank/LevelPercent", (v.v / v.cap) * 100 + n(0.05));
      pv("Monitoring/Process/Tank/Temperature", v.temp + n(0.05));
      pv("Monitoring/Process/Tank/Pressure", 0.02 + n(0.005));
      r.set(`${tag}/Component/Motor/Running`, agitating);
      pv("Component/Motor/Speed", agitating ? 1450 + n(2) : 0);
      pv("Component/Motor/Current", agitating ? 9.5 + (v.density - 1000) / 100 + n(0.1) : 0);
      pv("Component/Motor/Load", agitating ? 50 + (v.density - 1000) / 15 + n(0.5) : 0);
      pv("Component/Motor/Temperature", agitating ? 48 + n(0.2) : 28 + n(0.1));
      pv("Component/Motor/SealPressure", 1.8 + n(0.01));
      pv("Component/Motor/BearingTemperature", agitating ? 52 + n(0.2) : 30 + n(0.1));
      pv("Component/Motor/Vibration", agitating ? 2.2 + n(0.05) : 0.1 + n(0.01));
      r.set(`${tag}/Component/Motor/RatedCurrent`, 15);
      pv("Component/Drive/OutputHz", agitating ? 50 + n(0.05) : 0);
      pv("Component/Drive/OutputVolts", agitating ? 400 + n(0.5) : 0);
      r.set(`${tag}/Component/Drive/Ready`, true);
      r.set(`${tag}/Component/Drive/VfdFault`, false);
      r.set(`${tag}/Component/Drive/TorquePercent`, agitating ? Math.round(40 + (v.density - 1000) / 20) : 0);
      r.set(`${tag}/Component/Drive/FaultCount`, 0);
      r.set(`${tag}/Monitoring/Status/MachineryItemState/CurrentState`, executing ? "Executing" : "NotExecuting");
      r.set(`${tag}/Monitoring/Status/OperationMode/CurrentState`, "Processing");
      r.set(`${tag}/Monitoring/Health/FaultCode`, 0);
      r.set(`${tag}/Monitoring/Health/FaultReason`, "");
      r.set(`${tag}/Monitoring/Process/CleanInPlace/CipMode`, false);
      r.set(`${tag}/Monitoring/Process/CleanInPlace/LastCip`, 30 + this.t / 3600);
    };
    const sdBusy = this.sdPhase !== "Idle";
    acme("SD-201", this.SD201, sdBusy, sdBusy);
    r.set("SD-201/Monitoring/Process/Phases/ElapsedTime", sdBusy ? this.sdPhaseTime : 0);
    r.set("SD-201/Monitoring/Process/Phases/HeatDone", this.sdPhase === "Hold" || this.sdPhase === "Transfer");
    r.set("SD-201/Monitoring/Process/Phases/MixDone", this.sdPhase === "Transfer");
    acme("T-201", this.T201, this.T201.v > 1, f.p201 > 0 || f.p202 > 0);
    acme("T-202", this.T202, this.T202.v > 1, f.p202 > 0 || f.p203 > 0);
    for (const tag of ["T-201", "T-202"]) {
      r.set(`${tag}/Monitoring/Process/Phases/ElapsedTime`, 0);
      r.set(`${tag}/Monitoring/Process/Phases/HeatDone`, false);
      r.set(`${tag}/Monitoring/Process/Phases/MixDone`, true);
    }

    // Machinery state on skids
    const mstate = (tag: string, executing: boolean, mode = "Processing") => {
      r.set(`${tag}/MachineryItemState`, { state: executing ? "Executing" : "NotExecuting" });
      r.set(`${tag}/MachineryOperationMode`, { state: mode });
    };
    mstate("F-101", f.p101 > 0 || this.backwashLeft > 0, this.backwashLeft > 0 ? "Maintenance" : "Processing");
    mstate("RO-101", this.roOn);
    for (const tag of ["DA-301", "BL-301", "CB-301"]) mstate(tag, f.blend > 0);

    // PackML machines
    for (const m of this.line) {
      const t = m.cfg.tag;
      r.set(`${t}/BaseStateMachine`, { state: m.base });
      r.set(`${t}/BaseStateMachine/MachineState`, { state: m.base === "Cleared" ? m.machine : "" });
      r.set(`${t}/BaseStateMachine/MachineState/ExecuteState`, { state: m.base === "Cleared" && m.machine === "Running" ? m.exec ?? "" : "" });
      r.set(`${t}/Status/CurMachSpeed`, m.speed);
      r.set(`${t}/Status/MachSpeed`, m.setpoint);
      r.set(`${t}/Status/EquipmentStarved`, m.starved);
      r.set(`${t}/Status/EquipmentBlocked`, m.blocked);
      r.set(`${t}/Status/UnitModeCurrent`, 1);                    // PackML mode 1 = Production
      const unit = t === "CK-404" ? "cases" : t === "PZ-405" ? "pallets" : "bottles";
      r.set(`${t}/Admin/ProdProcessedCount`, { packmlCount: [{ id: 1, name: unit, count: m.processed, acc: m.processed }] });
      r.set(`${t}/Admin/ProdDefectiveCount`, { packmlCount: [{ id: 1, name: t === "PZ-405" ? "cases" : "bottles", count: m.defective, acc: m.defective }] });
      r.set(`${t}/Admin/ProdConsumedCount`, { packmlCount: [{ id: 1, name: t === "PZ-405" ? "cases" : "bottles", count: m.consumed, acc: m.consumed }] });
      r.set(`${t}/Admin/StopReason`, { packmlAlarm: { id: m.stopReason.id, value: m.stopReason.id, message: m.stopReason.message } });
      r.set(`${t}/Admin/AccTimeSinceReset`, Math.floor(m.powerOnS));
      r.set(`${t}/MachineryItemState`, { state: m.machineryState });
      r.set(`${t}/MachineryOperationMode`, { state: "Processing" });
      r.set(`${t}/OperationCounters/PowerOnDuration`, m.powerOnS * 1000);
      r.set(`${t}/OperationCounters/OperationDuration`, m.executeS * 1000);
      r.set(`${t}/OperationCounters/OperationCycleCounter`, m.processed);
    }
    return r;
  }
}
