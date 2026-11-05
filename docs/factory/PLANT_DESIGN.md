# Virtual Beverage Plant: Phase 1 Design (draft for sign-off)

*Draft 2026-11-05. This document defines **what** gets built in Phase 2 (the OPC UA model) and Phase 3 (the simulation). Types come from `STANDARDS_COVERAGE.md`, and diagrams are in `PLANT_DIAGRAM.md`. Every vendor, serial number and URI is fictitious and uses the reserved `.example` domain.*

## 1. Product and line rate

| Item | Value |
|---|---|
| Product | Carbonated soft drink, 500 mL PET bottle, 24-pack case, 80 cases per pallet |
| Line 1 nominal rate | **400 bottles/min** (24,000/h): **12 m³/h of beverage** |
| Recipe | Final syrup : water = **1 : 5** by volume, so **2 m³/h syrup + 10 m³/h water** into the blender |
| Target quality | about 10.5 °Bx, 3.7 vol CO₂ (≈ 7.3 g/L), dissolved O₂ < 0.5 mg/L, filled at 2–4 °C |
| Syrup | Simple syrup about 65 °Bx (hot-dissolved sugar); final syrup about 55 °Bx (simple syrup + flavor concentrate). Batch process. |
| Water | RO permeate under 20 µS/cm. Demand ≈ 10 m³/h for blending + ≈ 1.1 m³/h for dissolving. The RO has 15 m³/h capacity at 75 % recovery. |

The line follows a **V-curve**: the filler is the bottleneck, and downstream machines are 10–25 % faster so they can drain the accumulation conveyors.

## 2. Equipment list

Model key:
- **ISA95** = ISA-95 `EquipmentType` + `DefinedByEquipmentClass` → class instance
- **Acme** = vendor `MixingTankType`
- **Pumps** = `PumpType`
- **PackML** = `PackMLBaseObjectType`
- **+MBB** = Machinery building blocks (Identification, MachineryItemState, OperationMode, Monitoring), attached as AddIns
- **Ports** = Pumps port objects (`Direction`, `Category`) added to the instance

