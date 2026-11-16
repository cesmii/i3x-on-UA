# Phase 0: Standards Coverage for the Beverage Plant

*2026-11-05. Sources: the local NodeSets in `nodesets/standard/` (checked with `tools/resolve_check.py`) and the Pumps spec text (`docs/opcua/OPC-40223-Pumps-1.00.txt`).*

## Load set

All 11 standard NodeSets resolve against each other. The only gap is PA-DIM's IRDI dictionary entries: we have IRDI 1.00, PA-DIM wants 1.01.0, and 178 dictionary links don't resolve. They are semantic tags only and don't block anything.

| Model | Version | Used for |
|---|---|---|
| UA core | 1.05.03 | base |
| DI | 1.04.0 | Identification/nameplates, `IDeviceHealthType`, `ConnectsTo`, FunctionalGroups |
| IA | 1.01.2 | Stacklights |
| IRDI | 1.00 | PA-DIM dictionary entries (partial) |
| Machinery | 1.04.0 | Building blocks on machines and skids |
| Machinery ProcessValues | 1.00.0 | Setpoints and process values on units |
| PA-DIM | 1.01.0 | Field instruments and valves |
| PackML | 1.01 | Line machine state, mode, counts, stop reasons |
| Pumps (OPC 40223) | 1.0.0 | Pumps, inlet/outlet ports |
| ISA-95 Common Object Model (OPC 10030) | 1.00 (2013) | Plant hierarchy, equipment classes, materials |
| Weihenstephan (OPC 40210) | 1.00.0 | **Not used.** CESMII prefers pure Machinery + PackML. Kept for reference only; leave it out of the server's load set. |

## Coverage by plant element

