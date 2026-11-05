# Phase 2: OPC UA Model Notes

## Spike results (2026-11-05)

`factory/src/spike.ts` (`npm run spike -w factory`) with node-opcua **2.187.10** / node-opcua-address-space **2.187.9**:

| Check | Result |
|---|---|
| Load the 10 standard NodeSets + Acme (Weihenstephan excluded) | ✅ ~1 s. Only warnings: the known IRDI 1.00 vs 1.01.0 gap and "Cannot process any more dataTypeDictionary" (legacy dictionary info, harmless) |
| Instantiate Acme `MixingTankType`, including children typed by Interfaces (`IDrive`, `IMotor`) | ✅ node-opcua instantiates them without complaint. UA clients will still show Interface types as TypeDefinitions, which is the defect we want visible |
| Instantiate PackML `PackMLBaseObjectType`, Pumps `PumpType` (+ `Ports`), PA-DIM `PADIMType`, ISA-95 `EquipmentType` | ✅ |
| Attach Machinery `MachineIdentificationType` and `MachineryItemState_StateMachineType` as **AddIns** (`HasAddIn`) to a PackML machine | ✅ |
| Export our namespace with `toNodeset2XML()`, then reload it on top of the standard NodeSets | ✅ round-trips |

## Conventions the spike fixed

- **Child NodeIds use `/`.** Set `NamespaceOptions.nodeIdNameSeparator = "/"` before instantiating. node-opcua then derives children from the parent's string NodeId: `s=SD-201/Component/Drive/OutputHz`. That matches the ID scheme in `PLANT_DESIGN.md` §5 and avoids clashing with the `-` inside tags.
- **Always pass `namespace: <our namespace>`** to `instantiate()`. Otherwise node-opcua uses the address space's default "own" namespace and fails on the namespace check with an empty assertion error.
- **Optional members** (Acme `Monitoring`, `Equipment/Mixer`; Pumps `Ports`; Machinery identification extras) must be listed in `optionals: [...]`, or the generator adds them afterwards.
- **In the exported file our namespace is `ns=1`.** NodeIds are always namespace-relative, so the gateway must use `nsu=` forms, never indexes (as CLAUDE.md already says).

## Shared type-level nodes: fixed at the source (Acme 1.01)

The spike showed that Acme 1.00 shared InstanceDeclarations across parents, so node-opcua created one `AnalogSignal` and one `SignalTag` per tank, shared by all 13 process values.
- **First approach (superseded):** the generator patched each instance.
- **Fix (2026-11-05):** Acme is CESMII-owned, so the NodeSet itself was repaired and released as **1.01**. `tools/repair_shared_declarations.py` re-pointed 80 references and added 548 per-declaration nodes. See `docs/acme/CHANGELOG.md`; the 1.00 file is archived in `docs/acme/`.
- **Result:** the generator does no vendor repair any more. The verifier's "no variable with several parents" check passes on a plain instantiation.
- **PMMI** has the same defect, but PMMI isn't ours, so it stays documented and unfixed.

## Generator (built 2026-11-05)

```
npm run generate -w factory   # factory/plant/line1.yaml → nodesets/factory/BeverageFactory.NodeSet2.xml
npm run verify -w factory     # reload from scratch on top of the standard NodeSets, then 441 checks against the YAML
npm start -w server           # opc.tcp://localhost:4840/UA/BeverageFactory (anonymous; SecurityMode None, Sign or SignAndEncrypt)
python3 -I tools/resolve_check.py nodesets   # independent cross-file reference check
```

| File | Role |
|---|---|
| `factory/plant/line1.yaml` | Plant definition (source of truth): units (UNECE), vendors, ISA-95 classes, areas → equipment → ports and instruments, flow links |
| `factory/src/plant.ts` | Types + validation: unique tags; known classes, vendors and units; links Out → In with the same Category; nominal values within range |
| `factory/src/build.ts` | Builders per kind (`isa95`, `acmeTank`, `pump`, `packml`), Machinery building blocks, Pumps ports + `ConnectsTo`, PA-DIM devices |
| `factory/src/verify.ts` | Structural checks on the reloaded NodeSet. A tamper test (deleting one `ConnectsTo`) makes it fail as expected |
| `factory/src/tools/inspect-type.ts` | Prints a type's InstanceDeclaration tree, including inherited members and modelling rules |
| `factory/src/tools/browse.ts` | A generic OPC UA client browse of the running server (`nsu=` start nodes supported) |
| `server/src/main.ts` | node-opcua server: standard + vendor + generated NodeSets, static values |

**Result:** 1,873 nodes (1.2 MiB). Output is **byte-identical across runs**, because the publication date and serials are fixed and serials come from an FNV hash of the tag.

