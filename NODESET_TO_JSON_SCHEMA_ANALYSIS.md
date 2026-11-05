# NodeSet → JSON Schema: Fidelity Analysis (Agenda Item 4)

**Question:** when an OPC UA information model is expressed as i3X ObjectTypes, which parts can JSON Schema represent faithfully? Which need a convention or extension, and which cannot be represented at all?
**Starting point:** OPC UA for Machinery, Basic Building Blocks. We use the local NodeSet (`Machinery-Basic-Building-Blocks.NodeSet2.xml`, v1.03.0) for constructs, and the 1.04.2 spec for semantics.
**Goal:** get as close to full fidelity as possible. Where we can't, write down one consistent workaround so every implementation does the same thing.

---

# 1. Ground rules and assumptions

**JSON Schema draft.** The i3X Implementation Guide doesn't name one. This analysis assumes **2020-12**, the current draft, which OpenAPI 3.1 uses. It is the first draft with formal vocabularies (`$vocabulary`), and it says unknown keywords SHOULD be collected as annotations rather than rejected. *Recommendation: the Guide should name the draft.*

**"JSON Schema and its extensions" covers:**
- **The 2020-12 vocabularies:** Core (`$id`, `$ref`, `$defs`, `$dynamicRef`, `$comment`, `$vocabulary`); Applicator (`allOf`/`anyOf`/`oneOf`/`not`, `if`/`then`/`else`, `properties`, `patternProperties`, `additionalProperties`, `dependentSchemas`, `prefixItems`, `items`, `contains`); Unevaluated (`unevaluatedProperties`, `unevaluatedItems`); Validation (`type`, `enum`, `const`, numeric/string/array/object limits, `required`, `dependentRequired`); Meta-Data (`title`, `description`, `default`, `deprecated`, `readOnly`, `writeOnly`, `examples`); Format (`date-time`, `uri`, `uuid`, `duration`, …); Content (`contentEncoding`, `contentMediaType`, `contentSchema`).
- **The OpenAPI 3.1 dialect:** `discriminator`, `externalDocs`, `xml`, `example`, and `x-*` extension keywords.
- **Custom vocabularies or annotation keywords:** the mechanism we'd use to carry OPC UA facts that JSON Schema has no keyword for.

**Where information lives in i3X.** JSON Schema is only one part of an i3X type. Some OPC UA facts belong elsewhere:

| i3X location | What it can hold |
|---|---|
| `ObjectType.schema` | The value's shape (JSON Schema) |
| `ObjectType` fields | `elementId`, `displayName`, `namespaceUri`, `sourceTypeId`, `version`, `related` |
| `RelationshipType` | `elementId`, `displayName`, `namespaceUri`, `relationshipId`, `reverseOf` |
| `Namespace` | `uri`, `displayName` only |
| Object record and `metadata` | instance identity, parent, relationships, `system` passthrough |

**Fidelity legend** used throughout:

| Mark | Meaning |
|---|---|
| ✅ **Native** | A standard JSON Schema keyword or i3X field expresses it fully |
| 🟡 **Approximate** | A native keyword exists but loses some meaning (needs a documented convention) |
| 🔧 **Annotation** | No native keyword; needs an agreed extension keyword (proposed `x-opcua`, see §6) |
| ⛔ **None** | Outside JSON Schema and i3X today; only possible with i3X API changes, or out of scope |

---

# 2. What the Machinery NodeSet actually uses

Taken from the NodeSet XML, so the analysis covers real constructs rather than all of OPC UA.

