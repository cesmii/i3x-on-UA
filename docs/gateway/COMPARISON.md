# OPC UA → i3X: two interpretations side by side

*Draft 2026-11-05 for the WG. Gateways compared:*
- ***cesmii** (ours): `gateway/` 0.5.0. Rules in `MAPPING.md`.*
- ***i3x2ua**: Andreas Heine's [i3x2ua](https://github.com/AndreasHeine/i3x2ua) 1.16.2. Rules in its [OPCUA_I3X_MAPPING_PROFILE.md](https://github.com/AndreasHeine/i3x2ua/blob/master/docs/OPCUA_I3X_MAPPING_PROFILE.md).*

*Both read the same OPC UA server (the Line 1 beverage plant) with their own documented defaults (`compare/README.md`). Every row was observed live, not inferred from the docs alone. The table describes; it doesn't judge. Each row ends with the question it raises for the WG.*

## How to look

Start everything with `npm run compare`. Both gateways sit behind the front door:

```
cesmii:  http://localhost:8080/cesmii/v1/…
i3x2ua:  http://localhost:8080/i3x2ua/v1/…
```

Open both in i3X Explorer, or query them directly, e.g.

```
curl -s -X POST localhost:8080/cesmii/v1/objects/value -H 'Content-Type: application/json' \
  -d '{"elementIds":["nsu=https://cesmii.net/i3x-demo/BeverageFactory/;s=FL-401"],"maxDepth":0}'
curl -s -X POST localhost:8080/i3x2ua/v1/objects/value -H 'Content-Type: application/json' \
  -d '{"elementIds":["asset-02f12ced378a0243"],"maxDepth":0}'
```

**Finding the same node in both.**
- cesmii: the elementId *is* the OPC UA ExpandedNodeId, `nsu=https://cesmii.net/i3x-demo/BeverageFactory/;s=<path>`. The table writes just `<path>`.
- i3x2ua: the elementId is `<kind>-SHA1(<that same string>)[:16]`, where kind is `asset` (Object), `property` (Variable), `action` (Method) or `eventSource` (EventNotifier set). For example, FL-401 is `asset-02f12ced378a0243`.

## Comparison

### A. Identity and namespaces

| # | Topic | cesmii (ours) | i3x2ua | Look at | WG question |
|---|---|---|---|---|---|
| A1 | Object elementId | ExpandedNodeId string, readable and reversible: `nsu=…;s=FL-401` | `<kind>-SHA1(ExpandedNodeId)[:16]`: opaque, fixed length, encodes the node kind | `FL-401` · i3x2ua `asset-02f12ced378a0243` | Should an elementId let a client get back to the OPC UA NodeId, or is it deliberately opaque? |
| A2 | ObjectType elementId | `<ns>:<BrowseName>`, e.g. `PackML:PackMLBaseObjectType` | `urn:<server>:objecttype:<ns>:v-<version>:<name>:<id>`, e.g. `urn:cesmii-i3x-demo-beverage-factory:objecttype:http-opcfoundation-org-ua-packml:v-1-01:packmlbaseobjecttype:i-6` | `GET /objecttypes` | Should the namespace *version* and the *server* be part of a type's identity? Server-scoped type ids mean the same PackML type has different ids on different servers. |
| A3 | Namespaces | Only namespaces that own a projected type or relationship type, URI + `?projection=i3X`; plus `https://cesmii.org/i3x` and a gateway namespace (11) | Every server namespace with its raw URI, including the instance namespace (BeverageFactory), IRDI, IA and a server URN (13) | `GET /namespaces` | IG: instances belong to no namespace, and an inexact projection SHOULD carry `?projection=i3X`. Should a projection gateway use the suffix? |
| A4 | Roots | The 7 children of OPC UA `Objects` (DeviceSet, NetworkSet, DeviceTopology, Machines, PackMLObjects, Demo Beverage Co., EquipmentClasses) | One root: `Objects` itself | `GET /objects?root=true` | Is OPC UA's `Objects` folder part of the information model, or the server's entry point? |

### B. What becomes an i3X Object

