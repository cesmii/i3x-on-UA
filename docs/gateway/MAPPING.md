# OPC UA → i3X: Our Interpretation (gateway "cesmii")

*Draft 2026-11-05. This is the CESMII-side interpretation, written **independently** of any other WG member's gateway (decision D9). Each rule cites the normative i3X source it rests on: IG = Implementation Guide 1.0, OAS = openapi.json, UR = Understanding Relationships. Where i3X is silent, the choice is ours and marked* **[ours]**. *Where a switch exists in `gateway.config.yaml`, it's marked* **[switch]**.

## 0. Principles

1. **Generic.** The gateway knows OPC UA, not the beverage plant. It uses only OPC UA services (Browse, Read, HistoryRead, Subscriptions), so it should project any server. Plant-specific knowledge is a bug.
2. **Pre-browse and cache.** i3X expects the whole address space to be queryable (Explorer calls `GET /objects` on connect). The gateway crawls `Objects` (i=85) at start-up and serves from the cache. The OPC UA model is static in this demo, so re-crawling is a later concern.
3. **Self-describing loss.** Every entity (Namespace, ObjectType, RelationshipType, Object) carries `metadata.opcua`: where it came from, plus a `fidelity` list of `{aspect, loss, detail}`. `loss` is an open vocabulary: `dropped`, `flattened`, `approximated`, `renamed`, `synthesized`, `multiPath`, `typeChanged`. Metadata on non-Object entities follows the WG decision of 2026-11-05.

## 1. What becomes an i3X Object

| OPC UA | i3X | Rule |
|---|---|---|
| Object (NodeClass Object), reachable from `Objects` by hierarchical references | **Object** | ns0 infrastructure under `Objects` (`Server`, `Aliases`, `Locations`, `Dictionaries`, …) is excluded **[switch: `includeCoreInfrastructure`]** |
| DataVariable (a Variable reached by a non-Property hierarchical reference) | **Object with a scalar (leaf) schema** | It's individually readable and subscribable, as IG "Scalar types" intends |
| Property: a `HasProperty` target, **or a Variable of TypeDefinition `PropertyType` under a HasComponent subtype** (ISA-95 `HasISA95Attribute → EquipmentLevel`) **[ours]** | **Attribute in the owning Object's value**, not an Object | Annex A of OPC 10000-5: Properties are characteristics of their owner. Properties *of a DataVariable* (EngineeringUnits, EURange, …) go into that leaf Object's `metadata.opcua.properties`, because a leaf value must stay a bare scalar (IG) |
| Method | not projected | Listed in the parent's `metadata.opcua.methods`; fidelity `dropped` (i3X 1.0 has no method call) |
| Interfaces applied with `HasInterface` | their members are already instance members | The Interface is recorded in `metadata.opcua.interfaces` |

## 2. Identity

- **Object elementId** = the OPC UA **ExpandedNodeId string with namespace URI**, e.g. `nsu=https://cesmii.net/i3x-demo/BeverageFactory/;s=FL-401`. It's unique, persistent, independent of namespace index (IG: SHOULD be persistent), and maps straight back to OPC UA. It's readable where the server's NodeIds are readable.
- **ObjectType / RelationshipType elementId** = `<NamespaceShortName>:<BrowseName>`, e.g. `PackML:PackMLBaseObjectType`. The short name is the last path segment of the namespace URI (`UA` for ns0); if two namespaces collide, the full URI is used. This is readable (IG: SHOULD be human-readable) and unique, because type BrowseNames are unique within a namespace in practice; uniqueness is checked at load. **[switch: `typeIds: short|nsu`]**
- **`sourceTypeId` / `metadata.sourceTypeId`** = the type's `nsu=` NodeId (the exact OPC UA identity).
- **`displayName`** = OPC UA DisplayName text. The locale goes into `metadata.opcua` if it isn't empty.

## 3. Namespaces

- **One i3X Namespace per OPC UA namespace that contributes at least one projected type**, URI = `<OPC UA namespace URI>?projection=i3X` (IG: SHOULD suffix an inexact projection; every projection here is inexact). `displayName` = the short name.
- **Gateway-defined namespaces:**
  - `https://cesmii.org/i3x` holds the i3X core relationship types (HasParent, HasChildren, HasComponent, ComponentOf), as in the IG examples.
  - `https://cesmii.net/i3x-demo/opcua-gateway/` holds the gateway's own additions: `InheritsFrom`/`InheritedBy`, `FlowsTo`/`FedBy`, `UnknownType`.