| Construct | Count / values | Notes |
|---|---|---|
| `UAObjectType` | 11 | 4 have `IsAbstract="true"` (the 3 `I…Type` interfaces and `MachineryItemIdentificationType`) |
| `UAVariable` | 88 | Almost all are Properties (`HasTypeDefinition i=68`) |
| `UAObject` | 44 | 24 are state-machine States/Transitions (type-only), plus `Machines` and NamespaceMetadata instances |
| VariableTypes, DataTypes, ReferenceTypes, Methods | 0 | Machinery defines none, but **inherits them** from UA core, DI and Part 16 (see §8) |
| References | HasProperty 174, HasTypeDefinition 132, HasComponent 85, HasModellingRule 75, FromState/ToState 64 each, HasSubtype 11, HasInterface 8, HasAddIn 2, Organizes 1 | |
| ModellingRules | Mandatory 52, Optional 21, OptionalPlaceholder 1 (`<Component>`), MandatoryPlaceholder 1 (`<LifetimeVariable>`) | Type-only nodes have none |
| DataTypes used | UInt32, String, QualifiedName, LocalizedText, Number, DateTime, UInt16, Duration, Byte, UInteger, NumericRange, IdType, EUInformation, Boolean | Includes abstract types (Number, UInteger) |
| `AccessLevel="3"` (read/write) | AssetId, ComponentName, Location, the counters, `<LifetimeVariable>`, DefaultInstanceBrowseName | Absent = 1 (read-only) |
| `ValueRank="1"` | 2 (NamespaceMetadata arrays) | No multi-dimensional arrays |
| `Value` (defaults/constants) | StateNumber, TransitionNumber, DefaultInstanceBrowseName, AssetId/ComponentName (`""`) | |
| Descriptive | `DisplayName` 143, `Description` 91, `Category` 14, `Documentation` 13, `SymbolicName` 3 | |

**1.04.2 adds:** `MonitoringType`, `MachineryEquipmentFolderType`, `IMachineryEquipmentType` and `NotificationsType`. These bring in `HasInterface` on placeholder children, `GeneratesEvent`, `2:DeviceHealthEnumeration` (an Enumeration), and `3:BasicStacklightType` (IA).

---

# 3. Fidelity matrix