**What each kind becomes:**
- **`isa95`:** `EquipmentType` + `EquipmentLevel` + `DefinedByEquipmentClass` → class in `Objects/EquipmentClasses`. Ratings are `EquipmentPropertyType` via `HasISA95ClassProperty` (that's how the ISA-95 1.00 NodeSet declares them), each with an `EngineeringUnits` property. Children of an area are linked with `MadeUpOfEquipment`.
- **`acmeTank`:** vendor `MixingTankType` with optionals `Monitoring`, `Monitoring.Process.Phases`, `Equipment.Mixer`, plus Acme nameplate and Mixer nameplate. The type ships no units, so the generator supplies EngineeringUnits for its 13 ProcessValues. Linked from its area with `Organizes`.
- **`pump`:** Pumps `PumpType` with the Identification nameplate, `Operational/Measurements` (DifferentialPressure, FluidTemperature, PumpPowerInput, Speed, with units) and `Ports`. Linked with `Organizes`.
- **`packml`:** `PackMLBaseObjectType` with PackMLVersion, TagID, `Admin` (MachDesignSpeed, ProdProcessed/Defective/ConsumedCount, StopReason, StateCurrentTime, AccTimeSinceReset), and speeds in min⁻¹. Linked with `Organizes`.
- **`machinery: true` (and every PackML machine):**
  - a `MachineryBuildingBlocks` folder, with HasAddIn → Identification, MachineryItemState, MachineryOperationMode, Monitoring (+ OperationCounters on PackML machines);
  - Identification, Monitoring and OperationCounters are **also** AddIns of the item itself (§7.3: one node, two paths);
  - `Monitoring/Status` `Organizes` both state machines (§16);
  - initial states are NotExecuting and Processing, with `CurrentState` + `Id` + `Number` taken from the states on the type.
- **Machines folder:** every pump, Acme tank, PackML machine and `machinery: true` skid is `Organizes`-ed from Machinery's `Machines` (i=1001).
- **Ports:** Pumps `PortsGroupType` (`Ports`) with `Inlet`/`OutletConnectionPortType`, and `Category`/`Direction`/`IdCarrier` set; DI `ConnectsTo` runs Out → In.
- **Instruments and valves:** PA-DIM devices that are `HasComponent` children of their equipment, carrying the full nameplate and `DeviceHealth` = NORMAL.
  - Each device has `SignalSet/<role>` (Level, Pressure, Flow, Density, Temperature, Concentration, Conductivity, Valve) with `SignalTag` = the tag.
  - Analog signals get the measurement-specific VariableType (e.g. `LevelMeasurementVariableType`), EngineeringUnits, EURange and a nominal value.
  - Valves use `TwoStateDiscreteControlSignalType` (Open/Closed) or `ControlSignalType` (% open, 0–100).
- **Acme 1.01** instantiates cleanly; no repair is needed (see above). The generator only adds what the vendor type leaves empty: EngineeringUnits values for the 13 ProcessValues, and each one's PA-DIM `SignalTag` (`<tag>/<path>`).
- **Site-boundary items** (`RawWaterMain`, `Drain`, `SugarSupply`, `ConcentrateSupply`): ISA-95 Equipment of class `ExternalConnection` (level Other). They exist so that the links leaving the plant have port owners.

**Deferred** (not needed for the Phase 2 exit; candidates for Phase 3):
- IA stacklights;
- Monitoring `Health` (DI `IDeviceHealthType`) and `Consumption`;
- `LifetimeCounters`;
- pump ratings into Pumps `Configuration/Design`;
- ProcessValues setpoints on skids;
- dynamic values (PackML counts and states, process values), which belong to the simulator.

## Standards observations (for the WG comparison)

Things the standards make awkward, kept as-is in the model because that's how the specs read. Each is a candidate i3X fidelity note.

1. **ISA-95 `EquipmentLevel` is a Property attached by a component reference.** In ISA-95 COM 1.00 it's a `PropertyType` variable, but it's attached with `HasISA95Attribute`, a subtype of **HasComponent**, not HasProperty. A client that classifies children by reference type alone (Property vs. Component) gets it wrong. Its value is a bare enum index (`ISA95EquipmentElementLevelEnum` via `EnumStrings`), so clients that don't resolve enums show "4" rather than "Unit". The user's reaction on review: "I don't love it".
2. **Ratings on ISA-95 equipment** use `EquipmentPropertyType` via `HasISA95ClassProperty`. The *class*-property reference is used on an *instance*-level type, and there's no built-in unit, so the generator adds an `EngineeringUnits` property.
3. **PA-DIM DisplayNames** come from the IEC 61987 dictionary ("URI product inst.", "Device diagnostic status"). That's correct per PA-DIM, but it reads oddly next to the BrowseNames (`ProductInstanceUri`, `DeviceHealth`).
4. **Pumps ports define no connecting reference.** We use DI `ConnectsTo` by convention (P1-b), and `ConnectsTo` is *hierarchical*, so a naive "hierarchy = parent/child" mapping would make a pipe look like containment.
