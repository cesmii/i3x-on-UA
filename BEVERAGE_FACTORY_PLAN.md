# Virtual Beverage Factory: Plan

*Draft 2026-11-05. Built in phases, not in one go. Each phase ends with something we can look at.*

## 1. Goal

Build a virtual beverage plant (water treatment, syrup, blending and carbonation, bottling, packaging) as **two views of one model**:

1. **The OPC UA layer.** It is strictly standards-based. Someone browsing with any OPC UA client (UaExpert, etc.) should recognize the DI, Machinery, PackML, PADIM, ProcessValues, IA and other companion-spec parts. Only the true gaps get our own types.
2. **The i3X layer.** A generic gateway projects that address space into i3X 1.0. Wherever the projection loses something, the i3X entity says so in its own metadata, so it describes itself.

**Done when** someone can open UaExpert and i3X Explorer side by side, find the same filler, tank or flow meter in both, and use the i3X metadata to tell exactly what was simplified and why.

## 2. Decisions taken (2026-11-05)

| # | Decision | Choice |
|---|---|---|
| D1 | OPC UA server stack | **node-opcua** (TypeScript). It loads our NodeSet2 files directly. |
| D2 | i3X layer architecture | **A separate, generic OPC UA → i3X gateway.** It is an OPC UA client and knows nothing about the factory beyond what it can browse. |
| D3 | Standards gaps (tanks, pumps, valves, flow, plant hierarchy) | **Bring in more OPC companion specs first.** Our own namespace holds only what's left over. |
| D4 | Where fidelity notes go | **A dedicated top-level metadata key** (proposed: `metadata.opcua`, see §6) on Objects, ObjectTypes, RelationshipTypes and Namespaces. The WG has accepted metadata on non-Object entities. |
| D5 | Line machines | **Pure Machinery + PackML** (CESMII preference). Not PMMI's `PmmiMachine`, not Weihenstephan. |
| D6 | Second line | **Bottling Line 2 will come later.** It's a similar model with deliberate problems that hack-a-thon participants diagnose. The plant definition and simulator must therefore support a **fault/scenario layer** from the start (§4). |
| D7 | Source control | Stay local for now; the user will `git init` later. |
| D8 | Deployment | Behind an **Nginx reverse proxy** on the user's web server, which handles TLS and auth. The gateway serves plain HTTP, takes a configurable base path, and respects `X-Forwarded-*`. SSE needs `proxy_buffering off` (to document in Phase 7). |
| D9 | Competing interpretations | **Our gateway is built independently.** A WG member has another OPC UA → i3X gateway that is deliberately not shared with us. When ours is done we deliver a **switch config + launcher** that runs ours, his, or both side by side against the same OPC UA server, so the WG can compare them (decided 2026-11-05). Ours must therefore be a self-contained process: OPC UA endpoint in, i3X `/v1` out, configured by file or env. **Delivered 2026-11-05:** `compare/` (`gateways.yaml` + `npm run compare`); the WG gateway is Andreas Heine's i3x2ua (pinned container). |

## 3. Architecture

```
 ┌──────────────┐   OPC UA (opc.tcp)   ┌───────────────────────┐   i3X REST + SSE   ┌──────────────┐
 │ Factory sim  │──► node-opcua server ├──────────────────────►│ i3X gateway (generic)├──────────────────►│ i3X Explorer │
 │ (mass balance│   ns0, DI, IA, Mach, │  Browse / Read /      │  browse cache → i3X  │  /v1/...           └──────────────┘
 │  PackML SMs) │   PackML, PADIM, PV, │  HistoryRead /        │  namespaces, types   │
 └──────────────┘   + companion specs, │  Subscriptions        │  (JSON Schema),      │                    ┌──────────────┐
                    + BeverageFactory  │                       │  objects, values,    │◄── opc.tcp ────────│ UaExpert     │
                    types & instances  │                       │  subs, metadata.opcua│   (side-by-side)   └──────────────┘
                                       └───────────────────────┘
```