| Tag | Name | Area | Model | Ports (In → Out) | Key ratings | Vendor (fictitious) |
|---|---|---|---|---|---|---|
| T-101 | Raw Water Tank | 100 | ISA95 class StorageTank, Ports | Water in → Water out | 50 m³, 5 m tall | n/a (site-built) |
| P-101 | Raw Water Pump | 100 | Pumps | Water → Water | Centrifugal, 20 m³/h @ 4 bar, 7.5 kW | Northwind Pumps |
| F-101 | Carbon Filter | 100 | ISA95 class Filter, +MBB, Ports | Water → Water | 20 m³/h | Vandelay Water Systems |
| RO-101 | Reverse Osmosis Skid | 100 | ISA95 class ReverseOsmosisUnit, +MBB, Ports | Water → Water (permeate), Water (reject → drain) | 15 m³/h permeate, 75 % recovery | Vandelay Water Systems |
| T-102 | Treated Water Tank | 100 | ISA95 class StorageTank, Ports | Water → Water | 30 m³, 4 m tall | n/a |
| P-102 | Treated Water Pump | 100 | Pumps | Water → Water | Centrifugal, 15 m³/h @ 4 bar | Northwind Pumps |
| SD-201 | Sugar Dissolver | 200 | **Acme**, Ports | Water + Sugar → Syrup | 5 m³, heated to 70 °C, agitated | Acme Process Systems |
| P-201 | Dissolver Discharge Pump | 200 | Pumps | Syrup → Syrup | Rotary lobe, 6 m³/h | Northwind Pumps |
| T-201 | Simple Syrup Tank | 200 | **Acme**, Ports | Syrup → Syrup | 15 m³, agitated | Acme Process Systems |
| P-202 | Syrup Transfer Pump | 200 | Pumps | Syrup → Syrup | Rotary lobe, 6 m³/h | Northwind Pumps |
| T-202 | Final Syrup Tank | 200 | **Acme**, Ports | Syrup + Concentrate → Syrup | 15 m³, agitated, about 6 h of line supply | Acme Process Systems |
| P-203 | Syrup Feed Pump | 200 | Pumps | Syrup → Syrup | Rotary lobe, 3 m³/h, VFD | Northwind Pumps |
| DA-301 | Deaerator | 300 | ISA95 class Deaerator, +MBB, Ports | Water → Water | 12 m³/h, vacuum | Globex Process |
| BL-301 | Inline Blender | 300 | ISA95 class Blender, +MBB, Ports | Water + Syrup → Beverage | 15 m³/h, ratio control | Globex Process |
| HX-301 | Product Cooler | 300 | ISA95 class HeatExchanger, Ports | Beverage → Beverage | Plate heat exchanger, 15 m³/h, to 3 °C | Globex Process |
| CB-301 | Carbonator | 300 | ISA95 class Carbonator, +MBB, Ports | Beverage + CO₂ → Beverage | 15 m³/h, up to 4.0 vol | Globex Process |
| T-301 | Product Buffer Tank | 300 | ISA95 class PressureTank, Ports | Beverage → Beverage | 10 m³ (≈ 50 min of filler), CO₂ head 3.5 bar | n/a |
| FL-401 | Filler | 400 | **PackML +MBB**, Ports | Beverage + Bottle → Bottle | 400 bpm, 60 valves, fill-height inspection | Globex Packaging |
| CP-402 | Capper | 400 | PackML +MBB, Ports | Bottle + Cap → Bottle | 400 bpm (monoblock with the filler in practice; modeled as its own unit) | Globex Packaging |
| LB-403 | Labeler | 400 | PackML +MBB, Ports | Bottle + Label → Bottle | 440 bpm, roll-fed | Globex Packaging |
| CK-404 | Case Packer | 400 | PackML +MBB, Ports | Bottle + Case → Case | 20 cases/min (480 bpm) | Globex Packaging |
| PZ-405 | Palletizer | 400 | PackML +MBB, Ports | Case → Pallet | 25 cases/min | Globex Packaging |
| CO2-901 | CO₂ Supply | 900 | ISA95 class CO2Supply, Ports | → CO₂ | 30 t liquid CO₂ + vaporizer | n/a |
| AC-902 | Compressed Air | 900 | ISA95 class CompressedAirSupply | (not piped in the model) | 7 bar | Initech Air |

**Inputs and outputs at the site boundary** (grey in the diagram): granulated sugar (to SD-201), flavor concentrate (to T-202), raw water main, drain, empty bottles, caps, labels, case blanks, finished pallets. *Phase 2 note:* a port needs an owner, so the four piped boundaries are modeled as ISA-95 Equipment of class `ExternalConnection`: `RawWaterMain`, `Drain`, `SugarSupply`, `ConcentrateSupply`. The packaging consumables are deferred along with the conveyor links.

## 3. Instrument list (PA-DIM devices)

Every instrument is a PA-DIM `PADIMType` device with DI Identification/Health and a `SignalSet` holding one signal of the listed VariableType. The device is a component of the equipment it measures. Vendor: Initech Instruments (fictitious).

