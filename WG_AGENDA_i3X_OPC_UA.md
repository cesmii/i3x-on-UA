# i3X over OPC UA: Working Group Kickoff Agenda

- **Date:** 2026-11-03
- **Purpose:** Raise the main issues in running i3X *above* an OPC UA server, as a simple interface over it. We want to agree on the shape of a 12-month work stream; we don't need to solve anything today.
- **Reference case:** OPC UA for Machinery, Basic Building Blocks (OPC 40001-1 v1.04.2). Its examples are used throughout.
- **Format:** a short airing of each topic, a deep dive on item 4, add to the list if needed, then sequencing and planning.

## Starting Point

- What people have proposed so far. Demos or slide decks, please help us learn together!
- i3X Implementation Guide, branch `1.0` -- clarifications or fixes will be added to 1.0.1 or 1.1.0 *later*
- OPC 40001-1 (Machinery Basic Building Blocks) §6–§18
- OPC 10000-5 (Information Model) §11 ReferenceTypes, §12 DataTypes

## Ground rules for today

- Scope of mapping is 1.0 where ever possible. If we find blockers, they go to the primary work stream as new Issues.
- Main effort is to prioritize the mapping problems -- not to get to normative guidance on fixes... yet.
- Raise issues and record the questions; save the decisions for later.
- Note where an item depends on another one, to help with planning.
- Feature parity with OPC is *not* a goal of i3X!

---

## Top OPC Mapping Topics

### 1. What becomes an i3X object?

OPC UA has Objects, Variables and Properties connected by references; i3X has objects with JSON values. Each OPC UA Variable or Property either becomes an attribute in its parent's value, or its own leaf object. That choice decides what clients can subscribe to, how big a write is (i3X writes replace the whole value), and what `isComposition` means.

- *Example:* are Machinery's `Identification` properties one JSON object, or 15 leaf objects?
- **Question:** do we set one rule, or a mapping profile per type?

### 2. One parent in i3X, many paths in OPC UA

OPC UA deliberately reaches the same node by several routes; i3X allows a single `parentId`.

- *Example:* `Identification` is reached from both the machine and `MachineryBuildingBlocks`. A nested machine sits under both `Machines` and its parent's `Components`. Machinery §7.3 says not to duplicate the node.
- **Question:** how do we pick the canonical parent? Do the other paths become graph relationships, or are they dropped?

### 3. Mapping reference types to i3X relationships

OPC UA has a deep reference-type hierarchy plus types defined by companion specs. i3X has `HasChildren`, `HasComponent`, and graph relationships, each of which needs a registered reverse.

- *Example:* Organizes, HasComponent, HasProperty, HasAddIn, HasInterface, FromState/ToState.
- **Questions:** which OPC UA reference maps to which i3X relationship? Which are type-system plumbing to drop (HasTypeDefinition, HasModellingRule)? Do we match on the supertype chain or on names?

### 4. Translating types into JSON Schema (deep dive)

This is the largest body of work and something CESMII and WG members have been thinking about for a few years. Each topic below has a Machinery example and an open question. **Supporting analysis:** `NODESET_TO_JSON_SCHEMA_ANALYSIS.md` (a construct-by-construct fidelity matrix, the proposed `x-opcua` annotations, and a worked `MachineIdentificationType` example).

#### 4a. Inheritance

- *Example:* `MachineIdentificationType` ← `MachineryItemIdentificationType` (abstract) ← `2:FunctionalGroupType` (DI).
- Each step is `allOf` plus `InheritsFrom`
- Subtypes can *tighten* rules: `IMachineVendorNameplateType` makes `ProductInstanceUri` mandatory.
- **Question:** do servers serve the fully resolved schema, the `allOf` chain, or both? How deep does the chain go: all the way to `BaseObjectType`, or does it stop at the first non-ns0 type?

#### 4b. Interfaces and AddIns

- *Example:* `MachineIdentificationType` implements `IMachineVendorNameplateType` and `IMachineTagNameplateType` through `HasInterface`, and its properties are marked "Applied from …". The building blocks attach through `HasAddIn`, with a `DefaultInstanceBrowseName`.
- **Question:** are interfaces separate i3X types that get combined with `allOf`, a type-level relationship, or simply flattened? Is an AddIn a component (`HasComponent`), or something we need to name explicitly?

#### 4c. ModellingRules and optionality

- *Example:* `Manufacturer` is Mandatory (M) and `Model` is Optional (O). Machinery §7.2 says an optional read-only node with no data must be *left out*, not left empty.
- The i3X Guide makes fields non-nullable by default, and treats an absent field and a null field as the same.
- **Question:** is Mandatory always JSON Schema `required`? Is an omitted Optional node an absent field, or a nullable one?

#### 4d. Placeholders

- *Example:* `<Component>` in `MachineComponentsType` is OptionalPlaceholder, and `<LifetimeVariable>` in `MachineryLifetimeCounterType` is MandatoryPlaceholder (at least one).
- **Question:** do we use `additionalProperties`/`patternProperties` in the parent's value, a variable set of composition children, or both? How is "at least one" expressed?

#### 4e. Variables with properties (complex VariableTypes)

