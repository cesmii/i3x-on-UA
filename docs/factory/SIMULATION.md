# Phase 3: Line 1 Simulation

*Built 2026-11-05. Code: `server/src/sim/`. The design intent is in `PLANT_DESIGN.md` §6; this note records what was built and how to check it.*

## Run

```
npm start -w server                       # opc.tcp://localhost:4840/UA/BeverageFactory, real time
SIM_SPEED=10 npm start -w server          # 10 simulated seconds per wall second
SIM_FAULTS="PT-902=BadNotConnected" npm start -w server   # quality override (scenario layer)
npm run sim:check -w server -- 24 7       # headless: 24 simulated hours, seed 7, invariants asserted every minute
```

| Env | Default | Meaning |
|---|---|---|
| `SIM_SPEED` | 1 | simulated seconds per wall-clock second (integer) |
| `SIM_SEED` | 42 | PRNG seed; the same seed gives the same plant behaviour |
| `SIM_HISTORY` | 3600 | in-memory history per variable (values; 0 = off). Values are recorded on change |
| `SIM_FAULTS` | none | `"<NodeId path prefix>=<StatusCode name>,…"`: matching nodes get that StatusCode. **Bad** codes set the value to `null`; **Uncertain** codes keep the last usable value (fixed 2026-11-05). Line 1 is the healthy baseline, so no faults by default |

## Structure

| File | Role |
|---|---|
| `sim/model.ts` | **Pure process model** (no OPC UA). Vessels, flows, batch logic, utilities, packaging line. `readings()` returns `Map<NodeId path, value>` |
| `sim/packml.ts` | PackML machine: nested states (Base/Machine/Execute), faults with StopReason, starved/blocked, counts, rejects |
| `sim/rng.ts` | Seeded PRNG + noise |
| `sim/bind.ts` | Writes readings into the address space. Because our NodeIds are paths, the binding needs **no per-signal configuration**. It handles Float vs Double vs Int, state machines (CurrentState + Id + Number), PackML structures, quality overrides and history |
| `sim/orders.ts` | Work requests and job orders (`OrderBook`) and the live material-lot quantities; `ordersSpec(plant)` derives them from the plant YAML |
| `sim/check.ts` | Headless invariant run (the Phase 3 exit criterion) |
| `main.ts` | Server + 1 Hz loop (`SIM_SPEED` steps per tick) |

## What moves

- **Water treatment:**
  - XV-101 refills T-101 (opens below 40 %, closes above 85 %).
  - The RO runs on T-102 level (starts below 55 %, stops above 90 %) at 20 m³/h feed and 75 % recovery; the reject goes to the drain.
  - F-101 ΔP rises with throughput (0.004 bar/m³). At 1.2 bar it backwashes for 15 min: the RO stops and F-101's OperationMode goes to **Maintenance**.
  - CT-101 drifts up slightly as the filter loads.
- **Syrup room:**
  - SD-201 batch: fill 2.25 m³ of water, heat to 70 °C, dose 4,300 kg of sugar from 50 °C, hold 10 min, transfer to T-201 at 6 m³/h. The result is ≈ 65 °Bx at about 1,320 kg/m³, computed from the masses rather than scripted.
  - When T-202 drops below 3 m³, it takes 9 m³ from T-201 plus concentrate at 2:9 (XV-202 open), which gives final syrup at ≈ 1,270 kg/m³.
  - The Acme Phases (HeatDone, MixDone, ElapsedTime) and its look-alike Status strings follow the batch.
- **Blending & carbonation:**
  - A P-controller holds T-301 at 60 %: blend = filler draw + 20·(0.6 − level), capped at 15 m³/h, split water:syrup 5:1 (FT-301/FT-302, FCV-301/302). Density is mixed from the actual inputs.
  - CO₂ is consumed at 7.3 kg/m³ from a 30 t tank, and a truck refill starts below 20 %.