| # | NodeSet construct | JSON Schema / i3X mechanism | Fidelity | Notes |
|---|---|---|---|---|
| **Model and namespace** |||||
| 1 | `Model/@ModelUri` | `Namespace.uri` | ✅ | Add `?projection=i3X` when lossy |
| 2 | `Model/@Version`, `@PublicationDate` | `ObjectType.version` (per type) | 🟡 | No namespace-level version or date in i3X |
| 3 | `RequiredModel` (dependencies) | — | ⛔ | i3X Namespace has no dependency list |
| 4 | `Aliases`, `NamespaceUris` index table | — | n/a | XML serialization devices, not needed |
| **Identity and description** |||||
| 5 | `NodeId` of a type | `ObjectType.sourceTypeId` | ✅ | Prefer `nsu=` form; `ns=` indexes are local to each server |
| 6 | `NodeId` of an InstanceDeclaration | — | 🔧 | No slot in the schema |
| 7 | `BrowseName` (namespace-qualified) | Property key | 🟡 | Keys are plain strings; the namespace is lost, so names can collide (§5.2) |
| 8 | `DisplayName` (one per locale) | `title` / `ObjectType.displayName` | 🟡 | One string only; other locales are lost |
| 9 | `Description` (one per locale) | `description` | 🟡 | One string only |
| 10 | `Documentation` (URL) | OpenAPI `externalDocs` | 🟡/🔧 | Not a core JSON Schema keyword |
| 11 | `SymbolicName` | — | 🔧 | Used for code generation |
| 12 | `Category` (conformance units) | — | 🔧 | |
| 13 | `ReleaseStatus` (Draft/Released/Deprecated) | `deprecated` | 🟡 | Only "Deprecated" maps |
| **Type system** |||||
| 14 | `HasSubtype` (ObjectType) | `allOf: [{$ref: base}]` plus i3X `InheritsFrom` | ✅ | Breaks if a base is closed (§5.1) |
| 15 | `IsAbstract` | — | 🔧 | JSON Schema has no "abstract" concept |
| 16 | `HasInterface` | `allOf` (one `$ref` per interface) | 🟡 | Membership is lost: you can't tell which properties came from which interface |
| 17 | Interface (`BaseInterfaceType` subtype) | an ObjectType that is never instantiated | 🔧 | Needs an `isInterface` marker |
| 18 | AddIn (`HasAddIn` + `DefaultInstanceBrowseName`) | nested property `$ref`, or an i3X `HasComponent` child | 🟡/🔧 | Default name is type-only metadata |
| 19 | Overriding an InstanceDeclaration (tightening ModellingRule or TypeDefinition) | `allOf` adds `required` / a narrower `$ref` | ✅ | Tightening composes correctly; OPC UA doesn't allow loosening either |
| **InstanceDeclarations** |||||
| 20 | Property (`HasProperty`, PropertyType) | value property | ✅ | |
| 21 | DataVariable (`HasComponent`, BaseDataVariableType) | value property **or** a separate i3X object | 🟡 | Agenda item 1; the Property/DataVariable distinction is lost unless annotated |
| 22 | Object component (`HasComponent` to an Object) | nested object `$ref` **or** an i3X `HasComponent` child | 🟡 | Agenda item 1 |
| 23 | ModellingRule Mandatory | `required` | ✅ | |
| 24 | ModellingRule Optional | absent from `required` | ✅ | Machinery §7.2: omit, don't send null |
| 25 | OptionalPlaceholder | `additionalProperties` / `patternProperties` | 🟡 | The placeholder's BrowseName pattern is lost |
| 26 | MandatoryPlaceholder | the above plus `minProperties: 1` | 🟡 | `minProperties` counts **all** properties, so it only works on a dedicated container object |
| 27 | No ModellingRule (type-only node) | — | 🔧 | E.g. DefaultInstanceBrowseName, state-machine States |
| **Variable attributes** |||||
| 28 | `DataType` | `type` / `format` / `$ref` | ✅–🟡 | See the DataType table (§4) |
| 29 | `ValueRank` / `ArrayDimensions` | `type: array`, nested `items`, `minItems`/`maxItems` | 🟡 | "Scalar or array" (-2, -3) needs `anyOf`; rectangular arrays can't be enforced |
| 30 | `AccessLevel` read vs write | `readOnly` | ✅ | Matters for i3X full-value writes |
| 31 | `AccessLevel` history bits, `Historizing` | — | 🔧 | Per-property history isn't representable; i3X history is per object |
| 32 | `MinimumSamplingInterval` | — | 🔧 | |
| 33 | `Value` on an InstanceDeclaration (default) | `default` | ✅ | |
| 34 | `Value` on a type-only node (constant) | `const` / annotation | 🟡 | E.g. StateNumber = 3 |
| 35 | EngineeringUnits / EURange (Properties) | — | 🔧 | Discussion item D3; EURange is an operating range, not a validation limit |
| **References inside types** |||||
| 36 | `FromState` / `ToState` and other non-hierarchical references between InstanceDeclarations | — | ⛔/🔧 | JSON Schema describes a tree; it can't express edges |
| 37 | `HasInterface` on a placeholder child (1.04.2) | `$ref` on the placeholder schema | 🟡 | |
| 38 | `GeneratesEvent` | — | ⛔ | i3X has no events |
| **Other NodeClasses** |||||
| 39 | ReferenceType: InverseName | `RelationshipType.reverseOf` | 🟡 | The inverse must be registered as its own type |
| 40 | ReferenceType: Symmetric | `reverseOf` = itself | 🟡 | Convention, not stated in the Guide |
| 41 | ReferenceType: IsAbstract, subtype hierarchy | — | ⛔ | You can't ask "all HasComponent subtypes" |
| 42 | Method (Input/OutputArguments) | arguments could be schemas | ⛔ | i3X has no way to invoke methods |
| 43 | EventType, EventNotifier | — | ⛔ | |
| 44 | View | — | ⛔ | |
| 45 | RolePermissions, AccessRestrictions | — | ⛔ | Server security, not schema |
| 46 | Instance nodes in a NodeSet (`Machines`, NamespaceMetadata) | i3X object records | n/a | Not schema; they become objects |

---

# 4. DataTypes