| # | Topic | cesmii (ours) | i3x2ua | Look at | WG question |
|---|---|---|---|---|---|
| B1 | Size | 855 Objects (400 Objects + 455 data Variables) | 5,621 Objects | `GET /objects` | Follows from B2–B4. |
| B2 | Properties (`HasProperty`) | **Attributes of the owner's value**: Identification's value is `{Manufacturer, SerialNumber, …}` | **Separate objects** (`property-…`), each a composition child with its own VQT; the owner's value is `null`/`GoodNoData` | `FL-401/Identification` · i3x2ua `asset-10e3ae624c1f5828`; `…/Identification/SerialNumber` (only wg: `property-8151adf55290c4cf`) | Is a nameplate one object with attributes, or a folder of single values? This decides whether reading a nameplate takes one value or 15. |
| B3 | Methods | Not projected; listed in `metadata.opcua.methods`, fidelity `dropped` | Objects of kind `action-…` (type `UnknownType`), shown as children | `FL-401/SetMachSpeed` · i3x2ua `action-3e5f954286fa127f` | i3X 1.0 has no method call. Should methods be visible as objects anyway? |
| B4 | Event notifiers | Ordinary Objects | Kind `eventSource-…` (the `Machines` folder is an EventNotifier) | Machinery `Machines` · i3x2ua `eventSource-50f258eb735fd22f` | Should EventNotifier-ness show in identity? |
| B5 | ISA-95 `EquipmentLevel` (a PropertyType Variable under a HasComponent subtype) | Attribute: T-101's value is `{EquipmentLevel: 9}` | Separate property object, typed by the enum DataType | `T-101/EquipmentLevel` · i3x2ua `property-bc1bf9cec8f554be` | See UA_MODEL_NOTES observation 1. |

### C. References, hierarchy and composition

