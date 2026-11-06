# Fidelity catalogue: what the cesmii gateway loses, and where it says so

*Phase 6, 2026-11-05. Exit check: "every known loss is described somewhere it can be found". **Met:** the audit reports 40 rules, 6,170 checks, 0 gaps against Line 1.*

Our gateway describes losses in `metadata.opcua.fidelity: [{aspect, loss, detail}]` at four levels (MAPPING.md §0.3):

- **Object:** the loss is specific to this instance.
- **ObjectType:** the loss comes from the type.
- **RelationshipType:** the loss is about the relationship.
- **Namespace:** the loss applies to every projected entity, e.g. how values are encoded.

Sometimes the fact itself is carried in metadata instead, e.g. `metadata.opcua.methods` or `historizing`; that counts as "found".

`loss` is an open vocabulary: `dropped`, `flattened`, `approximated`, `renamed`, `synthesized`, `multiPath`, `typeChanged`.

## The audit

```
node --import tsx gateway/src/tools/fidelity-audit.ts [--i3x http://localhost:8081/v1] [--opcua opc.tcp://…] [--json out.json] [--gaps N]
```

It needs the plant server and the gateway running (e.g. `./start.sh`). It exits 1 if any loss is undescribed.

The audit is **independent of the gateway's code**:
1. It browses the OPC UA server as a plain client (Browse and Read from `Objects`, every hierarchical path, plus every reference, attribute and type declaration it needs).
2. It reads the gateway only through the i3X API.
3. For each OPC UA fact that i3X can't carry as-is, it checks that the i3X side describes it at an allowed level.

A gap therefore means "a client can't find out about this loss", whatever the gateway thinks it did.

## The catalogue

Levels: **O** Object · **T** ObjectType · **R** RelationshipType · **N** Namespace · **M** a metadata field that carries the fact.

Counts are for Line 1.

### Structure

| Loss | Count | Where it's described | Example (cesmii elementId suffix after `;s=`) | Audit rule |
|---|---|---|---|---|
| Node reached by several hierarchical paths; i3X allows one parent | 63 | **O** `parent` (`multiPath`) + `metadata.opcua.otherParents`; the extra paths are graph edges whose **R** says `multiPath` | `FL-401` (also under `Machines`), `FL-401/Identification` (also under `MachineryBuildingBlocks`) | `hierarchy.multiPath`, `relationshipType.multiPath` |
| Symmetric hierarchical `ConnectsTo` is topology, not containment | 23 refs | **R** `DI:ConnectsTo` `semantics` | `FL-401/Ports/BeverageIn` | `ref.ConnectsTo`, `relationshipType.symmetricHierarchical` |
| Material flow synthesized from ports (not an OPC UA reference) | 2 types | **R** `FlowsTo`/`FedBy` `relationship` (`synthesized`) | `T-101` → `FlowsTo` | `relationshipType.synthesized` |
| Properties become attributes of the owner's value | 725 | value schema (**T**) or `schemaExtensions`; **N** `properties` | `FL-401/Identification` value | `property.findable`, `property.flattened` |
| A Variable's Properties (EngineeringUnits, EURange, …) move to metadata | 145 | **O** `variableProperties` + **M** `metadata.opcua.properties` | `LT-101/SignalSet/Level/AnalogSignal` | `variable.properties` |
| Complex Variable: has a value **and** DataVariable children | 9 | **O** `complexVariable` | `FCV-301/SignalSet/Valve/ControlSignal` | `variable.complex` |
| Interface used as a TypeDefinition (Acme profile) | 12 | **O** `typeDefinition` | `SD-201/Equipment/Mixer` | `type.interfaceAsTypeDefinition` |
| ns0 infrastructure not projected (Server, Aliases, Locations); Views | 3 | **N** (UA) `notProjected`, naming each node | — | `notProjected.infrastructure` |
| Historian configuration Objects not projected | 234 | **N** `references` (HasHistoricalConfiguration) + **M** `historizing` | `CK-404/Admin/AccTimeSinceReset` | `notProjected.historicalConfiguration`, `ref.HasHistoricalConfiguration(external)` |
| Plumbing references (HasTypeDefinition, HasModellingRule, HasInterface, HasDictionaryEntry, event plumbing) | — | **N** `references`, saying where each one went instead | — | `ref.*` |

### Behaviour