| Tag | Measures | On | PA-DIM signal / variable type | Unit | Range | Nominal |
|---|---|---|---|---|---|---|
| LT-101 | Level | T-101 | AnalogSignal / `LevelMeasurementVariableType` | m | 0–5 | 3.0 |
| PDT-101 | Filter ΔP | F-101 | AnalogSignal / `PressureMeasurementVariableType` | bar | 0–2 | 0.4, rising as the filter loads |
| PT-102 | RO feed pressure | RO-101 | AnalogSignal / `PressureMeasurementVariableType` | bar | 0–20 | 12 |
| FT-101 | RO permeate flow | RO-101 | AnalogSignal / `ActualVolumeFlowRateVariableType` + `TotalizerVariableType` | m³/h | 0–20 | 11–15 |
| CT-101 | Permeate conductivity | RO-101 | `ConductivityMeterType` (analyser) | µS/cm | 0–100 | 8 |
| LT-102 | Level | T-102 | AnalogSignal / `LevelMeasurementVariableType` | m | 0–4 | 2.5 |
| TT-102 | Water temperature | T-102 | AnalogSignal / `TemperatureMeasurementVariableType` | °C | 0–40 | 15 |
| FT-102 | Treated water flow | P-102 discharge | AnalogSignal / `ActualVolumeFlowRateVariableType` | m³/h | 0–20 | 11 |
| DT-201 | Syrup density | SD-201 | AnalogSignal / `ActualDensityVariableType` | kg/m³ | 1000–1400 | 1320 (≈ 65 °Bx) |
| DT-202 | Syrup density | T-202 | AnalogSignal / `ActualDensityVariableType` | kg/m³ | 1000–1400 | 1260 (≈ 55 °Bx) |
| FT-301 | Blend water flow | BL-301 | AnalogSignal / `ActualVolumeFlowRateVariableType` | m³/h | 0–15 | 10.0 |
| FT-302 | Blend syrup flow | BL-301 | AnalogSignal / `ActualVolumeFlowRateVariableType` | m³/h | 0–4 | 2.0 |
| DT-301 | Beverage density | BL-301 | AnalogSignal / `ActualDensityVariableType` | kg/m³ | 990–1100 | 1042 (≈ 10.5 °Bx) |
| AT-301 | Dissolved O₂ | DA-301 | AnalogSignal / `AnalyticalMeasurementVariableType` | mg/L | 0–2 | 0.3 |
| PT-303 | Deaerator vacuum | DA-301 | AnalogSignal / `PressureMeasurementVariableType` | bar (abs) | 0–1 | 0.1 |
| TT-301 | Cooler outlet temperature | HX-301 | AnalogSignal / `TemperatureMeasurementVariableType` | °C | 0–20 | 3.0 |
| AT-302 | CO₂ content | CB-301 | AnalogSignal / `AnalyticalMeasurementVariableType` | g/L | 0–10 | 7.3 |
| PT-304 | Carbonator pressure | CB-301 | AnalogSignal / `PressureMeasurementVariableType` | bar | 0–8 | 4.0 |
| LT-301 | Level | T-301 | AnalogSignal / `LevelMeasurementVariableType` | % | 0–100 | 60 |
| PT-305 | Head pressure | T-301 | AnalogSignal / `PressureMeasurementVariableType` | bar | 0–6 | 3.5 |
| TT-305 | Product temperature | T-301 | AnalogSignal / `TemperatureMeasurementVariableType` | °C | 0–10 | 3.0 |
| LT-901 | CO₂ inventory | CO2-901 | AnalogSignal / `LevelMeasurementVariableType` | % | 0–100 | 70 (slowly falling) |
| PT-901 | CO₂ supply pressure | CO2-901 | AnalogSignal / `PressureMeasurementVariableType` | bar | 0–20 | 12 |
| PT-902 | Air header pressure | AC-902 | AnalogSignal / `PressureMeasurementVariableType` | bar | 0–10 | 7.0 |

**Valves** (PA-DIM control signals):

| Tag | Function | On | Signal type | Notes |
|---|---|---|---|---|
| XV-101 | Raw water inlet | T-101 | `TwoStateDiscreteControlSignalType` | Opens on low level |
| XV-202 | Concentrate dosing | T-202 | `TwoStateDiscreteControlSignalType` | Open during the final-syrup batch |
| FCV-301 | Water ratio control | BL-301 | `ControlSignalType` (% open) | Flow controller with FT-301 |
| FCV-302 | Syrup ratio control | BL-301 | `ControlSignalType` (% open) | Flow controller with FT-302 |
| PCV-311 | CO₂ pressure control | CB-301 | `ControlSignalType` (% open) | Holds PT-304 |
| XV-301 | Buffer outlet | T-301 | `TwoStateDiscreteControlSignalType` | Open while the filler runs |