- **Packaging line (PackML):**
  - Start-up: Stopped → Resetting → Idle → Starting → Execute.
  - Random faults (MTBF/MTTR per machine) go to Holding → Held with a machine-specific `StopReason` (ID + message), then Unholding.
  - Starved or blocked machines go to Suspending → Suspended, with `EquipmentStarved` / `EquipmentBlocked`. They resume once there's about 5 s of material or room.
  - Accumulation between machines: 1,200 / 1,200 / 1,500 bottles and 60 cases. These are sim-internal; there are no conveyor objects (design decision 4).
  - Rejects: filler 0.2 %, capper 0.05 %, labeler 0.1 %, case packer 0.02 %.
  - The case packer assembles 24 bottles per case and the palletizer 80 cases per pallet.
  - `MachSpeed` follows the upstream rate (in the machine's own input units) when the infeed runs low.
- **Machinery on PackML machines:**
  - `MachineryItemState`: Execute → **Executing**; Aborted → **OutOfService**; any other state → **NotExecuting**.
  - `MachineryOperationMode` = Processing.
  - `OperationCounters` (PowerOnDuration and OperationDuration in ms, OperationCycleCounter).
- **Inactive PackML sub-state machines** (e.g. `ExecuteState` while the machine is Stopped) report `null` with **`Bad_StateNotActive`** (OPC 10000-16), not an empty string. That's a useful i3X quality test.
- **Noise:** small Gaussian-ish noise on all analog readings. Each value is written only when it changes, so the history holds real changes, not a 1 Hz sample of constants.

## Orders and material lots (added 2026-11-16)

- **One work request runs at a time** (`State` Running, `StartTime` set); the others wait as `AllowedToStart`. Its three job orders run together, each counting from the moment the work request started:
  - **syrup** (JO-…-10, Syrup Room): m³ of final syrup made in T-202 (simple syrup + concentrate);
  - **blend** (JO-…-20, Blending & Carbonation): m³ of beverage blended;
  - **pack** (JO-…-30, Bottling Line 1): bottles packed (case-packer cases × 24).
- A job order that reaches its `PlannedQuantity` ends on its own (`Ended`, `EndTime` set). The work request ends when its **packing** job ends (160,000 bottles, ≈ 7.5 sim-hours at the line's ≈ 22,800 bottles/h). A job still running then is closed with it, so the syrup job often ends a little short: syrup is made in 9 m³ batches.
- The next work request starts at once. After the last, the first is **reopened with fresh counts**. The instance model is static, so the demo recycles its two orders instead of creating new nodes (a real MES would issue a new work request). Start/end times are wall-clock, so with `SIM_SPEED` > 1 they're compressed.
- **Lots:** the finished-goods lot of each work request has the packing job's count as `Quantity` and a `Status` that follows the job (Planned → InProduction → Released). SYR-2611-16 holds T-202's volume, CO2-2611-01 the CO₂ tank inventory in t. Other lots are static.
- Empty `StartTime`/`EndTime` are written as null with Good status, which the gateways show as `GoodNoData`/`null`.

## Checks (Phase 3 exit)

`npm run sim:check -w server -- 24 7` (24 simulated hours in about 3 s):

| Invariant (asserted every simulated minute) | Result |
|---|---|
| Volume balance across the plant boundary (raw water + sugar + concentrate in; drain + filled product out; Δ inventory) | residual ≤ 7.4 × 10⁻¹⁰ m³ (floating point) |
| Vessels within 0…capacity, no NaN | ✅ |
| Line unit conservation: good out of machine *i* = taken by *i+1* + waiting in accumulation *i* | ✅ exact (integers) |
| Inside each machine: consumed − rejects = outputs × units/output + in process | ✅ exact |
| All readings finite | ✅ |

**Typical day (seed 7):**
- **Filler:** 22,400 bottles/h (93 % of design), Execute 93 %, Held 5.5 %.
- **Other machines:** labeler Held 6 %; palletizer Suspended 9.5 %, which is expected: it's the fastest machine and waits for cases.
- **Process:** 8 syrup batches and 1 filter backwash.
- **Levels at end of day:** T-301 60 %, T-202 48 %.

**Live checks** with `factory/src/tools/read.ts`:
- PackML nested states, counts (`PackMLCountDataType[]`), StopReason, Machinery states, instruments, pumps, and `PT-902 = null, BadNotConnected` under `SIM_FAULTS` all read correctly.
- `readHistoryValue` returns the recorded changes. node-opcua adds `BadBoundNotFound` markers at the window edges.

**Order invariants** (added 2026-11-16, checked every simulated minute): exactly one work request is running; every job order's actual is within [0, planned] and never decreases while it runs; each finished-goods lot's `Quantity` equals its packing job's count. The 24 h / seed 42 run completes 3 work requests.

## Known limits / follow-ups

- **History is in memory** (node-opcua's built-in historian) and is lost on restart. The server uses about 470 MB at start (mostly the 11 NodeSets); watch growth as history fills (3,600 values × the changing variables). A real historian may be needed for Phase 5's i3X history endpoint.
- Model items deferred from Phase 2: IA stacklights, Monitoring Health and Consumption, LifetimeCounters, pump design ratings.
- No shift/CIP schedule yet: the line runs continuously.
- Line 2 and its fault scenarios come later. The `SIM_FAULTS` mechanism is the first piece of that.