| Loss | Count | Where it's described | Example | Audit rule |
|---|---|---|---|---|
| Methods aren't callable | 5 Objects, 9 types | **O**/**T** `methods` + **M** `metadata.opcua.methods` | `FL-401` (SetMachSpeed, SetParameter, SetProduct, SetUnitMode) | `methods.*`, `type.methods` |
| Events, alarms and conditions | 1 notifier | **O** `events` on the EventNotifier Object; **N** `events` | `Machines` (`nsu=http://opcfoundation.org/UA/Machinery/;i=1001`) | `events.notifier` |
| Access rights reduced to writable / not writable | 455 + 63 | **M** `writable` / `writableProperties`; **N** `accessRights` | `FL-401/Identification` (AssetId, ComponentName, Location) | `access.*` |
| Historizing flag | 219 | **M** `metadata.opcua.historizing` | `FL-401/BaseStateMachine/MachineState/CurrentState` | `history.historizing` |

### Types

| Loss | Count | Where it's described | Example | Audit rule |
|---|---|---|---|---|
| Type-only members (state machine States/Transitions) | 12 types | **T** `typeOnly` | `Machinery:MachineIdentificationType` | `type.typeOnly` |
| Placeholder cardinality isn't in the schema | 11 types | **T** `placeholders` | `ISA95:EquipmentType` | `type.placeholders` |
| Interface members merged into the schema | 6 types | **T** `interfaces` | `Machinery:MachineIdentificationType` | `type.interfaces` |
| One leaf type per concrete DataType (abstract VariableType DataType) | 29 types | **T** `dataType` (`synthesized`) | `ISA95:EquipmentPropertyType[Double]` | `type.synthesizedLeaf` |
| Nullable-by-default properties (OPC UA has no non-null rule) | 28 types | **T** `nullability` | `ISA95:EquipmentType` | `type.nullability` |

### Values

| Loss | Count | Where it's described | Example | Audit rule |
|---|---|---|---|---|
| ValueRank Any / ScalarOrOneDimension projected as scalar | 74 | **O** `valueRank` (per instance, since instances of one type differ) | `DT-301/SignalSet/Density/AnalogSignal` | `value.valueRank` |
| Int64/UInt64 as decimal strings (switch `int64`) | 6 | **T** `int64` on the leaf type; **N** `int64` | `SD-201/Component/Drive/FaultCount` → `"0"` | `value.int64` |
| LocalizedText → text (locale dropped) | 35 | **N** `localizedText`; the schema description says "text only" | `FL-401/BaseStateMachine/MachineState/CurrentState` → `"Running"` | `value.localizedText` |
| NaN/±Inf → `null` | 87 | **N** `nonFinite` | `BL-301/RatedFlow` | `value.nonFinite` |
| One timestamp: Source, else Server; picoseconds dropped | 455 | **N** `timestamps` | any leaf | `value.timestamps` |
| StatusCode → quality string (switch `quality`); branch quality aggregated | 455 | **N** `quality` | `PT-902/SignalSet/Pressure/AnalogSignal` under `SIM_FAULTS` | `value.quality` |

## Found and fixed in this pass

The first audit run found **1,705 gaps in 10 rules**. All are now described:

- **Not described before:**
  - timestamps, quality and NaN handling (namespace notes added);
  - Int64 encoding (a type note and a namespace note);
  - historian configuration and the plumbing references (a namespace `references` note saying where each one goes);
  - excluded ns0 infrastructure (a UA namespace note naming the nodes; the crawler now records what it skipped).
- **Fact not exposed:**
  - `Historizing` is now read and given as `metadata.opcua.historizing`;
  - `metadata.opcua.dictionaryEntries`, which MAPPING.md promised, is now emitted (no Line 1 instance has one).
- **Wrong level:**
  - the ValueRank note was on the type only, and the first instance decided it, so 3 Any-ranked `SensorType` leaves had no note; it's now per Object;
  - EventNotifier was noted only on the namespace; it's now on the Object as well.
- **New rule, complex Variables:** 9 leaves have both a value and component children; each now has a note on the Object.
- **Wording:** the `accessRights` namespace note said AccessLevel wasn't projected, but writability is (`writable`); it's corrected.

Two first-run "gaps" were the audit's own mistakes, fixed in the audit:
- symmetric `ConnectsTo` was counted as a second parent;
- the nullability rule was applied to leaf types.

## What the audit can't see

These are i3X API-shape choices, not OPC UA facts. MAPPING.md documents them with their switches:

- `components` flattened beyond one level (discrepancy #19);
- `metadata.relationships` always as arrays (#10);
- `InheritsFrom`/`InheritedBy` names (#15);
- composition children also getting `HasParent` (#18).

They lose no OPC UA information (the tree is recoverable from `parentId`/`ComponentOf`), so they get no fidelity notes.

The audit also only checks that a note **exists** at an allowed level. Whether its wording is right is checked by reading it (see the walkthrough).