| OPC UA DataType | JSON Schema | Fidelity | Notes and pitfalls |
|---|---|---|---|
| Boolean | `boolean` | ✅ | |
| SByte, Int16, Int32, Byte, UInt16, UInt32 | `integer` + `minimum`/`maximum` | ✅ | Bounds give full fidelity |
| Int64, UInt64 | `integer` (or `string` + `pattern`) | 🟡 | JSON numbers above 2^53 lose precision in many clients. **Decision needed** |
| Float, Double | `number` | 🟡 | **NaN and ±Infinity can't be represented in JSON** |
| Decimal | `string` or `number` | 🟡 | |
| Number / Integer / UInteger (abstract) | `number` / `integer` / `integer, minimum 0` | 🟡 | The concrete subtype is lost (used by `<LifetimeVariable>` and `OperationCycleCounter`) |
| String | `string` | ✅ | `MaxStringLength` → `maxLength` |
| LocaleId, NormalizedString, … (String subtypes) | `string` + annotation | 🟡 | There's no `format` for BCP 47 locale tags |
| DateTime, UtcTime | `string`, `format: date-time` | ✅ | The Guide requires UTC with `Z` |
| **Duration** | `number` + unit annotation | 🟡 | ⚠ This is milliseconds as a Double. **Do not use `format: duration`**, which means an ISO 8601 *string* |
| Guid | `string`, `format: uuid` | ✅ | |
| ByteString | `string`, `contentEncoding: base64` | ✅ | |
| XmlElement | `string`, `contentMediaType: application/xml` | ✅ | |
| NodeId, ExpandedNodeId | `string` + `pattern` | 🟡 | Needs a canonical `nsu=` form |
| QualifiedName | `string` or `{namespaceUri, name}` | 🟡 | **Decision needed.** Used by DefaultInstanceBrowseName |
| LocalizedText | `string` (text only) or `{locale, text}` / an array | 🟡 | **Decision needed.** Machinery requires ≥ 2 locales for `ComponentName`, which only the array form can carry |
| StatusCode | `integer` or symbolic `string` | 🟡 | Align with discussion item D2 |
| BaseDataType / Variant | `{}` (any) | 🟡 | The type information is lost |
| Enumeration | `oneOf: [{const: 0, title: "Name"}, …]` | 🟡 | Plain `enum` has no labels. **Decision needed:** integer, name, or both |
| OptionSet | `integer` bitmask, or an object of booleans | 🟡 | |
| Structure | `object` built from StructureDefinition fields | ✅ | `IsOptional` → not in `required`. Nested field `ValueRank` follows row 29 |
| Union | `oneOf` | 🟡 | The switch field is lost |
| Structure with `AllowSubTypes` | `$ref` base + OpenAPI `discriminator` | 🟡/⛔ | Core JSON Schema has no polymorphic dispatch |
| EUInformation (Part 8) | `{namespaceUri, unitId, displayName, description}` | ✅ | Or reduce it to a UNECE code (D3) |
| NumericRange | `string` | 🟡 | Used only in NamespaceMetadata |

---

# 5. Pitfalls to agree on up front

## 5.1 Closed schemas break subtyping

If a base type's schema sets `additionalProperties: false`, then **every subtype instance fails validation against the base**. That matters wherever OPC UA references an abstract or base type, for example `<Component>`'s `Identification` is typed as the abstract `MachineryItemIdentificationType`. It would also make i3X `isExtended` detection noisy.

**Workaround:** leave type schemas open. If closing is wanted, use `unevaluatedProperties: false` only on the fully resolved schema of the concrete type the server serves, never on a base that others `$ref`.

## 5.2 BrowseNames are namespace-qualified; JSON keys aren't

`Identification` combines DI names (`2:Manufacturer`, `2:SerialNumber`) with Machinery names (`YearOfConstruction`, `Location`). Using `"2:Manufacturer"` as a key bakes in a namespace index that is local to one server. Using `"Manufacturer"` risks a collision if two namespaces define the same name on one type. OPC UA allows that, but it's rare.