- **The server** loads the standard NodeSets, our own types NodeSet and an **instance NodeSet**. A simulator drives the values.
- **The gateway** uses only OPC UA services. If it works against our server, it should work against other OPC UA servers that use the same specs. That makes it the reusable deliverable for the WG.

## 4. The plant (first cut; refined in Phase 1)

Diagrams: `docs/factory/PLANT_DIAGRAM.md` (process flow + ISA-95 hierarchy). That file is the source; the `.mmd` exports in the same folder are for Mermalaid.

One site with one bottling line and a single product: a 500 mL carbonated soft drink in PET, at about 24,000 bottles/h (400/min).

**Hierarchy (ISA-95 style):** Enterprise → Site → Areas → Units/Machines.

| Area | Units | Key measurements (UNECE units) |
|---|---|---|
| **Water Treatment** | raw water tank, carbon filter, RO skid, treated water tank, transfer pump | level (m / %), flow (m³/h), conductivity (µS/cm), pressure (bar), temperature (°C) |
| **Syrup Room** | sugar dissolver, simple-syrup tank, final-syrup tank (with concentrate dosing), syrup pump | level, temperature, density/Brix, flow |
| **Blending & Carbonation** | in-line blender (water + syrup at about 5:1), deaerator, carbonator, CO₂ supply, product buffer tank | ratio, Brix, CO₂ volumes, pressure, temperature, flow |
| **Bottling Line 1** | filler, capper, labeler, case packer, palletizer (PackML machines) | PackML state and mode, speed (bottles/min), good/reject counts, stop reason, stacklight |
| **Utilities** *(later)* | compressed air, CIP | consumption (Machinery Monitoring/Consumption) |

**Material flow** (directional, and needs to be visible in both layers):
raw water → filter → RO → treated water → {dissolver, blender} ; syrup → blender → carbonator → buffer → filler → capper → labeler → case packer → palletizer.

**Simulation realism:**
- **Mass balance:** tank levels integrate inflow minus outflow, and the filler draws from the buffer.
- **Consistent counts:** the filler count matches downstream counts, minus rejects.
- **PackML states drive the rates:** Execute means running, Held or Suspended means zero flow.
- **Starved/blocked propagation:** an empty buffer starves the filler, and a full palletizer blocks upstream.
- **Faults:** occasional faults with stop reasons, sensor noise, and a "lost connection" device reporting `Bad_NotConnected`.

**Scenario layer (for Line 2 and the hack-a-thon):** each line's behavior is a baseline plus a named, switchable set of injected problems. Candidates include:
- a drifting flow meter
- a filler under-filling while the reject count stays flat
- a labeler that is starved because the capper is micro-stopping
- a wrong engineering unit on one transmitter
- a CO₂ pressure sag that lowers carbonation
- an intermittent `Bad_NotConnected`
- a PackML state stuck in Held

Each problem is visible through i3X alone, with UaExpert available for confirmation. Line 1 stays the healthy reference.

## 5. Standards mapping

> **Superseded by Phase 0:** see `docs/factory/STANDARDS_COVERAGE.md`. The headline: Pumps, ISA-95 COM, PA-DIM (which also covers valves), Machinery and PackML cover nearly everything, so we likely need **no custom ObjectTypes or ReferenceTypes**. Tanks become ISA-95 Equipment + EquipmentClass instances; flow is Pumps inlet/outlet ports joined by DI `ConnectsTo` (⚠️ to confirm). Weihenstephan is not used. The table below is the original first cut, kept for history.