- *Example:* each `2:LifetimeVariableType` instance has a numeric value plus `EngineeringUnits`, `StartValue`, `LimitValue` and optional `WarningValues`.
- i3X separates leaf scalars from branch objects by `schema.type`.
- **Question:** is a variable with properties a scalar leaf with metadata, or an object whose value includes its properties? This ties back to item 1 and discussion item D3 (units).

#### 4f. Type-only structure

- *Example:* `MachineryItemState_StateMachineType` defines 4 States and 16 Transitions that have no ModellingRule, so they exist only on the type. The instance value is `CurrentState`.
- **Question:** how does an i3X type describe structure that instances never have? Do states become an `enum` in the value schema, and are transitions dropped?

#### 4g. DataTypes → JSON

| OPC UA | Machinery usage | Open point |
|---|---|---|
| LocalizedText | `Manufacturer`, `Model`, `ComponentName` | Plain string (text only), or `{locale, text}`? Machinery requires at least 2 locales for `ComponentName`. |
| QualifiedName | `DefaultInstanceBrowseName` | `"ns:Name"` string, `nsu`-qualified, or an object? |
| UInt64 / Int64 | counters | Precision above 2^53: number or string? |
| Duration | `PowerOnDuration` | A number in ms, with units how (D3)? |
| Abstract (Number, UInteger) | `<LifetimeVariable>`, `OperationCycleCounter` | A union, or `{"type": "number"}`? |
| Enumeration | `2:DeviceHealth` | Integer, name, or both? |
| Structure / OptionSet / Union | `EUInformation` | Generated from StructureDefinition? An OptionSet as a bitmask or as booleans? |
| ValueRank / ArrayDimensions | any | Arrays, nested arrays, and "scalar or array" |
| NodeId, ByteString, Guid, DateTime | various | string formats (`nsu=`, base64, uuid, date-time) |

- **Question:** is there an existing OPC UA → JSON Schema mapping we should adopt instead of inventing one? Candidates: the OPC UA JSON encoding (OPC 10000-6) and CESMII SM Profile tooling.

#### 4h. Instances that go beyond their type

- OPC UA instances may add components their type doesn't declare.
- i3X has `isExtended` and `schemaExtensions` for exactly this.
- **Question:** do we rely on `isExtended`, or synthesize an instance-specific type?

#### 4i. Proposed outputs for item 4

- A draft mapping profile ("OPC UA Information Model → i3X ObjectType").
- Fully worked JSON Schemas for `MachineIdentificationType`, `MachineryItemState_StateMachineType` and `MachineryLifetimeCounterType` as reference examples.
- A list of items to send back to the Implementation Guide.

---

### 5. Identity and namespaces

- ElementIds must be persistent, but OPC UA namespace indexes are local to each server. The URI-based `nsu=` form is stable but long.
- Namespace URIs need conventions, including `?projection=i3X`.
- Companion spec versions drift; for example, a 1.03 NodeSet sits alongside the 1.04.2 spec.
- One i3X server may aggregate several OPC UA servers.
- **Question:** what is the canonical ElementId and `sourceTypeId` format for OPC UA-backed servers?

### 6. Values, quality and time for composed objects

- StatusCode → `quality` is mostly solved by discussion item D2.
- Do we use the source timestamp or the server timestamp?
- When a value combines several nodes with different timestamps and qualities, what are the parent's quality and timestamp? What happens when one field is bad?
- **Question:** worst-of quality, latest timestamp, or something else?

### 7. Subscriptions, history and writes on OPC UA services

- **Subscriptions:** i3X has no sampling interval, deadband or queue size, and a `maxDepth` subscription fans out to many monitored items.
- **History:** this depends on OPC UA Historical Access, which many servers lack, and aggregates have no i3X equivalent.
- **Writes:** OPC UA writes per attribute, while i3X writes the full value. Objects mix read-only and writable fields (`SerialNumber` sits next to `AssetId`), and writes across several nodes aren't atomic.
- **Question:** which settings does the gateway own, and which should i3X expose?

### 8. Scope: what i3X deliberately doesn't cover

- OPC UA Methods, Events and Alarms & Conditions, Views, and model-change notifications have no i3X equivalent. Machinery Notifications can be Events.
- `GET /objects` returns the whole address space with no paging, while OPC UA is built to be browsed incrementally.
- OPC UA user identity and role permissions need to map to i3X authentication.
- **Question:** which gaps are out of scope for 1.x, which are vFuture, and which are gateway guidance?

---

## 9. Sequencing and next steps

**Proposed order for the 12-month stream:**
1. Settle items 1–3 first, using Machinery as the reference case, because everything else depends on them.
2. Run item 4 as its own sub-stream once item 1 settles, and produce the item 4i outputs.
3. Run items 5–7 in parallel after items 1–3.
4. Decide item 8's scope early; the work itself comes later.

**Before we close:**
- Agree on owners for items 1–4.
- Confirm Machinery 1.04.2 as the reference model, and get the matching 1.04.2 NodeSet.
- Pick a cadence for the stream.

## Parking lot

*(Record items raised in the meeting that don't fit the topics above.)*