- **Instances belong to no namespace** (IG). `metadata.typeNamespaceUri` = the *projected* namespace URI of the instance's type, so it matches a registered Namespace. The raw OPC UA URI goes in `metadata.opcua.namespaceUri`.

## 4. References → relationships

**Classify each reference by walking the ReferenceType's supertype chain, never by name:**

| ReferenceType is a subtype of… | i3X meaning |
|---|---|
| `HasProperty` | not an edge: the target is an attribute (§1) |
| `HasComponent` (incl. `HasAddIn`, `HasOrderedComponent`, PackML `HasStopReason`/`HasAlarm`…) | **composition**: `HasComponent` / `ComponentOf` |
| any other `HierarchicalReferences` that isn't Symmetric (`Organizes`, ISA-95 `MadeUpOfEquipment`, other `Aggregates` such as ISA-95 `HasISA95Attribute`…) | **hierarchy**: `HasChildren` / `HasParent` |
| Symmetric hierarchical (DI `ConnectsTo`) | **graph**: topology isn't containment (see UA_MODEL_NOTES observation 4) |
| `NonHierarchicalReferences` (except type-system plumbing) | **graph** |
| `HasTypeDefinition`, `HasModellingRule`, `HasSubtype`, `HasEncoding`, `HasInterface`, `HasDictionaryEntry`, `GeneratesEvent`, `HasEventSource`/`HasNotifier`, `HasHistoricalConfiguration` (historian config, never crawled) | not edges. They become `typeElementId`, schema, `metadata.opcua` fields, or are dropped |

- **One parent per Object [ours].** An OPC UA node can be reached by several hierarchical paths (Machinery §7.3; machines under both their line and `Machines`). Candidate parents are ranked:
  1. a **composition** parent beats a hierarchy parent;
  2. a **non-Folder** parent beats a `FolderType` parent, since folders are pure organization (so `Bottling Line 1` beats `Machines`, and the machine beats `MachineryBuildingBlocks`);
  3. shallower depth from a root;
  4. the lowest NodeId string, so the result is deterministic.

  The winner gives `parentId`. **Every other path is kept as a graph edge** named after its OPC UA ReferenceType (e.g. `UA:Organizes`/`UA:OrganizedBy`, `UA:HasAddIn`/`UA:AddInOf`), with fidelity `multiPath` on the Object.