**Workaround:** use the bare name as the key and record the qualified name in an annotation (`x-opcua.browseName`). If two names collide, use a deterministic disambiguation rule (e.g. append the namespace's short name).

## 5.3 Folding loses per-node status and timestamps

When Properties or DataVariables are folded into one JSON value, the object has a single VQT, and each field's own OPC UA StatusCode and timestamp are lost. That is a value-level issue (agenda item 6), but it also argues for keeping fast-changing DataVariables as separate i3X objects (agenda item 1).

## 5.4 Polymorphic children belong in the object graph, not the schema

Placeholders like `<Component>` accept *any* ObjectType. JSON Schema can only say "an object that matches the base". Without OpenAPI's `discriminator`, it can't pick the concrete subtype schema.

**Workaround:** model polymorphic children as separate i3X objects, each with its own `typeElementId`, linked by `HasComponent`. Don't nest them in the parent's value schema.

## 5.5 Type-level references aren't representable

JSON Schema describes a tree. State-machine `FromState`/`ToState` edges, `GeneratesEvent`, and other references between InstanceDeclarations can't be expressed. They either go into annotations or are dropped deliberately.

---

# 6. Proposed extension: an `x-opcua` annotation keyword

JSON Schema 2020-12 collects unknown keywords as annotations, and OpenAPI 3.1 reserves `x-*` for extensions. We propose **one** annotation keyword, `x-opcua`, holding an object, allowed on any (sub)schema. One keyword is easier to ignore, strip or version than many. (The alternative is a formal `$vocabulary` with a published meta-schema, which is a heavier but stricter option for the working group to weigh.)

| `x-opcua` member | Applies to | Carries | Closes row(s) |
|---|---|---|---|
| `nodeClass` | any | `ObjectType`, `Object`, `Variable`, … | 21, 22 |
| `browseName` | any | `{ns: <namespace URI>, name}` | 7 |
| `nodeId` | any | canonical `nsu=` NodeId | 6 |
| `typeDefinition` | property | e.g. `PropertyType`, `BaseDataVariableType`, `2:LifetimeVariableType` | 21 |
| `referenceType` | property | `HasProperty`, `HasComponent`, `HasAddIn`, … | 21, 22 |
| `modellingRule` | property | the original rule, including placeholders | 25–27 |
| `isAbstract` | type | `true` | 15 |
| `isInterface` | type | `true` | 17 |
| `interfaces` | type | list of interface elementIds (keeps membership) | 16 |
| `defaultInstanceBrowseName` | type | e.g. `{ns: DI, name: "Identification"}` | 18, 27 |
| `dataType` | property | the exact OPC UA DataType (e.g. `UInt16`, `LocalizedText`, `Duration`) | 28, DataType table |
| `valueRank`, `arrayDimensions` | property | the originals | 29 |
| `historizing`, `minimumSamplingInterval` | property | the originals | 31, 32 |
| `engineeringUnits` | property | UNECE code (pending D3) | 35 |
| `typeOnly` | type | members that exist only on the type (constants, States, Transitions) | 27, 34, 36 |
| `references` | type | non-hierarchical references between members, e.g. `{FromState, ToState}` | 36 |
| `category`, `documentation`, `symbolicName` | any | the originals | 10–12 |

**Effect:** with `x-opcua`, a NodeSet → i3X → NodeSet round trip becomes possible for everything except the ⛔ rows. Clients that ignore annotations still get a clean, validating JSON Schema.

---

# 7. Where JSON Schema goes *beyond* the NodeSet

Several Machinery rules exist only as prose in the spec. The NodeSet can't express them, but JSON Schema can, so a well-built i3X type would validate *more* than the NodeSet does.

| Machinery rule (spec prose) | JSON Schema | Expressible? |
|---|---|---|
| YearOfConstruction is a four-digit number (§8.2) | `minimum: 1000, maximum: 9999` | ✅ |
| MonthOfConstruction is 1–12 (§8.2) | `minimum: 1, maximum: 12` | ✅ |
| MonthOfConstruction only if YearOfConstruction is present (§8.2) | `dependentRequired` | ✅ |
| ProductInstanceUri ≤ 255 characters (§8.2) | `maxLength: 255`, `format: uri` | ✅ |
| ProductInstanceUri should start with ManufacturerUri (§8.2) | — | ⛔ JSON Schema can't compare one field with another |
| InitialOperationDate in UTC (§8.2) | `format: date-time` + `pattern: "Z$"` | ✅ |
| Servers support ≥ 40 characters for AssetId and ComponentName (§8.3) | — | ⛔ A server capability guarantee, not a validation rule (document it in `description`) |
| Counters only increase and never reset (§14) | — | ⛔ A rule over time |
| LifetimeVariable value lies between StartValue and LimitValue | — | ⛔ Compares one field with another |

**Recommendation:** treat these prose constraints as part of fidelity, and encode the ✅ ones.

---

# 8. Dependencies: Machinery can't be translated on its own

Machinery types inherit from or implement types in other namespaces. Those must be translated first, at the same fidelity:

| Namespace | Types Machinery depends on |
|---|---|
| UA core (ns 0) | BaseObjectType, FolderType, BaseInterfaceType, PropertyType, BaseDataVariableType, all DataTypes |
| UA Part 16 (ns 0) | StateMachineType → FiniteStateMachineType, StateType, TransitionType, StateVariableType (`CurrentState` with `Id`/`Number`) |
| DI (OPC 10000-100) | FunctionalGroupType, IVendorNameplateType, ITagNameplateType, IOperationCounterType, LifetimeVariableType, IDeviceHealthType, DeviceHealthEnumeration |
| IA (OPC 10000-200), 1.04.2 only | BasicStacklightType |

**The state-machine dependency is the most significant.** `MachineryItemState_StateMachineType` and `MachineryOperationModeStateMachineType` add only type-only States and Transitions (4 + 16 each, none instantiated). Everything an instance actually carries comes from Part 16, and none of it is in the Machinery NodeSet:
- `CurrentState`, with its `Id` and optional `Number`.
- The optional `LastTransition`.
- The optional `AvailableStates` / `AvailableTransitions`.

Translate the Machinery NodeSet alone, and these two types end up with an **empty instance schema**: nothing to read, subscribe to, or historize. Their usefulness, for example the ISO 22400 KPI derivation in Machinery Annex C, depends entirely on the Part 16 translation, and on agreeing how `CurrentState` is represented (§9 sketch).

**Recommendation:** produce the ns0 (including Part 16) and DI translations as shared, versioned artifacts, so every i3X server references the same type elementIds instead of re-deriving them. Do Part 16 first, since the state machines are the highest-value Machinery data.

---

# 9. Worked example: `MachineIdentificationType`

This example is illustrative. It shows the **unresolved** (`allOf`) form so that inheritance and interfaces stay visible. The choices it makes (bare-name keys, LocalizedText as plain text, `x-opcua`) are proposals.

```json
{
  "elementId": "MachineIdentificationType",
  "displayName": "MachineIdentificationType",
  "namespaceUri": "http://opcfoundation.org/UA/Machinery/?projection=i3X",
  "sourceTypeId": "nsu=http://opcfoundation.org/UA/Machinery/;i=1012",
  "version": "1.4.2",
  "related": { "InheritsFrom": ["MachineryItemIdentificationType"] },
  "schema": {
    "description": "Contains information about the identification and nameplate of a machine",
    "x-opcua": {
      "nodeClass": "ObjectType",
      "interfaces": ["IMachineVendorNameplateType", "IMachineTagNameplateType"],
      "defaultInstanceBrowseName": { "ns": "http://opcfoundation.org/UA/DI/", "name": "Identification" },
      "category": ["Machinery Machine Identification"]
    },
    "allOf": [
      { "$ref": "#/types/MachineryItemIdentificationType" },
      { "$ref": "#/types/IMachineVendorNameplateType" },
      { "$ref": "#/types/IMachineTagNameplateType" },
      {
        "type": "object",
        "required": ["ProductInstanceUri"],
        "properties": {
          "ProductInstanceUri": {
            "type": "string", "format": "uri", "maxLength": 255, "readOnly": true,
            "description": "A globally unique resource identifier provided by the manufacturer of the machine",
            "x-opcua": { "browseName": { "ns": "http://opcfoundation.org/UA/DI/", "name": "ProductInstanceUri" },
                         "referenceType": "HasProperty", "dataType": "String", "modellingRule": "Mandatory" }
          },
          "Location": {
            "type": "string",
            "description": "To be used by end users to store the location of the machine in a scheme specific to the end user. Servers support at least 60 Unicode characters.",
            "x-opcua": { "browseName": { "ns": "http://opcfoundation.org/UA/Machinery/", "name": "Location" },
                         "referenceType": "HasProperty", "dataType": "String", "modellingRule": "Optional" }
          }
        }
      }
    ]
  }
}
```

An excerpt of the base type, `MachineryItemIdentificationType`, showing the prose constraints from §7:

```json
{
  "type": "object",
  "x-opcua": { "nodeClass": "ObjectType", "isAbstract": true,
               "interfaces": ["IMachineryItemVendorNameplateType", "2:ITagNameplateType"] },
  "allOf": [{ "$ref": "#/types/2:FunctionalGroupType" }],
  "required": ["Manufacturer", "SerialNumber"],
  "dependentRequired": { "MonthOfConstruction": ["YearOfConstruction"] },
  "properties": {
    "Manufacturer":         { "type": "string", "readOnly": true, "x-opcua": { "dataType": "LocalizedText" } },
    "SerialNumber":         { "type": "string", "readOnly": true },
    "YearOfConstruction":   { "type": "integer", "minimum": 1000, "maximum": 9999, "readOnly": true, "x-opcua": { "dataType": "UInt16" } },
    "MonthOfConstruction":  { "type": "integer", "minimum": 1, "maximum": 12, "readOnly": true, "x-opcua": { "dataType": "Byte" } },
    "InitialOperationDate": { "type": "string", "format": "date-time", "readOnly": true },
    "AssetId":              { "type": "string", "default": "" },
    "ComponentName":        { "type": "string", "default": "", "x-opcua": { "dataType": "LocalizedText" } }
  }
}
```

**What this example shows:**
- Inheritance and interfaces both compose cleanly with `allOf`. The subtype tightens `ProductInstanceUri` to required, just as OPC UA does.
- `readOnly` separates nameplate fields from user-writable tag fields, which is what an i3X full-value write needs.
- `DefaultInstanceBrowseName` and `IsAbstract` have no native home, so they sit in `x-opcua`.
- `ComponentName` as a plain string can't carry the two locales Machinery requires. That's the LocalizedText decision.
- `"#/types/…"` follows the Guide's bundle-style example. It doesn't resolve inside a standalone schema, which is an open question for the Guide.

**Sketches of the harder types:**
- **`MachineryLifetimeCounterType`:** the MandatoryPlaceholder becomes `{"type": "object", "minProperties": 1, "additionalProperties": {"$ref": "#/types/2:LifetimeVariableType"}}` on a dedicated container (see row 26). Each `LifetimeVariableType` is a *number with properties* (EngineeringUnits, StartValue, LimitValue). That forces a choice: a scalar leaf with the properties in `x-opcua`/metadata, or an object with an invented `value` key next to its properties (agenda 4e).
- **`MachineryItemState_StateMachineType`:** the instance value is `CurrentState`. It is inherited from Part 16, not declared by Machinery (see §8). It can be represented as `{"oneOf": [{"const": 0, "title": "NotAvailable"}, {"const": 1, "title": "OutOfService"}, {"const": 2, "title": "NotExecuting"}, {"const": 3, "title": "Executing"}]}`. The 4 States and 16 Transitions are type-only (`x-opcua.typeOnly`), and the `FromState`/`ToState` edges can only go into `x-opcua.references` or be dropped (row 36).

---

# 10. Expected fidelity per Machinery type

Assumes `x-opcua` is adopted. "High" means everything except annotation-only facts carries over.

| Type | Expected fidelity | What limits it |
|---|---|---|
| IMachineryItemVendorNameplateType | High | Interface/abstract annotations only |
| IMachineVendorNameplateType | High | Tightening `required` works natively |
| IMachineTagNameplateType | High | RW vs RO via `readOnly` |
| MachineryItemIdentificationType | High | Abstract; DefaultInstanceBrowseName is type-only; LocalizedText decision |
| MachineIdentificationType | High | As above |
| MachineryComponentIdentificationType | High | As above |
| MachineryOperationCounterType | High | Duration unit (D3); DI interface must be translated first |
| MachineComponentsType | Medium | Polymorphic OptionalPlaceholder: better as i3X child objects than as schema (§5.4) |
| MachineryLifetimeCounterType | Medium | MandatoryPlaceholder plus number-with-properties variables |
| MachineryItemState_StateMachineType | Medium–Low | Type-only States/Transitions, FromState/ToState edges, Part 16 dependency |
| MachineryOperationModeStateMachineType | Medium–Low | As above |
| *(1.04.2)* IMachineryEquipmentType | High–Medium | `EquipmentLife` is a lifetime variable |
| *(1.04.2)* MachineryEquipmentFolderType | Medium | Placeholder with `HasInterface` on children |
| *(1.04.2)* MonitoringType | Medium | Optional folders that *reference* nodes owned elsewhere (multi-path, agenda item 2) |
| *(1.04.2)* NotificationsType | Low | Event-based notifications ⛔ |

---

# 11. Decisions for the working group

1. **JSON Schema draft:** confirm 2020-12, and ask the Guide to state it.
2. **Extension mechanism:** a single `x-opcua` annotation keyword, or a formal `$vocabulary` with a meta-schema?
3. **Property keys:** bare BrowseName plus an annotated qualified name, with a collision rule (§5.2)?
4. **LocalizedText and QualifiedName:** plain strings, or structured values?
5. **64-bit integers, NaN/Infinity, Decimal:** number or string?
6. **Enumerations:** integer, name, or both (`oneOf` + `const` + `title`)?
7. **Open vs closed schemas:** keep them open, and close only resolved concrete types (§5.1)?
8. **Resolved vs unresolved schemas:** should servers serve the `allOf` chain, the fully resolved schema, or both? And where should `$ref` point (bundle `#/types/…` or absolute `$id` URIs)?
9. **Type-only members** (constants, state machines): annotate, or drop?
10. **Prose constraints:** should i3X type authors encode them (§7)?
11. **Shared base translations:** who produces and versions the ns0, Part 16 and DI translations (§8)?
12. **Out of scope for the schema:** confirm that Methods, Events, Views and security metadata are ⛔ for 1.x.