| Element | Standard building blocks | Leftover for us? |
|---|---|---|
| **Enterprise / Site / Area / Line** | ISA-95 `EquipmentType` with `EquipmentLevel` (`ISA95EquipmentElementLevelEnum`: Enterprise 0, Site 1, Area 2, ProcessCell 3, Unit 4, ProductionLine 5, WorkCell 6, …, EquipmentModule 12, ControlModule 13). Nesting uses `MadeUpOfEquipment` (← `MadeUpOf` ← **Aggregates**, inverse `ContainedByEquipment`). | None |
| **Equipment kinds** (tank, blender, carbonator, …) | ISA-95 `EquipmentClassType` **instances** ("StorageTank", "Carbonator", …) linked with `DefinedByEquipmentClass` (non-hierarchical); class-level properties go in `EquipmentClassPropertyType`. | Instances only, **no new ObjectTypes** (see decision P1-a) |
| **Tanks / vessels** | No companion spec models them. Two options: the standards route (ISA-95 Equipment with level Unit or StorageUnit + the class + PA-DIM instruments as members + ProcessValues for setpoints), or the **vendor `MixingTankType`** from `nodesets/vendor/Acme-Mix-Tank-Profile.NodeSet2.xml` (reviewed below). | Vendor type (P1-a) |
| **Field instruments** (LT, FT, TT, PT, DT, CT, AT) | PA-DIM `PADIMType` devices with `AnalogSignalType` signals: `LevelMeasurementVariableType`, `FlowMeasurementVariableType` (+ `ActualVolumeFlowRateVariableType`, `TotalizerVariableType`), `TemperatureMeasurementVariableType`, `PressureMeasurementVariableType`, `ActualDensityVariableType`, `AnalyticalMeasurementVariableType`, `ConductivityMeterType` (analyser). They carry EngineeringUnits, which helps with discrepancy #12. | None |
| **Valves** (XV on/off, FCV control) | PA-DIM `PADIMType` with `TwoStateDiscreteControlSignalType` (on/off) or `ControlSignalType` (`ControlVariableType`, for positioners), plus discrete feedback signals | None |
| **Pumps** | Pumps `PumpType` (← DI `TopologyElementType`). It provides `PumpIdentificationType` (← Machinery `MachineIdentificationType`), measurement, supervision and maintenance groups, and **ports** in a `Ports` group (`PortsGroupType`): `InletConnectionPortType`, `OutletConnectionPortType`, `DrivePortType` (← abstract `PortType`, §7.36). | None |
| **Pipes / material flow** | **Confirmed in the Pumps spec (§6.2.1, §7.36, Table 81): ports say *what* may connect, but the spec defines no reference *for* connecting them.** `PortType` has optional `Category` ("only ports with the same category value are allowed to be connected"), `Direction` (`PortDirectionEnum`: In 0, Out 1, InOut 2; In connects only to Out/InOut), and `IdCarrier` (the asset the port belongs to), all based on AutomationML semantics. So **direction comes from each port's `Direction`**, and the link itself is our choice. Proposal: DI `ConnectsTo` (symmetric topology reference) from an Out port to an In port. Tanks and skids reuse the Pumps port types, which are plain ObjectTypes, so reuse is legitimate. The i3X layer synthesizes a directional `FlowsTo`/`FedBy` and flags it `synthesized`; the `ConnectsTo` choice itself is flagged as not spec-mandated. | None, but the connection reference is a documented convention, not a spec rule |
| **Process skids** (RO, dissolver, deaerator, blender, carbonator) | ISA-95 Equipment (Unit) + Machinery AddIns (Identification, MachineryItemState, OperationMode, Monitoring) + PA-DIM instruments + ProcessValues setpoints. No PackML (that's for packaging). | None |
| **Line machines** (filler … palletizer) | **Pure Machinery + PackML** (CESMII preference): PackML `PackMLBaseObjectType` (Status, Admin, `PackMLMachineStateMachineType`, `HasStopReason`/`HasAlarm`) + Machinery AddIns (Identification, MachineryItemState, OperationMode, Monitoring, OperationCounters). Found under Machinery's `Machines` folder. | None |
| **Stacklights** | IA `BasicStacklightType` under Machinery `Monitoring/Status` | None |
| **Health** | DI `IDeviceHealthType` (Machinery `Monitoring/Health`; PA-DIM devices have it built in) | None |
| **Consumption** (water, CO₂, air, electricity) | Machinery `Monitoring/Consumption` + ProcessValues / PA-DIM signals | None |
| **Materials** (classes, definitions, lots) *(added 2026-11-16)* | ISA-95 `MaterialClassType`, `MaterialDefinitionType`, `MaterialLotType` (+ `DefinedByMaterialDefinition`) | One ReferenceType: `DefinedByMaterialClass` (see "Beyond equipment") |
| **Personnel** (classes, persons) *(added 2026-11-16)* | ISA-95 `PersonnelClassType`, `PersonType` (+ `DefinedByPersonnelClass`) | None |
| **Orders** (work requests, job orders) *(added 2026-11-16)* | **Not in ISA-95 COM 1.00.** OPC 10031-4 (Job Control) has job orders, but as Structures passed to a `JobOrderReceiver`'s methods, not as Objects | `WorkRequestType`, `JobOrderType` |
| **Links between those models and equipment** *(added 2026-11-16)* | **Not in ISA-95 COM 1.00** | `Operates`, `Consumes`, `Produces`, `StoredIn`, `DispatchedTo` |

**Bottom line:** the *equipment* side of the plant needs **no ObjectTypes or ReferenceTypes of our own**; the only non-standard types there are the user-supplied Acme vendor profile. The personnel / materials / orders extension (2026-11-16) needs two ObjectTypes and six ReferenceTypes, kept in their own types namespace `https://cesmii.net/i3x-demo/ISA95Operations/`. The `BeverageFactory` namespace still holds only instances.

## Mapping consequences for the i3X layer (things to call out in `metadata.opcua`)

- **`MadeUpOfEquipment` subtypes Aggregates, not HasComponent.** Should it become i3X `HasChildren` (hierarchy) or `HasComponent` (composition)? Proposal: hierarchy, with a fidelity note.
- **`ConnectsTo` subtypes HierarchicalReferences**, but it's topology. The gateway must not treat it as a parent link. It becomes a graph edge (`ConnectsTo`, symmetric, its own reverse), plus the synthesized `FlowsTo`/`FedBy`.
- **ISA-95 classes are instances, not types.** Every tank's `typeElementId` is `EquipmentType`. Option: the gateway synthesizes i3X ObjectTypes from `EquipmentClassType` instances (flagged `synthesized`). That's ISA-95-aware logic, so it should be a pluggable "profile" rather than part of the generic core.
- **Machines have two parents:** the line and Machinery's `Machines` folder (`Organizes`). `parentId` = the line (P1-c, decided); `Machines` becomes a graph relationship.
- **Two state models on line machines:** PackML (18 states) and Machinery `MachineryItemState` (4 states). Both are exposed and the simulator keeps them consistent; the i3X layer shows both, and the fidelity notes explain how they relate.

## Vendor type review: Acme `MixingTankType`

`nodesets/vendor/Acme-Mix-Tank-Profile.NodeSet2.xml`, namespace `https://cesmii.net/profiles/AcmeMixTank`. Reviewed at v1.00 (2026-06-11); **v1.01 (2026-11-05) fixes item 5**, and the other departures are kept on purpose. It requires UA 1.05.03, DI 1.04.0, Machinery 1.04.0, PA-DIM 1.01.0 and ProcessValues 1.00.0; **all of its references resolve.** It defines 11 ObjectTypes and no instances. It's a realistic "vendor profile": it borrows standard pieces, but not always the way the specs intend.

**Structure of `MixingTankType`** (← BaseObjectType):
- `Identification`: `AcmeMachineIdType` (← Machinery `MachineIdentificationType`), Mandatory. It promotes every optional nameplate property to Mandatory, which is a legal tightening.
- `Component`: Machinery `MachineComponentsType`, holding `Drive` (`IDrive`: VfdFault, Ready, FaultCount, TorquePercent, OutputHz, OutputVolts) and `Motor` (`IMotor`: Running, RatedCurrent, Speed, Current, Load, Temperature, SealPressure, BearingTemperature, Vibration).
- `Equipment`: Machinery `MachineryEquipmentFolderType`, holding `Mixer` (agitator nameplate via DI `IVendorNameplateType`).
- `Monitoring`: `MixTankMonitoring` ← `MonitoringAcmeType` ← FolderType, with:
  - `Health`: FaultCode, FaultReason
  - `Status`: `MachineryItemState`, `OperationMode`
  - `Process`: `Tank` (`ProcessVesselType`: Level, LevelPercent, Pressure, Temperature as ProcessValues `ProcessValueType` with setpoints), `CleanInPlace` (CipMode, LastCip), `Phases` (ElapsedTime, MixDone, HeatDone)
- Defined but unused: `ICleanInPlaceMaterials`, `ICleanInPlaceSystem`.

**Departures from the standards** (each becomes a fidelity or quality note; useful demo material):
1. **Interfaces used as TypeDefinitions.** `Drive` → `IDrive`, `Motor` → `IMotor`, `CleanInPlace` → `ICleanInPlaceEquipment` (all ← `BaseInterfaceType`, abstract), and `Mixer` → Machinery `IMachineryEquipmentType` (abstract). OPC UA Interfaces are applied with `HasInterface`; they can't be the TypeDefinition of an Object. ⚠️ **Phase 2 risk:** node-opcua may refuse to instantiate these, or instantiate them inconsistently.
2. **Look-alike Machinery state machines.** `Status/MachineryItemState` and `Status/OperationMode` are plain `BaseObjectType` objects with a `String` `CurrentState`, not `MachineryItemState_StateMachineType` / `MachineryOperationModeStateMachineType`. A client looking for the Machinery types won't find them.
3. **Monitoring is not Machinery `MonitoringType`.** It's a FolderType subtype with the same folder names. `Health` doesn't implement DI `IDeviceHealthType`.
4. **`Component` is attached by `Organizes` and named `Component`.** Machinery uses `Components` via HasComponent/HasAddIn. Its `Drive`/`Motor` lack the `2:Identification` that Machinery §11 requires of each component.
5. ✅ **Fixed in Acme 1.01** (`docs/acme/CHANGELOG.md`). *Was:* **shared type-level nodes**, the same SiOME pattern as PMMI: Identification's `SerialNumber`/`ProductInstanceUri` point at Machinery's own declarations; every `ProcessValueType` member points at ProcessValues `AnalogSignal` and PA-DIM `SignalTag`; `Mixer` points at Machinery's `MachineryEquipmentTypeId`.
6. **Units in descriptions** ("in lpm", "in degrees C", "in Percent") rather than in `EngineeringUnits` (where it's present, it has no value). Percent levels are `Int16`, and counters/codes are `Int64`, which runs into the JSON precision question.
7. **Misplaced descriptions:** `ICleanInPlaceEquipment` says "Last CIP in hours", and `ICleanInPlaceSystem` says "Elapsed time of CIP in seconds".
8. **The vessel is buried in Monitoring.** The tank's own process values live at `Monitoring/Process/Tank`. The type has no ports, so no flow connections; we'd add Pumps ports to instances (Optional additions are legal on instances).

**Proposed use:** the syrup room's mixing vessels (SD-201 dissolver, T-201, T-202) as Acme `MixingTankType`, the realistic "vendor skid" case. Storage and buffer tanks (T-101, T-102, T-301) use the ISA-95 Equipment route. The model then shows both a standards-pure and a vendor-profile tank, and the i3X fidelity metadata has to describe each honestly.

## Phase 1 decisions this raises

- **P1-c Machine parent (decided 2026-11-05):** machines are **direct children of their line** (in practice, nobody groups machines into folders). Machinery's `Machines` folder stays in the UA model because the spec requires it (§9, the "Find Machines" conformance unit). In i3X it appears only as a graph relationship, with a fidelity note.

- **P1-a Tanks (decided 2026-11-05):** Acme `MixingTankType` for the mixing vessels (SD-201, T-201, T-202); ISA-95 Equipment for storage/buffer tanks (T-101, T-102, T-301).
- **P1-b Flow (decided 2026-11-05):** Pumps port types (`Direction`, `Category`) joined by DI `ConnectsTo` from Out port to In port. This is our documented convention, flagged in i3X as not spec-mandated.

## Beyond equipment: ISA-95 COM 1.00 checked for personnel, materials and orders (2026-11-16)

Design: `PLANT_DESIGN.md` §8. Types: `factory/src/ops-types.ts` → `nodesets/factory/ISA95Operations.NodeSet2.xml`.

**What COM 1.00 covers and what we use as-is:** `PersonnelClassType`, `PersonType`, `DefinedByPersonnelClass`; `MaterialClassType`, `MaterialDefinitionType`, `MaterialLotType` (optional `Status`, `StorageLocation`, `Quantity`), `DefinedByMaterialDefinition`.

**Gaps, and what we added (ISA95Operations namespace):**

| Gap | Added | Basis for the name |
|---|---|---|
| No work model (Part 4): no work request or job order Objects. OPC 10031-4 has job orders only as Structures (`ISA95JobOrderDataType`) on a `JobOrderReceiver`, so an i3X client would see an array value, not an order hierarchy | `WorkRequestType`, `JobOrderType` (← COM `ISA95ObjectType`) | ISA-95 Part 4 objects; field and state names from OPC 10031-4 |
| No reference from a MaterialDefinition to its MaterialClass (equipment and personnel have `DefinedByEquipmentClass` / `DefinedByPersonnelClass`) | `DefinedByMaterialClass` / `MaterialClassOf`, subtype of COM's abstract `DefinedBy` | COM's own naming pattern |
| No references between resource models or from work to resources | `Operates`/`OperatedBy`, `Consumes`/`ConsumedBy`, `Produces`/`ProducedBy`, `StoredIn`/`StorageLocationOf`, `DispatchedTo`/`ReceivesJobOrder`, all ← `NonHierarchicalReferences` | ISA-95 vocabulary: material use Consumed/Produced, MaterialLot "Storage Location", dispatching, 10031-4 JobOrderReceiver |

**Defects in the COM 1.00 NodeSet found on the way** (kept as-is: we never modify OPC Foundation NodeSets; candidates for the WG and OPC Foundation):

1. `MaterialDefinitionType`'s `<MaterialClass>` placeholder (i=5224) has **no reference from the type at all**, only a `ParentNodeId`. Compare `PersonType`'s `<PersonnelClass>`, which hangs off `DefinedByPersonnelClass`.
2. `DefinedByMaterialDefinition` (i=5301) has InverseName **`MaterialClassOf`**: a copy-paste slip (expected `MaterialDefinitionOf`). It shows up in i3X as the relationship type `ISA95:MaterialClassOf` on a material definition, next to our correctly named `ISA95Operations:MaterialClassOf`.
3. `LocatedIn` / `LocationOf` (i=5114), the obvious candidate for a lot's storage location, is a **subtype of `HasProperty`**, and its Description is copied from `ResultsForSpecification` ("…test results…"). A HasProperty target must be a Property, so it can't link a lot to equipment. A generic gateway would treat the target as an attribute. Hence our `StoredIn`.
4. `MaterialLotType`'s `<MaterialDefinition>` (i=5242) has a placeholder-style BrowseName but ModellingRule **Optional**, not a placeholder. We reference the shared definition instead of instantiating it.
5. A lot's `Quantity` has no DataType (BaseDataType) and no unit. The generator writes a Double and adds an `EngineeringUnits` Property, as it already does for equipment ratings.