**Built into vendor or machine types, so not separate PA-DIM devices:**
- **Acme tanks:** Level, LevelPercent, Pressure and Temperature (`Monitoring/Process/Tank`), plus agitator Motor/Drive values.
- **Pumps:** the Pumps type's own measurements (flow, pressure, power, speed).
- **PackML machines:**
  - Status: CurMachSpeed, MachSpeed, ProdProcessedCount, ProdDefectiveCount, StopReason, UnitModeCurrent, StateCurrent
  - Machinery: MachineryItemState, OperationMode, OperationCounters
  - IA: stacklight
  - FL-401 also reports a fill-height reject count.

**Units with no UNECE code:** °Bx (Brix) and CO₂ volumes. We measure density (kg/m³) and CO₂ in g/L instead, and the simulator derives °Bx and volumes where useful. This is a deliberate fidelity talking point.

## 4. Material-flow connections

Each link is a DI `ConnectsTo` from an **Out** port to an **In** port with the **same `Category`** (decision P1-b). Port BrowseNames look like `Ports/<Category>Out` and `Ports/<Category>In`, with a numeric suffix when there's more than one.

| # | From (Out) | To (In) | Category |
|---|---|---|---|
| 1 | (raw water main) | T-101 | Water |
| 2 | T-101 | P-101 | Water |
| 3 | P-101 | F-101 | Water |
| 4 | F-101 | RO-101 | Water |
| 5 | RO-101 (permeate) | T-102 | Water |
| 6 | RO-101 (reject) | (drain) | Water |
| 7 | T-102 | P-102 | Water |
| 8 | P-102 | SD-201 | Water |
| 9 | P-102 | DA-301 | Water |
| 10 | (sugar) | SD-201 | Sugar |
| 11 | SD-201 | P-201 | Syrup |
| 12 | P-201 | T-201 | Syrup |
| 13 | T-201 | P-202 | Syrup |
| 14 | P-202 | T-202 | Syrup |
| 15 | (concentrate) | T-202 | Concentrate |
| 16 | T-202 | P-203 | Syrup |
| 17 | P-203 | BL-301 | Syrup |
| 18 | DA-301 | BL-301 | Water |
| 19 | BL-301 | HX-301 | Beverage |
| 20 | HX-301 | CB-301 | Beverage |
| 21 | CO2-901 | CB-301 | CO2 |
| 22 | CB-301 | T-301 | Beverage |
| 23 | T-301 | FL-401 | Beverage |
| ~~24–29~~ | *Packaging-line conveyor links* | | *Deferred; not modeled for now* |

- **Links 8 and 9:** one Out port connects to two In ports, i.e. a tee in the header. That's allowed, since `ConnectsTo` is many-to-many.
- **Links 24–29 (conveyors) are deferred** (decided 2026-11-05). For now the packaging line has no material links; machine order comes only from the hierarchy and naming. Starved and blocked conditions are machine states, with no conveyor objects.
- **The i3X layer** turns each link into `FlowsTo` / `FedBy` between the owning equipment (marked `synthesized`). It also keeps the raw `ConnectsTo` between the ports.

## 5. Hierarchy and identity

**Hierarchy** (decision P1-c: machines are direct children of their line):

```
Objects
├── Demo Beverage Co.                ISA-95 Equipment, level Enterprise
│   └── Plant 1                      Site
│       ├── Water Treatment          Area      → T-101, P-101, F-101, RO-101, T-102, P-102
│       ├── Syrup Room               Area      → SD-201, P-201, T-201, P-202, T-202, P-203
│       ├── Blending & Carbonation   Area      → DA-301, BL-301, HX-301, CB-301, T-301
│       ├── Bottling Line 1          ProductionLine → FL-401, CP-402, LB-403, CK-404, PZ-405
│       └── Utilities                Area      → CO2-901, AC-902
├── Machines                         (Machinery §9, Organizes: FL-401 … PZ-405, F-101, RO-101, DA-301, BL-301, CB-301, SD-201, T-201, T-202)
└── Equipment Classes                (ISA-95 EquipmentClassType instances: StorageTank, PressureTank, MixingTank, Filter, …)
```