| # | Topic | cesmii (ours) | i3x2ua | Look at | WG question |
|---|---|---|---|---|---|
| C1 | `HasComponent` (and `HasAddIn`) to an **Object** | **Composition** (`HasComponent`/`ComponentOf`): FL-401 has 8 composition children | **Hierarchy** (`HasChildren`/`HasParent`); only Variable targets are composition. FL-401 has 12 children (incl. 4 methods) and 2 components (its 2 Properties) | `FL-401` · i3x2ua `asset-02f12ced378a0243` | Is an OPC UA component Object part of its parent's value (i3X composition), or an organizational child? |
| C2 | `maxDepth=0` on a machine | 40 components: speeds, counts, StopReason, PackML and Machinery states, nameplate | 2 components (PackMLVersion, TagID) | `POST /objects/value` on `FL-401`, `maxDepth: 0` | Follows from C1. What should "read the whole machine" return? |
| C3 | Parent for multi-path nodes | Rank: composition > hierarchy; non-folder > folder; then depth. State machine → `MachineryBuildingBlocks` | `Organizes > HasComponent > HasOrderedComponent`. State machine → `Monitoring/Status` (Organizes wins) | `FL-401/MachineryItemState` · i3x2ua `asset-87a6cb9abd242686` | Which path is "the" parent: the owning AddIn reference, or the organizing view? Machinery §16 says Status *references* the state machine. |
| C4 | Machine under its line and under `Machines` | Parent = Bottling Line 1; `Machines` → `UA:OrganizedBy` graph edge | Parent = Bottling Line 1; `Machines` → `OrganizedBy` (a synthetic secondary-parent relationship) | `FL-401` | Same result; different vocabulary (C6). |
| C5 | Pipes: DI `ConnectsTo` between Pumps ports (symmetric, but formally *hierarchical*) | Graph edge `DI:ConnectsTo`, **plus synthesized `FlowsTo`/`FedBy`** between equipment (port Direction Out → In) | Treated as hierarchy, so it becomes **secondary-parent** links (`inverseOf_OrganizedBy` ×2). No flow direction, no equipment-level flow | `P-102/Ports/WaterOut` · i3x2ua `asset-9d8071e5a8862085`; `BL-301` (ours: FedBy P-203 and DA-301) · i3x2ua `asset-c2fa37db3fda885b` | Should a symmetric hierarchical reference be containment? Is synthesizing domain relationships (FlowsTo) in scope for a gateway? |
| C6 | Relationship type names and inverses | Graph types are named `<ns>:<BrowseName>`, and the inverse is the OPC UA **InverseName** (`UA:Organizes` / `UA:OrganizedBy`, `UA:HasAddIn` / `UA:AddInOf`, `ISA95:…EquipmentClassOf`); 15 types | BrowseName, and the inverse is `inverseOf_<Name>` (`DefinedByEquipmentClass` / `inverseOf_DefinedByEquipmentClass`; `OrganizedBy` / `inverseOf_OrganizedBy`); 8 types | `GET /relationshiptypes` | OPC UA already defines inverse names; should i3X use them? |
| C7 | Type inheritance as a relationship | `related: {relationshipType: "InheritsFrom", types: [super]}` + registered `InheritsFrom`/`InheritedBy` (discrepancy #15) | `related: {instances: [...]}` (the type's instances); inheritance only inside the schema (`allOf`) | `PackML:PackMLBaseObjectType` in both `/objecttypes` | IG example uses `related` for InheritsFrom. Is `related` for type-to-type or type-to-instance? |

### D. Types and schemas

| # | Topic | cesmii (ours) | i3x2ua | Look at | WG question |
|---|---|---|---|---|---|
| D1 | ObjectType schema contents | Only the Object's **own value** (its Properties); component structure goes in `metadata.opcua.components` | **Every member** (Admin, Status, BaseStateMachine, Properties …) as a schema property | `PackMLBaseObjectType` | Should a type's schema describe its value (what `/objects/value` returns) or its whole structure? (In i3x2ua, the value is `null` while the schema has 5 properties.) |
| D2 | Inheritance in schema | Resolved: supertype properties merged; switch `schemaInheritance: allOf` | `$defs` + `allOf` with `$ref` to the supertypes | `PackMLBaseObjectType` | IG: servers SHOULD serve the resolved form. |
| D3 | Type of a data Variable (leaf) | Its **VariableType**, split by concrete DataType: `PADIM:LevelMeasurementVariableType[Double]`, schema `{type: "number"}` (27 scalar leaf types) | Its **DataType**: `…:double:i-11`, schema `oneOf [null, number, array]` (0 types with a scalar `type`) | `LT-101/SignalSet/Level/AnalogSignal` · i3x2ua `property-d29c286cfc613d1a` | IG: clients SHOULD use `schema.type` to spot leaves. Is the VariableType (semantics) or the DataType (shape) the i3X type? |
| D4 | Type count | 97 (types actually used, plus supertypes) | 576 (all discovered ObjectTypes + DataTypes) | `GET /objecttypes` | Publish what's used, or everything the server knows? |
| D5 | `version` | From the server's NamespaceMetadata (`1.01` for PackML) | `null` on the type (but the version is inside the elementId) | `PackMLBaseObjectType` | — |

### E. Values

| # | Topic | cesmii (ours) | i3x2ua | Look at | WG question |
|---|---|---|---|---|---|
| E1 | Object (branch) value | Its Properties as an object, quality from the worst property | `null` / `GoodNoData` (data lives in property objects) | `FL-401/Identification`, `T-101` | Follows from B2. |
| E2 | LocalizedText | Text only: `"Execute"` (locale lost, fidelity note) | `{"Locale": null, "Text": "Execute"}` | `…/ExecuteState/CurrentState` · i3x2ua `property-ec99eac07d460152` | Is LocalizedText a string in i3X? |
| E3 | NodeId value | `"i=0"` (nsu string) | `{"Identifier": 0, "NamespaceIndex": 0, "NodeIdType": 0}`, which exposes the server-local namespace *index* | `FL-401/Status/UnitSupportedModes` (ours: attribute of `FL-401/Status`) · i3x2ua `property-08456511919ba66b` | Index-based NodeIds aren't portable across sessions. |
| E4 | Int64 | Decimal **string** `"0"` (switch `int64: number`) | JSON number `0` | `SD-201/Component/Drive/FaultCount` · i3x2ua `property-e04bf7daa0226f22` | JSON loses precision above 2⁵³. |
| E5 | Structures | DataTypeDefinition field names; nested LocalizedText → text; unset DateTime → `null` | Same field names; nested LocalizedText → object; unset DateTime → `"1601-01-01T00:00:00Z"` | `FL-401/Admin/StopReason` · i3x2ua `property-3ecedfb5772637e8`; `…/ProdProcessedCount` | Is the OPC UA minimum DateTime a value or "no value"? |
| E6 | Enumerations | Integer (+ `oneOf` const/title in the schema; switch `enums: name`) | Integer | `FL-401/Status/UnitModeCurrent` | Same. |
| E7 | `isComposition` on a leaf with Properties (EngineeringUnits, EURange) | `false`: Properties go to `metadata.opcua.properties` | `true`: EngineeringUnits/EURange are component objects | `LT-101/SignalSet/Level/AnalogSignal` | Where do engineering units live (discrepancy #12)? |

### F. Quality (injected with `SIM_FAULTS="PT-902=BadNotConnected,DT-301=UncertainLastUsableValue"`)

| # | Topic | cesmii (ours) | i3x2ua | Look at | WG question |
|---|---|---|---|---|---|
| F1 | Bad | `null`, **`Bad_NotConnected`** (OPC UA status name; switch `quality: base`) | `null`, **`Bad`** | `PT-902/SignalSet/Pressure/AnalogSignal` · i3x2ua `property-c9acc8267c092b7c` | Open string or closed set (discrepancy #26)? The conformance suite accepts only the closed set. |
| F2 | Uncertain | value + `Uncertain_LastUsableValue` | value + `Uncertain` | `DT-301/SignalSet/Density/AnalogSignal` · i3x2ua `property-64a4d1a7c139fa52` | Same as F1. |
| F3 | History info bits | First (interpolated bound) value: `Good_HistorianInterpolated` | `Good` | `POST /objects/history` on `LT-301/…/AnalogSignal` | Should historian info bits reach the client? |

### G. Writes, history, subscriptions

| # | Topic | cesmii (ours) | i3x2ua | Look at | WG question |
|---|---|---|---|---|---|
| G1 | Writes enabled by default | Yes (`update.current: true`) | No (`I3X_ENABLE_WRITES=0`); writes return 501 | `GET /info` | — |
| G2 | Writing back an unchanged value to a read-only target | **No-op, success**: unchanged attributes aren't written | Schema-validated, then forwarded to OPC UA → `403 target_not_writable` (conformance UPD-01/03 fail when writes are on) | conformance UPD-01 with `I3X_ENABLE_WRITES=1` | Is "write the current value back" a no-op or a write? |
| G3 | Partial write failure | All or nothing: refuse before writing if any changed attribute isn't writable | Per property object (each property is its own write target) | `FL-401/Identification` (ours) | Follows from B2. |
| G4 | Historical writes | 501 | Supported (`PUT /objects/history` → OPC UA HistoryUpdate) when writes are on and the server supports it | `GET /info` | — |
| G5 | History of a branch (no historized value) | One `GoodNoData` VQT for the range | **Per-item 404** "Object history not found" | `POST /objects/history` on `T-101` · i3x2ua `asset-88334e03f0cd2571` | IG: a server without history for the range SHOULD return `GoodNoData`. Is "this object has no history" a 404 or GoodNoData? |
| G6 | Subscription source | OPC UA MonitoredItems (250 ms sampling) | Native MonitoredItems or shared polling (1 s configured here) | SSE on `LT-301/…/AnalogSignal`: both 7 events / 6 s | Same rate for a 1 Hz plant. |

### H. Self-description

| # | Topic | cesmii (ours) | i3x2ua | Look at | WG question |
|---|---|---|---|---|---|
| H1 | Provenance | `metadata.opcua`: nodeId, browseName, nodeClass, typeDefinition, parentReference, otherParents, properties, writable, … (also `metadata.system`) | `typeNamespaceUri`, `sourceTypeId`, `description`, `compositionParentId`, `relationships`; internal fields (`semantic_role`, `mapping_confidence`, `uaNodeId`) are **not** published | any object with `includeMetadata=true` | How much OPC UA provenance should be public? |
| H2 | Fidelity loss | Explicit `fidelity: [{aspect, loss, detail}]` on Objects, ObjectTypes, RelationshipTypes and Namespaces | No loss annotations (mapping confidence is internal) | `FL-401` (multiPath, methods dropped) | Should a projection say what it lost? (the D4 proposal) |
| H3 | Missing description | Omitted | `"Derived from model node <name>"` | `FL-401` | — |
| H4 | `isExtended` | Computed: true when an instance has Properties its type doesn't declare (4 objects, e.g. the Acme Mixers' DI nameplate properties) | Always `false` | `SD-201/Equipment/Mixer` | — |
| H5 | Bulk item shape | `{success, elementId, result \| responseDetail}` (IG) | Same, plus `error: {code, message}` and `subscriptionId: null` on every item | any failing bulk item | Extra fields are harmless, but are they part of the contract? |

## Agreement (no difference observed)

- **Conformance:** both "1.0 Compatible", 0 failures, with their own defaults.
- **Same results for:** value recursion follows composition only; HasProperty/HasComponent classification walks supertype chains; Bottling Line 1 is FL-401's parent; ISA-95 `DefinedByEquipmentClass` is a graph relationship; enumerations are integers; history returns about 300 values per 5 min per signal (leaf signals); Bad → `null`; SSE delivery rate.

## Found by the comparison (fixed in our stack, 2026-11-05)

- **cesmii gateway:** an `Uncertain` status returned `null`/`GoodNoData`, because node-opcua's `isGoodish()` excludes Uncertain. Only Bad severity now drops the value. i3x2ua was right.
- **our simulator:** `SIM_FAULTS` nulled the value for Uncertain codes too. Uncertain now keeps the last usable value.