| Concept | Standard to use | Notes / fallback |
|---|---|---|
| Plant hierarchy (Enterprise/Site/Area/Line) | **ISA-95 Common Object Model (OPC 10030)** equipment model | To verify in Phase 0: its types and its hierarchy ReferenceTypes. Fallback: FolderType + Organizes, with the ISA-95 level in our namespace. |
| Line machines (filler … palletizer) | **Machinery** building blocks (Identification, Monitoring, MachineryItemState, OperationMode, counters) + **PackML** state machine, Status and Admin objects (StopReason, counts) | Phase 1 decision: instantiate the **PMMI `PmmiMachine`** pattern as-is, or build pure Machinery + PackML (PMMI has known departures; see CLAUDE.md). Consider **Weihenstephan (OPC 40210)** for beverage-line data. |
| Field instruments (flow, level, pressure, temperature, density, conductivity) | **PADIM** `PADIMType` devices with `AnalogSignalType` signals (`FlowMeasurementVariableType`, `LevelMeasurementVariableType`, …), DI Identification/Health | Strong fit. All local already. |
| Process values / setpoints on units | **ProcessValues** `ProcessValueType` | Local. |
| Pumps | **Pumps & Vacuum Pumps (OPC 40223)** | To fetch. |
| Tanks, valves, dissolver, carbonator, blender | **Unknown → likely our `BeverageFactory` namespace**, subtyping DI/Machinery bases | Phase 0: search for a companion spec before inventing anything. |
| Material flow between units | **Probably our own `FlowsTo`/`FedBy` ReferenceType** (NonHierarchical) | DI `ConnectsTo` is symmetric and hierarchical (network topology), so it can't show direction. Check ISA-95 COM first. |
| Stacklights | **IA** `BasicStacklightType` | Local. |
| Health / alarms | **DI** `IDeviceHealthType`; PackML `HasStopReason`/`HasAlarm` | Events are out of scope for i3X 1.0; surface them as values (a fidelity note). |

**Rule:** before a type goes into our namespace, Phase 0 must record which spec was checked and why it didn't fit. That record goes into the type's `metadata.opcua` in the i3X layer.

## 6. i3X projection and fidelity metadata (proposal)

The projection rules follow the mapping notes in CLAUDE.md and the decisions in `NODESET_TO_JSON_SCHEMA_ANALYSIS.md`. What this project adds is a **consistent fidelity record**:

```jsonc
"metadata": {
  "typeNamespaceUri": "...", "sourceTypeId": "nsu=http://opcfoundation.org/UA/PackML/;i=...",
  "opcua": {
    "nodeId": "nsu=http://example.org/BeverageFactory/;s=Line1.Filler",   // source node (URI-qualified)
    "browseName": "1:Filler", "nodeClass": "Object",
    "fidelity": [
      { "aspect": "methods",      "loss": "dropped",     "detail": "PackML commands (Start, Stop, Reset, …) are not exposed; i3X 1.0 has no method call." },
      { "aspect": "stateMachine", "loss": "flattened",   "detail": "PackMLMachineStateMachineType collapsed to {state, stateNumber}; 18 states and transitions only in the type schema." },
      { "aspect": "parent",       "loss": "multiPath",   "detail": "Also reachable via MachineryBuildingBlocks; represented as graph relationship, not a second parent." }
    ]
  }
}
```

- **`loss` is a small open vocabulary:** `dropped`, `flattened`, `approximated`, `renamed`, `synthesized`, `multiPath`, `typeChanged`. It stays open the same way `quality` is open.
- **Placement:** each entity carries its own losses.
  - A **Namespace** lists projection-wide losses and uses the `?projection=i3X` URI.
  - An **ObjectType** lists dropped members (methods, events), interface folding and placeholder handling.
  - A **RelationshipType** gives its source ReferenceType and supertype chain, and how a symmetric or inverse name was handled.
  - An **Object** lists only losses that are specific to that instance.