- **Children that are ISA-95 Equipment** (areas, ISA-95 tanks and skids) are linked with `MadeUpOfEquipment`.
- **Children of other types** (Pumps, Acme tanks, PackML machines) are linked with **`Organizes`**. `MadeUpOfEquipment` is meant for Equipment→Equipment, and we don't have the ISA-95 COM spec text to confirm whether wider use is allowed. Both map to i3X `HasChildren`, with a fidelity note on the reference used.
- **Instruments and valves** are `HasComponent` children of their equipment, so in i3X they are composition.

**Identity:**
- **Namespace URI** (proposal): `https://cesmii.net/i3x-demo/BeverageFactory/`. This follows the Acme profile's `https://cesmii.net/profiles/…` pattern.
- **NodeIds** are string IDs built from the tag:
  - equipment: `s=FL-401`
  - children: by BrowsePath, `s=FL-401/Identification/SerialNumber`
  - hierarchy levels: by name, `s=Plant1/WaterTreatment`

  These are stable and readable, and they don't depend on where the node sits in the hierarchy.
- **BrowseName / DisplayName:** BrowseName `FL-401`; DisplayName `FL-401 Filler`.
- **i3X elementIds** are derived by the gateway from the URI-qualified NodeId (exact format to be settled in Phase 4).
- **Machinery identification:**
  - **ProductInstanceUri:** `<ManufacturerUri>/<model>/<serial>`, e.g. `https://globex.example/packaging/F60/GX-F60-20410`.
  - **YearOfConstruction:** spread between 2014 and 2024.
  - **Location:** `Plant 1 / Bottling Line 1`.

## 6. Simulation behaviour (Phase 3 preview)

- **Continuous side** (100, 300): flows set by demand. The filler draws from T-301; level control on T-301 drives the blender; the blender draws from DA-301 and P-203. T-101 and T-102 levels integrate in minus out, and XV-101 cycles on level.
- **Batch side** (200):
  - SD-201 heats to 70 °C, adds sugar, agitates, and holds until DT-201 reads 65 °Bx (about 45 min), then transfers to T-201.
  - T-202 is batched from T-201 + concentrate (XV-202), then released to the blender.
  - The Acme `Phases` (MixDone, HeatDone, ElapsedTime) and the `MachineryItemState` look-alike follow the batch.
- **Line:**
  - PackML states drive the rates (Execute = nominal speed; Held/Suspended/Stopped = 0).
  - Micro-stops are random, with StopReason codes.
  - Starved and blocked conditions propagate along the line.
  - Counts stay consistent: good count = upstream good minus rejects.
  - The Machinery `MachineryItemState` is mapped from PackML: Execute → Executing; Idle/Held/Suspended/Stopped → NotExecuting; Aborted → OutOfService.
- **Drift and noise:**
  - F-101 ΔP rises slowly, as the filter loads.
  - LT-901 CO₂ inventory falls.
  - All analog values get small sensor noise.
- **Shift pattern:** an optional CIP/changeover window per shift sets the line to Stopped and the OperationMode to Maintenance/Setup.
- **Line 1 is the healthy baseline.** Line 2's faults are designed later.

## 7. Review decisions (2026-11-05)

1. **Fictitious vendors** (Acme, Globex, Initech, Northwind, Vandelay) with `.example` URIs: **approved.**
2. **Namespace URI** `https://cesmii.net/i3x-demo/BeverageFactory/`: **approved.**
3. **Conveyor material links** (24–29): **not for now.**
4. **Accumulation conveyors:** **not modeled.** Starved and blocked stay as machine states only.