- **Composition children also get `HasParent` [ours].** IG: `parentId` MUST match `HasParent`, and UR shows composition children with a `parentId`. So a composition child emits `ComponentOf` **and** `HasParent` to the same parent (discrepancy #18: both edges may coexist). Explorer de-duplicates them.
- **Graph RelationshipTypes come from OPC UA ReferenceTypes:** elementId `<ns>:<BrowseName>`, `reverseOf` `<ns>:<InverseName>`. A symmetric type is its own reverse. Both directions are registered (IG: every type MUST have a registered reverse).
- **Synthesized material flow [ours]:** two equipment Objects whose Ports are joined by `ConnectsTo` (Out → In, by the Pumps `PortType/Direction` value) get `FlowsTo`/`FedBy` edges between the *owning* Objects, flagged `synthesized`. This is the only use of companion-spec semantics in the core, and it can be switched off. **[switch: `synthesizeFlow`]**
- **`metadata.relationships`** = all edges, keyed by RelationshipType elementId, **values always arrays** (discrepancy #10). **[switch: `relationshipsShape: arrays|mixed`]**
- **Roots:** the projected children of `Objects` have `parentId: null` and no `HasParent` (discrepancy #7).
- **Single root [switch: `singleRoot`, `singleRootType`] [ours]** *(2026-11-16; off by default, on in `compare/gateways.yaml` for the demo)*: one named Object (an `nsu=` NodeId) becomes the only i3X root, and every other top-level Object becomes its child (`HasChildren`/`HasParent`, fidelity `parent`/`synthesized`; no OPC UA reference connects them). The root keeps its elementId, value and `metadata.sourceTypeId`, but is presented as `gateway:<singleRootType>` (default `Enterprise`, in the gateway namespace, reusing its OPC UA type's schema and notes; fidelity `typeDefinition`/`typeChanged`). For the plant: `Demo Beverage Co.` (an ISA-95 Enterprise-level `EquipmentType` in OPC UA) contains Plant 1, Personnel, Materials, Orders, EquipmentClasses, Machines and the standard folders. The WG is debating single vs multiple roots: the IG allows both, i3x2ua shows a single `Objects` root, and uns has four roots.

## 5. Types → JSON Schema (draft 2020-12)

- **ObjectType** (incl. Interfaces used as TypeDefinitions, which are flagged) → `{type: "object", properties: {<Property>: <schema>}, required: [Mandatory properties]}`.
  - The schema describes the Object's **own value**, which is its Properties. Composed children aren't in `properties`: they're separate Objects returned under `components` (IG maxDepth). Their declarations are listed in `metadata.opcua.components` (`browseName`, `typeElementId`, modelling rule, placeholder?) so the OPC UA structure stays visible.
  - **Inheritance:** the schema is served **fully resolved** (supertype properties merged; IG: the server resolves `$ref`), and `related: {relationshipType: "InheritsFrom", types: [<supertype>]}`. **[switch: `schemaInheritance: resolved|allOf`]**
  - **Interface members** (`HasInterface` on the type) are merged and listed in `metadata.opcua.interfaces`.
- **VariableType of a DataVariable** → a **leaf** ObjectType with a scalar schema from the DataType. A leaf with ValueRank −2 (Any) or −3 (ScalarOrOneDimension) is projected as **scalar**, so clients see a data point, with fidelity `approximated` **[ours]**. When the VariableType's DataType is abstract (Number, BaseDataType), one i3X type is synthesized **per concrete DataType** seen on instances, e.g. `UA:BaseDataVariableType[Boolean]`, flagged `synthesized`, with the VariableType as `sourceTypeId`.
- **Nullability:** OPC UA has no non-null constraint, and any Value can be null with a Bad status. So every field is declared `[T, "null"]` (IG: nullability MUST be declared, never inferred). `required` = Mandatory.
- **ModellingRules:** Mandatory → `required`; Optional → not required; `*Placeholder` → `metadata.opcua.components[].placeholder`, and in i3X a variable set of child Objects. ExposesItsArray isn't used here.
- **Type-only members** (state machine States/Transitions, which have no ModellingRule) → `metadata.opcua.typeOnly`, fidelity `dropped`.
- **`UnknownType`** = `{type: "object"}`, for nodes whose TypeDefinition can't be read.

**DataTypes → JSON Schema:**

| OPC UA | JSON Schema | Value encoding |
|---|---|---|
| Boolean | `boolean` | as-is |
| SByte…UInt32 | `integer` + min/max | as-is |
| Int64, UInt64 | `string` (pattern `^-?\d+$`) | decimal string, which avoids JSON precision loss **[switch: `int64: string|number`]** |
| Float, Double, Decimal, Duration, Number | `number` | NaN/±Inf → `null` (fidelity note) |
| String and subtypes, LocaleId | `string` | as-is |
| DateTime, UtcTime | `string`, `format: date-time` | RFC 3339 UTC `Z` |
| Guid | `string`, `format: uuid` | |
| ByteString | `string`, `contentEncoding: base64` | |
| NodeId, ExpandedNodeId | `string` | `nsu=` form |
| QualifiedName | `string` | `<nsShort>:<Name>` |
| LocalizedText | `string` | `text` only; the locale is lost (fidelity) |
| Enumeration | `integer` + `oneOf [{const, title}]` | number **[switch: `enums: number|name`]** |
| Structure (DataTypeDefinition) | `object` with one property per field | e.g. `EUInformation`, `Range`, `PackMLCountDataType` |
| ValueRank ≥ 1 | `array` (nested for n dimensions) | |
| BaseDataType / unknown | `{}` | |

## 6. Object record

- **`typeElementId`:** the projected TypeDefinition; `UnknownType` if it can't be read.
- **`isComposition`:** true ⇔ the Object has ≥ 1 composition child.
- **`isExtended`:** true ⇔ the Object has a Property its type doesn't declare (instances may add Properties). `metadata.schemaExtensions` gives the inferred fragments, and `metadata.system` is always present (IG requires it when extended).
- **`metadata`:**
  - `description`: the OPC UA Description.
  - `typeNamespaceUri`, `sourceTypeId`, `relationships`.
  - `system`: `{nodeId, nodeClass, browseName}`, an opaque mirror. Clients mustn't rely on it (IG).
  - `opcua`: `{nodeId, browseName, nodeClass, typeDefinition, parentReference, otherParents[], properties (leaf only), writable + historizing (leaf), writableProperties (branch), methods[], interfaces[], dictionaryEntries[], fidelity[]}`.
  - Every loss is catalogued, with where it's described, in `FIDELITY.md`. `npm run audit -w gateway` checks this against the live OPC UA server.

## 7. Values, history, writes, subscriptions (Phase 5)

- **Current value** (`POST /objects/value`):
  - a branch Object's value is its Properties as a JSON object (`{}` when it has none);
  - a leaf Object's value is the Variable's Value, encoded per §5. Structures use the DataTypeDefinition field names (e.g. `PackMLCountDataType` → `{ID, Name, Unit, Count, AccCount}`);
  - the timestamp is the SourceTimestamp, else the ServerTimestamp (UTC `Z`). A branch uses its newest property timestamp.
- **`quality`** is the StatusCode symbolic name with the base category split off: `Good`, `GoodNoData`, `Bad_NotConnected`, `Bad_StateNotActive`, `Uncertain_LastUsableValue`. node-opcua's info bits appear as e.g. `Good_HistorianInterpolated`. **[switch: `quality: detailed|base`]**
  - IG null rules: a Bad status gives `value: null`, and a null with Good or Uncertain becomes `GoodNoData`.
  - A branch whose properties aren't all Good is `Uncertain`, with the affected fields `null` (they're declared nullable).
  - ⚠️ The i3X conformance suite validates quality against the closed set {Good, GoodNoData, Bad, Uncertain}. The `detailed` default follows our reading that `quality` is an open string (IG field table: `string`; CLAUDE.md discrepancy #14). Only Line 1's healthy states happen to keep the suite green; injected faults (`Bad_NotConnected`) would fail QRY-02/03 unless `quality: base`.
- **`maxDepth`** follows composition only (IG): 1 = none, 0 = unbounded, N = N levels. **Discrepancy #19:** OpenAPI's VQT has no `components`, so deeper levels are **flattened**: every descendant up to `maxDepth` sits in the top-level `components` map, keyed by elementId. The tree is recoverable from `parentId`/`ComponentOf`. **[switch: `componentsShape: flat|nested`]** A server limit of 5,000 elements per request gives 206 with `responseDetail`.
- **History** (`POST /objects/history`):
  - a leaf reads OPC UA HistoryRead (raw) between `startTime` and `endTime`, in chronological order, without node-opcua's `BadBoundNotFound` markers;
  - a branch, or a leaf without history, returns one VQT `{value: null, quality: "GoodNoData", timestamp: startTime}`, the IG's "no history" answer;
  - components mirror `/objects/value`: `{<elementId>: {isComposition, values}}`, flattened (discrepancy #20);
  - `capabilities.query.history = true`.
- **Writes** (`PUT /objects/value`, `capabilities.update.current = true`):
  - The write is **full-value** (IG): a branch write must contain every property.
  - Attributes whose value is unchanged aren't written, so writing back the current value always succeeds.
  - A changed attribute that isn't writable (OPC UA `UserAccessLevel`) rejects the **whole** update with 403 before anything is written: **all or nothing [ours]**.
  - LocalizedText is written as text (empty locale). Structures can't be written.
  - `metadata.opcua.writable` (leaf) and `writableProperties` (branch) say what can change.
  - `PUT /objects/history` → 501.
- **Subscriptions:**
  - One OPC UA Subscription is shared by the whole gateway; MonitoredItems (sampling 250 ms) are reference-counted across i3X subscriptions.
  - Registering with `maxDepth` N watches the Object **and its composition descendants to depth N**. Each element sends its own updates (flattened, consistent with `components`) **[ours]**. A branch update is emitted when any of its properties changes.
  - On registration, the current value is queued (from the MonitoredItem's initial notification, or from the cache if the node was already monitored).
  - **Sync:** updates collected since the last sync form the next batch (`sequenceNumber` + 1); batches stay until acknowledged; `-1` clears everything; a queue over 10,000 updates drops the oldest and returns 206; sync while a stream is open gives 400.
  - **Stream:** SSE, `data: [<updates>]`, at-most-once. Opening a stream flushes the queue, a new stream closes the old one, and a keep-alive comment is sent every 15 s.
  - A subscription with no sync and no open stream for 300 s is deleted. A missing `clientId` gives 400; a wrong `clientId` gives 404.

## 8. Not projected (fidelity notes at the Namespace level)

These are noted at Namespace level, and on the Object where it applies:
- Methods;
- Events/Alarms (incl. PackML alarms *as events*; their Variables are projected; an EventNotifier Object gets an `events` note);
- Views, and ns0 infrastructure (`Server`, `Aliases`, `Locations`; the UA namespace note names them);
- access levels beyond writable, and user permissions;
- historian configuration (`HasHistoricalConfiguration`; `historizing` is in metadata);
- DataType encodings;
- HasDictionaryEntry semantics (listed in `metadata.opcua.dictionaryEntries` only).

The value-encoding notes (timestamps, quality, NaN, Int64, LocalizedText) are in every projected namespace.