- **Losses we expect on day one:** methods; events and alarms; state machines; multiple parents; `HasInterface` folding; LocalizedText locale; Int64 precision; engineering units (discrepancy #12); type-level references; the dictionary entries (IRDI) for PADIM.

## 7. Phases

| Phase | Deliverable | We can look at… | Exit check |
|---|---|---|---|
| **0. Standards gap closure** ✅ *2026-11-05* | NodeSets fetched and organized into `nodesets/standard/`; `tools/resolve_check.py`; `docs/factory/STANDARDS_COVERAGE.md`; plant diagrams | Coverage table + Mermaid diagrams | All resolve (except the IRDI 1.01 gap, which is non-blocking); leftovers justified. |
| **1. Plant design** ✅ *signed off 2026-11-05: `docs/factory/PLANT_DESIGN.md`* | `docs/factory/` design: process flow diagram, equipment list, instrument tag list with types and units, PackML/Machinery decision for machines, ID and naming scheme | A reviewable diagram and tag list | You sign off on the plant. |
| **2. UA model** ✅ *built 2026-11-05: `npm run generate` / `verify` (441/441), served by `npm start -w server`; awaiting UaExpert review. See `docs/factory/UA_MODEL_NOTES.md`* | `BeverageFactory` types NodeSet (leftover types only) + instance NodeSet **generated from a declarative plant file** (YAML → NodeSet2.xml), so the model is also a static artifact | The full plant in UaExpert (static values) | Loads in node-opcua; references resolve; standard parts recognizable in UaExpert. |
| **3. UA server + simulation** ✅ *built 2026-11-05: `docs/factory/SIMULATION.md`; 24 sim-hours, all invariants hold* | node-opcua server, simulator (mass balance, PackML), in-memory history, StatusCode scenarios | Live values and state changes in UaExpert | 1 hour run with consistent levels and counts and no drift. |
| **4. Gateway: address space** ✅ *built 2026-11-05: `docs/gateway/MAPPING.md` + `GATEWAY.md`; conformance CORE + EXP all pass* | Generic browse/cache → `/info`, `/namespaces`, `/objecttypes`, `/relationshiptypes`, `/objects`, `/objects/list`, `/objects/related` with `metadata.opcua` | The plant in i3X Explorer (no values yet) | Explorer browse and relationship graph; explore part of the conformance tests passes. |
| **5. Gateway: data** ✅ *built 2026-11-05: conformance 55/55 MUST-level pass ("1.0 Compatible"); see `docs/gateway/GATEWAY.md`* | `/objects/value` (maxDepth), `/objects/history` (HistoryRead), subscriptions (UA MonitoredItems → sync + SSE), optional writes (RW Identification, setpoints) | Live trends in Explorer next to UaExpert | Full conformance suite passes; values match UaExpert. |
| **6. Fidelity pass** | Audit every entity's fidelity notes against the UA source; side-by-side walkthrough script | A guided compare: "find X in both" | Every known loss is described somewhere it can be found. |
| **7. WG packaging** | Findings fed back into the analysis doc's decisions list and a proposed `metadata.opcua` convention; demo notes | Demo | Ready to present. |

**Phase dependencies:** 0 → 1 → 2 → 3. Phase 4 can start right after Phase 2, against static values. Phases 5 and 6 come after 3 and 4.

## 8. Layout

```
i3x-on-OPC/
  nodesets/standard/   OPC Foundation companion NodeSets (done)
  nodesets/factory/    BeverageFactory instances (generated) + any leftover types
  factory/             plant definition (YAML) + scenarios, NodeSet generator, simulator
  server/              node-opcua server
  gateway/             generic OPC UA → i3X gateway (TypeScript) + optional profiles (e.g. ISA-95 class synthesis)
  tools/               resolve_check.py, etc.
  docs/i3x, opcua, machinery, pmmi   reference material
  docs/factory/        design docs, diagrams, coverage, tag list
```

## 9. Open questions

Answered 2026-11-05 → D5–D8. Still open, for Phase 1:

1. ~~P1-a Tanks~~ **Decided:** Acme `MixingTankType` for the mixing vessels (SD-201, T-201, T-202); ISA-95 Equipment for storage/buffer tanks.
2. ~~P1-b Flow~~ **Decided:** Pumps ports joined by DI `ConnectsTo` (Out → In), flagged as our convention.
3. ~~P1-c `parentId` policy~~ **Decided:** machines are direct children of their line; Machinery's `Machines` folder is kept in UA (spec-required) and appears only as a graph relationship in i3X.
4. ~~Hack-a-thon problem types~~ **Deferred:** Line 2 problems will be designed later.
