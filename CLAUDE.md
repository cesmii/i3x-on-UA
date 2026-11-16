# i3x-on-OPC

Project goal (inferred): expose OPC UA information models through the **CESMII i3X 1.0** API. **OPC UA for Machinery** (OPC 40001-1, namespace `http://opcfoundation.org/UA/Machinery/`, builds on DI `http://opcfoundation.org/UA/DI/`) is an important starting point but not the only model in scope. Keep the mapping generic to OPC UA and treat Machinery as the first, best-specified case.

## Reference material (local copies in `docs/i3x/`, fetched 2026-11-03)

| File | Source | Role |
|---|---|---|
| `docs/i3x/IMPLEMENTATION_GUIDE.md` (IG) | cesmii/i3X@1.0 `spec/IMPLEMENTATION_GUIDE.md` | **Normative, 1.0 final.** Endpoint-level requirements. |
| `docs/i3x/openapi.json` | https://api.i3x.dev/v1/openapi.json (OpenAPI 3.1, `info.version: "release"`) | **Normative** wire contract (request/response schemas). Server base `/v1`. |
| `docs/i3x/UNDERSTANDING_RELATIONSHIPS.md` | cesmii/i3X@1.0 | **Normative companion**: hierarchy vs composition vs graph, with JSON examples. Its examples predate some field renames (see discrepancies). |
| `docs/i3x/RFC.md` | cesmii/i3X@1.0 RFC 001 | **Directional only, NOT normative.** Use it for intent and rationale, never as a requirement source. Anything that exists only in the RFC (e.g. `engUnit`, the "API keys minimum" rule) is not part of the contract. |
| `docs/machinery/OPC 40001-1 - UA CS for Machinery Part 1 - Basic Building Blocks 1.04.2.pdf`; text extract in `docs/machinery/OPC-40001-1-Machinery-1.04.2.txt` | user-supplied | **Machinery companion spec 1.04.2**, the primary domain model. Use the `.txt` for grep (layout-preserved, so tables and diagrams are approximate); check the PDF for figures. |
| `docs/opcua/OPC-10000-5-Part5-InformationModel.md` | https://reference.opcfoundation.org/specs/OPC-10000-5/full (v1.05.06, HTML → text) | OPC UA standard ns=0 types: ObjectTypes (§6), VariableTypes (§7), standard Objects/folders (§8), ReferenceTypes (§11), DataTypes (§12), modelling guidance (Annex A). Large file; grep for `^## ` / `^### ` headings. |
| `docs/opcua/OPC 40223 - UA Companion Specification for Pumps and Vacuum Pumps 1.00.pdf`; text extract `docs/opcua/OPC-40223-Pumps-1.00.txt` | user-supplied | **Pumps companion spec 1.00.** Ports: §6.2.1, §7.36–7.39 (`PortType` `Direction`/`Category`/`IdCarrier`; no connecting reference defined). |
| `nodesets/vendor/Acme-Mix-Tank-Profile.NodeSet2.xml` | **CESMII-owned**: we may repair it and rev its version | **Non-standard vendor profile**: `MixingTankType`, `https://cesmii.net/profiles/AcmeMixTank` **v1.01** (shared-declaration fix; 1.00 archived and `CHANGELOG.md` in `docs/acme/`; produced with `tools/repair_shared_declarations.py`, which may be run only on models we own). Deliberately realistic, with departures from the standards (interfaces used as TypeDefinitions, look-alike Machinery state machines, …); reviewed in `docs/factory/STANDARDS_COVERAGE.md`. |
| `nodesets/standard/*.NodeSet2.xml` | OPC Foundation, user-supplied | **All standard/companion NodeSets** (11): UA core 1.05.03, DI 1.04.0, IA 1.01.2, IRDI 1.00, Machinery 1.04.0, ProcessValues 1.00.0, PA-DIM 1.01.0, PackML 1.01, Pumps 1.0.0, ISA-95 COM 1.00, Weihenstephan 1.00.0 (reference only; not used). Check consistency with `python3 -I tools/resolve_check.py nodesets`. Coverage per plant element: `docs/factory/STANDARDS_COVERAGE.md`. |
| `docs/pmmi/Information Model - PMMI 01Jun.pdf` | PMMI, user-supplied; **not ours, never modify** | One-page diagram of a PMMI machine model (PackML data on Machinery building blocks), with reviewer notes. **Example / input, not normative.** |
| `docs/pmmi/PMMI PackML MBB Example 601.xml` | PMMI, user-supplied (SiOME-generated); **not ours, never modify** | NodeSet implementing part of the PMMI diagram, `http://pmmi.org/profiles/MachineExample` v1.00. **Example / input, not normative.** |

Read the relevant file before implementing an endpoint; the summary below is a map, not a substitute.

**Not in git:** the OPC Foundation spec PDFs/extracts (`docs/machinery/`, `docs/opcua/`) and the PMMI files (`docs/pmmi/`) are local copies only (`.gitignore`); each folder's `README.md` says where to download them. Never re-add them: the repo is meant to be public. The NodeSets in `nodesets/standard/` are OPC Foundation MIT and stay tracked; `docs/i3x/` is CESMII MIT (attribution in its README).

## Working documents (project root)

These are working-group deliverables for the 12-month "i3X over OPC UA" workstream, kicked off 2026-11-03. Treat the versions on disk as current; the user edits them.

| File | Purpose |
|---|---|
| `WG_AGENDA_i3X_OPC_UA.md` | Kickoff agenda: 8 topics, with item 4 (types → JSON Schema) as the deep dive |
| `BEVERAGE_FACTORY_PLAN.md` | Phased plan for the virtual beverage factory: a standards-based OPC UA model (node-opcua) projected to i3X by a generic gateway, with `metadata.opcua` fidelity notes; decisions D1–D8 (incl. pure Machinery + PackML for machines, Line 2 with injected hack-a-thon faults, Nginx handles TLS/auth) |
| `docs/factory/` | Factory design: `STANDARDS_COVERAGE.md` (Phase 0 result + Acme review + P1 decisions + ISA-95 COM gaps/defects for personnel, materials, orders), `PLANT_DESIGN.md` (Phase 1: equipment, instruments, flow links, hierarchy, IDs, simulation), `UA_MODEL_NOTES.md` (Phase 2: spike, node-opcua conventions, what the generator builds, deferred items, standards observations), `SIMULATION.md` (Phase 3), `PLANT_DIAGRAM.md` (Mermaid source with legend; `.mmd` exports for the user's Mermalaid app; validate and re-export after edits) |
| `docs/WALKTHROUGH.md` | Phase 6 guided compare: 13 stops (filler, nameplate, state, counts, methods, units, Int64, flow, vendor profile, history, notes), each found in UaExpert, cesmii, i3x2ua and uns |
| `docs/gateway/COMPARISON.md` | Ours vs Andreas Heine's i3x2ua: 47 observed differences (identity, objects, references, types, values, quality, writes, self-description, personnel/materials/orders), each with the element to inspect in both gateways and the WG question it raises |
| `NODESET_TO_JSON_SCHEMA_ANALYSIS.md` | Item 4 analysis: NodeSet vs JSON Schema 2020-12 fidelity matrix, proposed `x-opcua` annotations, Machinery worked example, decisions list |

## Code layout (npm workspaces, TypeScript, Node 24)
- Root `package.json` holds the workspaces (`factory`, `server`, `gateway`), plus pinned dev tools (typescript 5.9.3, tsx 4.23.15). Pin exact versions that are at least 2 weeks old.
- `factory/`: node-opcua **2.187.10** + node-opcua-address-space **2.187.9**.
  - `plant/line1.yaml` is the plant definition and source of truth.
  - `npm run generate -w factory` writes `nodesets/factory/ISA95Operations.NodeSet2.xml` (our leftover types: `WorkRequestType`, `JobOrderType`, and the ISA-95 cross-model ReferenceTypes `Operates`, `Consumes`, `Produces`, `StoredIn`, `DispatchedTo`, `DefinedByMaterialClass`; source `src/ops-types.ts`) and `nodesets/factory/BeverageFactory.NodeSet2.xml` (instances). Both are deterministic and commit-worthy; `FACTORY_NODESETS` in `src/lib/load.ts` lists them. `npm run verify -w factory` checks them.
  - Top-level hierarchies: equipment (Enterprise → Site → Areas), `EquipmentClasses`, `Machines`, and (since 2026-11-16) `Personnel`, `Materials`, `Orders` (ISA-95 resource + work models, linked to equipment only by graph references; `docs/factory/PLANT_DESIGN.md` §8).
  - `src/tools/inspect-type.ts` prints a type's member tree; `src/tools/browse.ts` is a generic client browse.
  - `factory/out/` is scratch space.
- `server/`: `npm start -w server` → `opc.tcp://localhost:4840/UA/BeverageFactory`. It loads `BASE_NODESETS` + the generated NodeSet and runs the Line 1 simulation (`server/src/sim/`).
  - Env: `SIM_SPEED`, `SIM_SEED`, `SIM_HISTORY`, `SIM_FAULTS`.
  - `npm run sim:check -w server -- <hours> <seed>` runs the headless invariant check.
  - Sim readings are keyed by NodeId path, so a new reading needs no binding config. See `docs/factory/SIMULATION.md`.
  - Restart the server after regenerating. PKI lives in `server/pki/` (gitignored).
- `gateway/`: our OPC UA → i3X gateway. `npm start -w gateway` → `http://localhost:8081/v1`. Config: `gateway/gateway.config.yaml`; interpretation switches can be overridden with `I3X_<KEY>` env vars.
  - The interpretation is in `docs/gateway/MAPPING.md`; build notes and results are in `docs/gateway/GATEWAY.md`.
  - It must stay **generic** (OPC UA services only; companion-spec logic only in `src/profiles/`, switchable) and **independent** of the other WG member's gateway (D9).
  - Switch `singleRoot` (+ `singleRootType`): one named Object becomes the only i3X root, re-typed `gateway:Enterprise`, and all other top-level Objects become its children. Off in `gateway.config.yaml`; on for cesmii in `compare/gateways.yaml` (Demo Beverage Co., user decision 2026-11-16).
  - The compare front door (:8084) relabels "Demo Beverage Co." per gateway (`relabel:` in `compare/gateways.yaml`), so Explorer windows can be told apart. It's cosmetic; the direct ports are untouched.
  - Conformance check: `cd ~/Projects/API/conformance-tests && node bin/i3x-test.js run http://localhost:8081/v1`. Run it only; don't modify that repo.
  - Fidelity audit (Phase 6): `npm run audit -w gateway` (plant server + gateway running). It reads the plant as a plain OPC UA client, independent of the gateway's code, and exits 1 if any loss isn't described in the i3X output. The catalogue is `docs/gateway/FIDELITY.md`. Any new mapping rule that loses information needs a fidelity note **and** an audit rule.
- **`./start.sh`** (root): one-step start for macOS/Linux/WSL. It checks Node, runs `npm ci` if needed, copies `.env.example` → `.env` (sim settings + `I3X_*` switches, gitignored), generates the NodeSet if missing, checks Docker, then `npm run compare`. Also `./start.sh status|conformance`. It re-execs itself under bash when started from zsh/sh, and keeps to bash 3.2 features (macOS `/bin/bash`).
- `uns/`: third comparison point, a **naive UNS-style i3X server**. `model.yaml` is hand-authored (asset tree plus `roots:` people/materials/orders, company types, flat JSON payloads, OPC UA tag map, Feeds/Supplies + hand-named `links:` graph); `src/main.ts` polls the plant every second and serves i3X on :8083 (`/uns/v1`). Deliberately ignores OPC UA types and references; design notes and "shape it" ideas are in `uns/README.md`. Conformance: 1.0 Compatible.
- `compare/`: the gateway switch (D9).
  - `compare/gateways.yaml` (`active:` is switched live) and `npm run compare [-- status|conformance]`.
  - Front door on :8084: `/v1` → active, `/cesmii/v1` (ours, :8081), `/i3x2ua/v1` (:8082), `/uns/v1` (:8083).
  - `i3x2ua` = Andreas Heine's **i3x2ua** (AGPL), run as an unmodified pinned container (`ghcr.io/andreasheine/i3x2ua:1.16.2`, port 8082). His mapping profile: `docs/OPCUA_I3X_MAPPING_PROFILE.md` in that repo. Never copy his code into this repo.
  - Fairness rule: each gateway runs with its own documented defaults; only connection settings change. Docker Desktop is needed for `i3x2ua`.
  - Lifecycle: one Ctrl-C stops all it started. Keep launcher-managed processes free of npm/tsx wrappers (`node --import tsx …`): wrappers forward a second SIGINT and tsx force-kills its child on the second one, which orphaned processes before.
- `deploy/`: production is **https://opcua.i3x.dev** on `cesmii@admin.cesmii.net` (checkout `/var/www/apps/i3x-on-UA`, unit `i3x-on-ua`, Nginx site `opcua`, Cloudflare in front). Push to `main` → `deploy/deploy.sh` (cron, every 3 min) restarts on the new commit; Markdown-only commits don't restart. On that host 8080/8081 are taken, so cesmii runs on 8085 (`COMPARE_PORT_CESMII`). Read-only: `COMPARE_READ_ONLY=1` and `GATEWAY_READ_ONLY=1`. See `deploy/README.md`. When working on that server over SSH, reuse one connection (ControlMaster): rapid logins time out.
- `factory/src/tools/read.ts [--history <s>] <path>…` reads values or history from the running server as a generic client.
- Workspace scripts run under zsh: split variables explicitly (`${=var}`) when looping over argument strings.
- node-opcua gotchas: set `NamespaceOptions.nodeIdNameSeparator = "/"`; pass `namespace:` to `instantiate()`; list Optional members in `optionals`; import the loader from `node-opcua-address-space/nodeJS.js` (with the `.js`, which NodeNext requires). See `docs/factory/UA_MODEL_NOTES.md`.

Related i3X work: the demo-server alignment in cesmii/i3X (`~/Projects/API`) is PR #362, branch `demo-openapi-alignment`.

## i3X in one screen

**What it is:** a vendor-neutral REST/JSON API (plus SSE) over a contextualized manufacturing information platform. It sits *above* OPC UA servers / UNS brokers, it does not replace the OPC UA REST API. The (directional) RFC acknowledges that requiring the full address space to be queryable at once is an anti-pattern for OPC UA's browse-as-you-go model, so plan to pre-browse/cache it.

**Address space**
- **Namespaces** `{uri, displayName}`: group *types* (ObjectTypes, RelationshipTypes). Instances do not belong to a namespace; they get one through their type (`metadata.typeNamespaceUri`). If our projection of an external namespace is inexact, suffix the URI with `?projection=i3X` (e.g. `http://opcfoundation.org/UA/Machinery/?projection=i3X`).
- **ObjectTypes** `{elementId, displayName, namespaceUri, sourceTypeId, version?, schema, related?}`: `schema` is **JSON Schema**. Inheritance is `allOf: [{$ref}]` and is also recorded as an `InheritsFrom` relationship (`related: {relationshipType: "InheritsFrom", types: [...]}`). Servers SHOULD serve fully resolved `allOf`. A `$ref` inside `properties` means composition, not inheritance. Scalar schemas (`number|integer|string|boolean`) are leaf types that return bare scalar values. Register an `UnknownType` (`{"type":"object"}`) for untyped instances. Fields are non-nullable unless declared with `["T","null"]`.
- **RelationshipTypes** `{elementId, displayName, namespaceUri, relationshipId, reverseOf}`: every type MUST have a registered reverse. Required: `HasParent`/`HasChildren`. Optional but should be supported: `HasComponent`/`ComponentOf`. Graph types (e.g. `SuppliedBy`/`Supplies`) are optional.
- **Objects** `{elementId, displayName, typeElementId, parentId|null, isComposition, isExtended, metadata?}`, where `metadata` = `{typeNamespaceUri, sourceTypeId, relationships?, description?, schemaExtensions? (only if isExtended), system? (vendor k/v)}`. Note that there is **no `engUnit` field** in the IG or OpenAPI; it exists only in the RFC (see discrepancies).
- **ElementIds**: unique, persistent strings with no leading/trailing whitespace and no non-printables. At least one root object (`GET /objects?root=true`).

**Relationship rules (common source of bugs)**
- All edges are stored **bidirectionally**.
- `parentId` MUST match `HasParent`. `/objects/related` MUST return hierarchy and composition edges too, synthesized if needed, not just graph edges.
- `isComposition: true` ⇔ the object has `HasComponent` children whose values make up its value. `maxDepth` recursion follows **only** `HasComponent`, never `HasChildren`.

**Values (VQT)**: `{value, quality, timestamp: RFC3339 UTC "Z"}`. `quality` is an **open string**: `Good`/`GoodNoData`/`Bad`/`Uncertain` are the base values, and more specific OPC UA StatusCode symbolic names (e.g. `Bad_NotConnected`, `Uncertain_LastUsableValue`, `Good_LocalOverride`) are allowed. Never restrict it to an enum. `value: null` ⇒ quality is `Bad` (incl. `Bad_*`) or `GoodNoData`. `maxDepth`: `1` = no recursion (default), `0` = unbounded, `N` = N levels. Nested values go under `components: {elementId: VQT}`. If a server limit truncates the result, return **206** with `responseDetail`; never truncate silently.

**Envelope** (every response; `GET /info` is disputed, see discrepancies):
- single: `{success: true, result}`
- bulk (any `elementIds[]` / `subscriptionIds[]` request): `{success, results: [{success, elementId|subscriptionId, result | responseDetail}]}`, in the **same order and length as the request**. Top-level `success` is false if any item failed.
- error: `{success: false, responseDetail: {title, status, detail}}` (RFC 9457). Codes: 200, 206, 400, 401, 403, 404, 500, 501.

**Endpoints** (all under `/v1`; requests send `Content-Type`/`Accept: application/json`; honor `Accept-Encoding: gzip`)

| Method | Path | Required? | Notes |
|---|---|---|---|
| GET | `/info` | MUST, **no auth** | `{specVersion:"1.0", serverVersion?, serverName?, capabilities:{query:{history}, update:{current,history}, subscribe:{stream}}}`. The IG shows it bare; OpenAPI wraps it in `{success, result}`. |
| GET | `/namespaces` | MUST | |
| GET | `/objecttypes?namespaceUri=` | MUST | |
| POST | `/objecttypes/query` | MUST | `{elementIds}` → bulk |
| GET | `/relationshiptypes?namespaceUri=` | MUST | |
| POST | `/relationshiptypes/query` | MUST | `{elementIds}` → bulk |
| GET | `/objects?typeElementId=&includeMetadata=&root=` | MUST | |
| POST | `/objects/list` | MUST | `{elementIds, includeMetadata?}` → bulk |
| POST | `/objects/related` | MUST | `{elementIds, relationshipType?, includeMetadata?}` → bulk of `[{sourceRelationship, object}]` |
| POST | `/objects/value` | MUST | `{elementIds, maxDepth?}` → bulk of `{isComposition, value, quality, timestamp, components?}` |
| POST | `/objects/history` | MUST (endpoint) | `{elementIds, startTime, endTime, maxDepth?}` → bulk of `{isComposition, values:[VQT]}`. With no historian, return `GoodNoData` and set `capabilities.query.history=false`. |
| PUT | `/objects/value` | MAY | `{updates:[{elementId, value:VQT}]}`, full-value writes only, `result: null` per item |
| PUT | `/objects/history` | MAY | same shape; return 501 if unsupported |
| POST | `/subscriptions` | MUST | `{clientId, displayName?}` → `{clientId, subscriptionId, displayName}` |
| POST | `/subscriptions/register` / `/unregister` | MUST | `{clientId, subscriptionId, elementIds, maxDepth?}`. Idempotent, partial failures allowed. |
| POST | `/subscriptions/sync` | MUST | `{clientId, subscriptionId, lastSequenceNumber?}` → `[{sequenceNumber, updates:[{elementId,value,quality,timestamp}]}]`. Omitting the ack keeps the queue; `-1` clears it; overflow drops the oldest updates and returns **206**. Error if a stream is open. |
| POST | `/subscriptions/stream` | MAY | SSE, at-most-once, one stream per subscription (a new stream replaces the old one), flushes the queue on open. A polling-only server returns 501. |
| POST | `/subscriptions/list` / `/delete` | MUST | `{clientId, subscriptionIds}` → bulk keyed by `subscriptionId` |

Subscription rules: `clientId` is required on every subscription call (else 400). The wrong `clientId` gets **404**, indistinguishable from a missing subscription. Subscriptions are TTL-deleted when neither sync nor stream activity happens. Non-push sources MAY implement sync by reading the latest value at sync time.

**Security**: HTTPS (TLS 1.2+) in production; authentication required on everything except `/info`. The IG leaves the scheme unspecified, and the OpenAPI declares no `securitySchemes`. Self-signed certs are fine for development.

## Discrepancies among the normative i3X docs (IG, OpenAPI, Understanding Relationships)
Reviewed 2026-11-03. The RFC is excluded because it is directional only. **Our default policy:** emit the stricter or more complete shape so that clients built against either document parse it. Where the documents genuinely conflict, the choice is noted.

**Envelope and status codes**
1. **`GET /info` envelope.** The IG shows a bare `ServerInfo` object. OpenAPI wraps it as `SuccessResponse_ServerInfo_` (`{success, result}`). *Unresolved; check the reference server.*
2. **`responseDetail` on success and 206 responses.** The IG requires it at top level on 206 and allows it on any 2xx. The OpenAPI `SuccessResponse_*` and `BulkResponse_*` schemas have **no `responseDetail` property**, and the `/subscriptions/sync` 206 response has **no schema at all**. → Emit it anyway, since extra fields are harmless.
3. **Error description field.** OpenAPI `default` responses say "see `responseDetail.code`", but `ErrorDetail` has `status`, not `code`. → Use `status`.
4. **Missing status codes in OpenAPI.** There is no 501 on `PUT /objects/value` (optional capability). There is no 501 on `/subscriptions/stream`, which the IG says polling-only servers SHOULD return. No status is defined anywhere for "sync while a stream is open" (the IG only says "MUST return an error"). 206 has no rule for bulk responses where only one item was truncated.
5. **`PUT /objects/history` 200** has an empty schema in OpenAPI, but the IG says it returns a bulk response.
6. **IG table vs IG text.** The Success table says "HTTP return must be 200", which contradicts 206 being a success.

**Object shape**
7. **Root `parentId`.** The IG field table says `null` for roots. The IG's own `/objects` and `/objects/list` examples use `"parentId": ""` with `"HasParent": "/"`. The relationships doc uses `"parentId": "/"` and `"HasParent": "/"`. → Emit `null` and omit `HasParent` on roots, but tolerate `""` and `"/"` on input.
8. **Required fields.** In the IG, `parentId` (nullable) and `isExtended` are required, as are `metadata.typeNamespaceUri`/`sourceTypeId` when metadata is present. OpenAPI makes `parentId` and `isExtended` optional (`isExtended` defaults to false) and every metadata field optional/nullable. → Always emit all of them.
9. **`metadata.system` requiredness is odd.** The IG says it is "Yes if `isExtended=true`", but `system` is the vendor passthrough. `schemaExtensions` is the field logically tied to `isExtended`, and the IG marks *that* one optional. This looks like a typo in the IG.
10. **`metadata.relationships` value shape is unspecified.** The examples mix single strings (`"HasParent": "pump-101"`, `"Monitors": "tank-201"`, `"ComponentOf": "pump-101"`) and arrays (`"HasChildren": [...]`, `"HasComponent": [...]`). OpenAPI types it as a free-form object. → Decide: either always arrays, or a string when the cardinality is 1 by definition. *Open question.*
11. **Relationships doc uses pre-1.0 field names and placement:** `typeId` (now `typeElementId`); `namespaceUri` on instances (instances have no namespace; use `metadata.typeNamespaceUri`); `relationships` at top level (now `metadata.relationships`); and `engUnit`/`calibrationDate` as top-level object fields (attributes belong in the *value*, not the object record).
12. **Engineering units have no home.** `engUnit` appears only in the RFC and as a stray top-level field in the relationships doc. It is absent from the IG metadata table and from OpenAPI `ObjectInstanceMetadata`. *Open question; raise with CESMII.*
13. **Namespace membership of instances.** The IG Address Space intro says Objects belong to a Namespace. The IG Namespaces section says they don't, and that "Each ObjectType and Relationship Type MUST belong to one Namespace". → Instances are namespace-less.
14. ~~`quality` enum vs string~~: **not a discrepancy.** The IG field table types `quality` as a string, and the four values are base examples; OPC UA StatusCode names (`Bad_NotConnected`, …) are valid. OpenAPI `string` is correct.

**Types and relationships**
0. **Metadata on non-Object entities (resolved by WG, 2026-11-05).** The spec limits `metadata` to Objects; the WG has accepted that as an error. ObjectTypes, RelationshipTypes and Namespaces may carry `metadata` too (i3X Explorer already renders it). → Emit it wherever useful, e.g. for fidelity-loss notes.
15. **`InheritsFrom` is under-specified.** The IG requires it to be tracked as a relationship, and also requires every RelationshipType to have a registered `reverseOf`. But no reverse name is defined for `InheritsFrom`, and it is not listed among the standard relationship types. → We need to register `InheritsFrom` and a reverse (e.g. `InheritedBy`) ourselves.
16. **`ObjectType.related` holds only one relationship.** The IG example is `{relationshipType: "InheritsFrom", types: [...]}`, a single object, so a type with more than one type-level relationship can't be expressed. OpenAPI types `related` as a free-form object. *Open question:* use an array of `{relationshipType, types}` or a map keyed by relationship type.
17. **`sourceRelationship` value.** The IG table says e.g. `hasChild`, but the registered elementId is `HasChildren`. It is unclear whether this is the elementId or the displayName, and what casing to use. → Use the RelationshipType `elementId` from the perspective of the queried object (e.g. querying a parent returns children with `HasChildren`).
18. **Same pair, two edges.** In the relationships doc, `pump-101-state` is `HasParent: pump-101` in one example and `ComponentOf: pump-101` in another. The IG says the same target may appear once per relationship type in `/objects/related`. → Both edges may coexist, and `parentId` follows `HasParent` only.

**Values and depth**
19. **Nested composition deeper than one level cannot be expressed in OpenAPI.** `CurrentValueResult.components` maps elementId → `VQT`, and `VQT` has no `components`. So `maxDepth` 0 or ≥3 can't represent grandchildren. The IG never says whether deeper levels nest or are flattened into the top-level `components` map. → *Open question.* Likely options: flatten all descendants into one `components` map keyed by elementId, or nest `components` recursively (which violates the published schema).
20. **History + composition.** OpenAPI `HistoricalValueResult` has an untyped `components`. The IG's `/objects/history` section doesn't document `components` at all.
21. **`maxDepth` on register.** The IG says default 1. OpenAPI `RegisterMonitoredItemsRequest.maxDepth` is `integer|null` with no default or minimum, while the value/history requests declare `default=1, minimum=0`.

**Subscriptions**
22. **`sequenceNumber` type.** The IG says 64-bit **unsigned**, yet `lastSequenceNumber = -1` is a defined "clear all" sentinel, and JSON numbers above 2^53 lose precision. OpenAPI just says `integer`. → Accept -1 and keep sequence numbers below 2^53.
23. **`CreateSubscriptionResponse.displayName`** is required in the IG but optional/nullable in OpenAPI.
24. **SSE stream.** OpenAPI declares the 200 response as `application/json` with an empty schema; it should be `text/event-stream`. The IG says each event is a JSON *array* of `{elementId, value, quality, timestamp}`, with no sequence number or event id, so the stream cannot be resumed.
25. **Misc.** OpenAPI `/subscriptions` says "there is no way to list all subscriptions", which is consistent with `/subscriptions/list` taking explicit IDs, but confusingly named. Combining `GET /objects?root=true&typeElementId=…` is undefined.
26. **Conformance suite vs IG on `quality`** (found 2026-11-05). `~/Projects/API/conformance-tests/lib/validators.js` validates quality against the closed set {Good, GoodNoData, Bad, Uncertain}, but the IG types it as a string (#14). Our gateway passes OPC UA status names (`Bad_NotConnected`) by default (switch `quality: base` for strict mode). *Raise with the WG; don't edit that repo.*

## OPC UA Part 5 essentials (spec facts)

Part 5 defines the **standard information model in namespace 0** (`http://opcfoundation.org/UA/`): the types and instances of an empty server. The address-space *meta*-model (NodeClasses, ModellingRule semantics) lives in Part 3. NodeId numbers are in Part 6. Companion specs such as Machinery and DI build on these ns=0 types.

**Type roots**
- `BaseObjectType`: root of all ObjectTypes. `FolderType` is purely organizational. `BaseInterfaceType` is the abstract root of Interfaces (all subtypes are abstract, conventionally named `I…Type`).
- `BaseVariableType` (abstract) has two subtypes. `PropertyType` cannot be subtyped; properties are identified by BrowseName and are simple metadata. `BaseDataVariableType` is the root for DataVariables, which carry process data and may have their own sub-variables.
- Annex A rule of thumb: Properties hold simple, static characteristics. DataVariables hold data, and complex DataVariables expose a Structure value *and* each field as a sub-variable (deliberately redundant).
- Standard types can be extended by adding components but never restricted.

**Standard address space entry points (§8.2)**: `Root` (i=84) → `Objects` (i=85), `Types` (i=86), `Views` (i=87), all `FolderType` linked by `Organizes`. All instance data is reachable hierarchically from `Objects`. `Server` (i=2253) under `Objects` holds server diagnostics and capabilities.

**ModellingRules (§8.4)**: `Mandatory`, `Optional`, `MandatoryPlaceholder`, `OptionalPlaceholder`, `ExposesItsArray`. An InstanceDeclaration without a ModellingRule is not instantiated.

**ReferenceTypes (§11)**, as BrowseName / InverseName (← supertype):
```
References (abstract, symmetric)
├─ HierarchicalReferences / InverseHierarchicalReferences (abstract)
│  ├─ HasChild / ChildOf (abstract)
│  │  ├─ Aggregates / AggregatedBy (abstract)
│  │  │  ├─ HasComponent / ComponentOf
│  │  │  │  ├─ HasOrderedComponent / OrderedComponentOf
│  │  │  │  ├─ HasAddIn / AddInOf
│  │  │  │  ├─ HasStructuredComponent / IsStructuredComponentOf
│  │  │  │  └─ HasArgumentDescription / ArgumentDescriptionOf
│  │  │  └─ HasProperty / PropertyOf
│  │  └─ HasSubtype / SubtypeOf
│  ├─ Organizes / OrganizedBy
│  └─ HasEventSource / EventSourceOf → HasNotifier / NotifierOf
└─ NonHierarchicalReferences (abstract, symmetric)
   ├─ HasTypeDefinition / TypeDefinitionOf
   ├─ HasModellingRule / ModellingRuleOf
   ├─ HasInterface / InterfaceOf
   ├─ HasEncoding / EncodingOf
   ├─ GeneratesEvent / GeneratedBy → AlwaysGeneratesEvent
   ├─ IsDeprecated / Deprecates
   └─ AssociatedWith (symmetric, no inverse)
```
Custom ReferenceTypes in companion specs (e.g. `FromState`/`ToState`, ns=0 from Part 16) subtype these. Always walk the supertype chain rather than matching names.

**DataTypes (§12.2)** (abstract types in *italics*):
- *BaseDataType* → Boolean, String (LocaleId, NormalizedString, DecimalString, DurationString, TimeString, DateString), DateTime (UtcTime), Guid, ByteString (Image*, AudioDataType), XmlElement, NodeId, QualifiedName, LocalizedText
- *Number* → Double (Duration), Float, Decimal, *Integer* (SByte, Int16, Int32, Int64), *UInteger* (Byte, UInt16, UInt32, UInt64)
- *Enumeration* → e.g. NodeClass, IdType
- *Structure* → e.g. Argument, EnumValueType, StructureField, *OptionSet*, *Union*, and companion structs (`EUInformation` is from Part 8)
- ValueRank: −1 scalar, 1 one-dimensional array, n>1 n-dimensional array, 0 one or more dimensions, −2 any, −3 scalar or 1-D

## OPC UA for Machinery: Basic Building Blocks (OPC 40001-1 v1.04.2)

> ℹ️ **Versions:** the local `nodesets/standard/Machinery-Basic-Building-Blocks.NodeSet2.xml` is **v1.04.0** (2025-07-01), and the PDF is **v1.04.2** (2026-11-01). They have not been diffed; the patch delta is assumed harmless. 1.04 references the IA namespace (`http://opcfoundation.org/UA/IA/`, OPC 10000-200) for `3:BasicStacklightType`; IA 1.01.2 is in `nodesets/standard/`.

**Namespaces**: ns0 = UA core. Machinery = `http://opcfoundation.org/UA/Machinery/` (BrowseNames without a prefix). `2:` = DI (`http://opcfoundation.org/UA/DI/`, OPC 10000-100). `3:` = IA. Namespace indexes other than 0 are server-specific.

**Core design idea (§6):** Machinery deliberately defines **no MachineryItem/Machine ObjectType**. The machine's type comes from a domain companion spec (Robotics, Machine Tools, …) or the vendor. Machinery provides **building blocks attached as AddIns** (`HasAddIn`, a subtype of `HasComponent`), each with a `DefaultInstanceBrowseName`. Recommended organization: each MachineryItem has a `MachineryBuildingBlocks` folder (FolderType, HasComponent) that `HasAddIn`-references its building blocks. Identification and Components are *also* referenced directly from the machine, and Monitoring, Equipment, Notifications, and OperationCounters are recommended as direct top-level entry points too. **§7.3 says to keep one node reachable via several references, not duplicate it.** So the same Identification node hangs off both the machine and its MachineryBuildingBlocks folder.

**Entry point (§9):** the `Machines` folder (ns=Machinery;i=1001), `Organizes`-ed from `0:Objects`. It `Organizes` every Machine in the server, and each Machine MUST have an `2:Identification` AddIn of `MachineIdentificationType`. Clients should access it by NodeId, not by path. A machine that contains another machine references the inner one from both `Machines` and its own `Components`.

**Building blocks**, as Type (default BrowseName) and what it holds:
| § | Type | Default name | Contents / notes |
|---|---|---|---|
| 8 | `MachineIdentificationType` ← `MachineryItemIdentificationType` (abstract) ← `2:FunctionalGroupType` | `2:Identification` | All Properties. Mandatory: `2:Manufacturer` (LocalizedText), `2:SerialNumber`, `2:ProductInstanceUri` (globally unique, ≤255 chars, `<ManufacturerUri>/<…>`, never changes). Optional RO: `2:ManufacturerUri`, `2:Model`, `2:ProductCode`, `2:HardwareRevision`, `2:SoftwareRevision`, `2:DeviceClass`, `YearOfConstruction` (UInt16), `MonthOfConstruction` (Byte), `InitialOperationDate`. Optional **RW** (user-set): `2:AssetId`, `2:ComponentName`, `Location`. Interfaces `IMachineVendorNameplateType` (← `IMachineryItemVendorNameplateType` ← `2:IVendorNameplateType`) and `IMachineTagNameplateType` (← `2:ITagNameplateType`). |
| 10 | `MachineryComponentIdentificationType` | `2:Identification` | Same as above for components, plus `2:DeviceRevision`. `ProductInstanceUri` is optional (only if the component maker provides one). |
| 11 | `MachineComponentsType` | `Components` | `<Component>` OptionalPlaceholder (`HasComponent`, BaseObjectType), each with a mandatory `2:Identification` (MachineryItemIdentificationType). Lists *identifiable* components, which may be organized elsewhere too. |
| 12 | `MachineryItemState_StateMachineType` ← `0:FiniteStateMachineType` (Part 16) | `MachineryItemState` | States (StateNumber): NotAvailable 0, OutOfService 1, NotExecuting 2, Executing 3. All 16 transitions are defined, there is no initial state, and states/transitions exist **only on the type** (no ModellingRule). The instance value is `CurrentState` (LocalizedText, with `Id`/`Number` sub-variables). If the server loses the machine connection, it should report Bad StatusCode, not NotAvailable. |
| 13 | `MachineryOperationModeStateMachineType` | `MachineryOperationMode` | States: None 0, Maintenance 1, Setup 2, Processing 3. Same structure as §12. May be set by an external source (MES/operator). |
| 14 | `MachineryOperationCounterType` ← `2:FunctionalGroupType`, implements `2:IOperationCounterType` | `2:OperationCounters` | Optional Properties: `2:PowerOnDuration`, `2:OperationDuration` (Duration = ms as Double, monotonic, never reset), and `2:OperationCycleCounter` (UInteger). |
| 15 | `MachineryLifetimeCounterType` ← FolderType | `LifetimeCounters` | `<LifetimeVariable>` MandatoryPlaceholder (HasComponent, `2:LifetimeVariableType`, Number) with `0:EngineeringUnits` (M), `2:StartValue` (M), `2:LimitValue` (M), plus optional `2:WarningValues` and `2:Indication`. The same variable may also be referenced from elsewhere. |
| 16 | `MonitoringType` ← FolderType *(1.04+)* | `Monitoring` | Optional folders `Status`, `Health`, `Process`, `Consumption`. `Status` SHALL reference the MachineryItemState / MachineryOperationMode (when present) and may hold `Stacklight` (`3:BasicStacklightType`). `Health` implements `2:IDeviceHealthType` (`2:DeviceHealth` enum, `2:DeviceHealthAlarms`). Annex B.4: components may have their own Monitoring, or the machine's Monitoring may reference component nodes, so clients must handle both. |
| 17 | `MachineryEquipmentFolderType` ← FolderType; `IMachineryEquipmentType` ← `IMachineTagNameplateType` *(1.04+)* | `MachineryEquipment` | `<MachineryEquipment>` OptionalPlaceholder (tools, fixtures, …) implementing `IMachineryEquipmentType` (`MachineryEquipmentTypeId` M/RW, `Description`, `EquipmentLife` lifetime var) and `2:IVendorNameplateType`. |
| 18 | `NotificationsType` ← FolderType *(1.04+)* | `Notifications` | Entry point for notifications, either as Objects or as Events (`GeneratesEvent`). Defines no event types itself. |

**Machinery-specific rules worth remembering:** language-neutral LocalizedText uses an empty locale (§7.1). Optional read-only nodes with no data SHALL be omitted, not left empty (§7.2). For components, vendors must not invent a `ProductInstanceUri`; clients can combine the machine's ProductInstanceUri with the component NodeId. `ComponentName` is for end users only; vendors name components via BrowseName/DisplayName.

**Conformance units (§19)**: Machine Identification (+Writable), Find Machines, Component Identification (+Mandatory, +Writable), Find Components, Building Block Organization, MachineryItem State, Operation Mode, Operation Counter, Lifetime Counter, Monitoring, MachineryEquipment, Notifications.

**Annex C (KPIs):** ISO 22400-2 time elements (ADET, ADOT, APMT, …) and SEMI E10 times are derived from the combination of MachineryItemState × MachineryOperationMode × MES/ERP condition state. This is a strong use case for i3X history queries over these two state values.

### What the local 1.04.0 NodeSet contains
Model v1.04.0, which requires UA 1.05.02, DI 1.04.0, and IA 1.01.2. It has 15 ObjectTypes: `MachineryItemState_StateMachineType` i=1002, `IMachineryItemVendorNameplateType` 1003, `MachineryItemIdentificationType` 1004, `MachineryComponentIdentificationType` 1005, `MachineComponentsType` 1006, `IMachineryEquipmentType` 1007, `MachineryOperationModeStateMachineType` 1008, `MachineryOperationCounterType` 1009, `IMachineVendorNameplateType` 1010, `IMachineTagNameplateType` 1011, `MachineIdentificationType` 1012, `MachineryEquipmentFolderType` 1013, `MonitoringType` 1014, `MachineryLifetimeCounterType` 1015, and `NotificationsType` 1017. It also has the `Machines` Object (i=1001), 53 Objects in total, and 112 Variables, with no DataTypes or ReferenceTypes of its own. References used: HasProperty (214), HasTypeDefinition, HasComponent (111), HasModellingRule, FromState/ToState (state-machine transitions), HasSubtype, HasInterface, HasAddIn, Organizes. Loading it requires the ns=0, DI, and IA NodeSets as well.

### Machinery → i3X considerations (design guidance, not spec text)
- **Root**: expose `Machines` as the i3X root (or its sole child of a synthetic root) so machines are `HasChildren` of it. That matches i3X's "browse from root" model better than the full `Objects` tree.
- **Machine type**: a Machine's `typeElementId` is its domain or vendor type, not a Machinery type. Machinery types show up as the types of the AddIn child objects. If the source type is unknown or `BaseObjectType`, use `UnknownType` or a generic type.
- **AddIns → composition**: `HasAddIn` (a `HasComponent` subtype) → i3X `HasComponent`/`ComponentOf`, so the machine has `isComposition: true`. Identification, OperationCounters, MachineryItemState, and so on become component objects whose values are JSON objects of their Properties. A machine read with `maxDepth: 0` then returns nameplate + state + counters in one call.
- **Multi-path nodes are the main impedance mismatch.** OPC UA intentionally reaches one node via several references (machine→Identification *and* MachineryBuildingBlocks→Identification; Machines *and* Components for nested machines; Monitoring/Status→MachineryItemState). i3X allows a single `parentId`. Proposal: pick a canonical parent (the MachineryItem's direct AddIn / HasComponent, otherwise the first hierarchical path), and record the rest as graph relationships, or collapse `MachineryBuildingBlocks` entirely since it only duplicates. Never duplicate the node, matching §7.3.
- **State machines**: map each StateMachine instance to a leaf-ish object whose value is e.g. `{ "state": "Executing", "stateNumber": 3 }` (from `CurrentState` + `CurrentState/Number`, or `Id` resolved to the state's StateNumber). Build the type schema `enum`s from the StateNumber tables above. Do **not** expose the 4 State and 16 Transition objects as instance nodes; they are type-only. A Bad StatusCode on CurrentState → i3X quality `Bad`.
- **Identification RW properties** (`AssetId`, `ComponentName`, `Location`, `MachineryEquipmentTypeId`) are the natural candidates for `PUT /objects/value`. But i3X writes replace the whole value, so a write to Identification must leave the RO fields unchanged or reject changes to them.
- **Durations** (PowerOnDuration, OperationDuration) are ms → unit "C26" (UNECE millisecond). Lifetime variables carry their own `EngineeringUnits`. Where units go is unresolved (discrepancy #12). StartValue/LimitValue/WarningValues go in the object value.
- **Placeholders** (`<Component>`, `<LifetimeVariable>`, `<MachineryEquipment>`) → variable sets of child objects, not fixed schema properties.
- **Notifications/Events**: i3X 1.0 has no event or alarm model. Notifications-as-Objects can map normally; Events are out of scope unless surfaced as values.

## PMMI / PackML example (user-supplied, reviewed 2026-11-05)

A PMMI working model that puts PackML data onto Machinery building blocks. It is a **worked example and test case** for the types → JSON Schema mapping (agenda item 4), not a normative source.

**Diagram (`Information Model - PMMI 01Jun.pdf`)**: Identification (`MachineIdentificationType`); Monitoring with Consumption (MainMeasurementValues per medium), Health (DI DeviceHealth + FaultCode/FaultReason = PackML `StopReason.Id`/`.Message`), Process (GoodCount, RejectCount, MachSpeed, CurMachSpeed, CycleTime, Parameter[]), and Status (state, mode, Stacklight); Equipment; Notifications; MachineryBuildingBlocks (Lifetime/Operation counters); Job Management (ISA-95 JobOrderControl/JobOrderResults). It says all DateTimes are ISO 8601 strings.

**NodeSet (`PMMI PackML MBB Example 601.xml`)**: namespace indexes are 1 PMMI, 2 DI, 3 Machinery, 4 PackML, 5 ProcessValues, 6 PADIM. It contains **types only, with no instances** (no `Machines` folder):
- ObjectTypes: `PmmiMachine` i=1000 (with `Identification` and `Monitoring`), `PmmiHealth` 1002, `PmmiProcess` 1003, `PmmiStatus` 1004. All subtype `BaseObjectType`.
- Enum DataTypes: `PmmiOperationMode` i=3000 (None 0, Production 1, Maintenance 2, Manual 3, ChangeOver 4, Clean 5, SetUp 6, EmptyOut 7, OemSpecific1–3 8–10) and `PmmiMachineState` i=3001 (the 18 PackML states, 0–17).
- External types used: PackML `PackMLCountDataType` (ID, Name, Unit: EUInformation, Count, AccCount) and `PackMLAlarmDataType` (ID, Value, Message, Category, DateTime, …); PackML ReferenceType `HasStopReason`; ProcessValues for `Speed`/`ProcessValueSetpoint` (abstract `Number`, ValueRank −2).
- Not implemented from the diagram: Equipment, Notifications, building blocks and counters, Consumption, Stacklight, Job Management, Process Parameter[].

**PackML NodeSet facts**: 6 ObjectTypes (`PackMLBaseObjectType`, `PackMLAdminObjectType`, `PackMLStatusObjectType`, `PackMLBaseStateMachineType`, `PackMLMachineStateMachineType`, `PackMLExecuteStateMachineType`), 7 DataTypes, 5 ReferenceTypes. `HasStopReason`, `HasAlarm`, `HasAlarmHistory`, `HasInterlock`, and `HasWarning` all **subtype `HasComponent`**, so they map to i3X composition, not graph edges.

**Local NodeSets**: see the `nodesets/standard/` row in the reference table. Every structural reference resolves, including all of PMMI's. The one gap: `IRDI-Dictionary` is 1.00 (51 entries), but PADIM 1.01.0 requires IRDI 1.01.0, so 178 of PADIM's 329 `HasDictionaryEntry` references (80 distinct; 4 are the literal template placeholder `<DictionaryEntryName>`) don't resolve. These are semantic links only, so they don't block the type mapping.

**Resolved PMMI cross-references:** `Speed` is a ProcessValues `ProcessValueType`, and `ProcessValueSetpoint` is a `ProcessValueSetpointVariableType`. The odd links are type-level nodes shared directly rather than copied: `Speed` → `2:AnalogSignal` (ProcessValues, owned by `ProcessValueType`); `ProcessValueSetpoint` → `EngineeringUnits`/`EURange` (owned by `ProcessValueType`'s `ProcessValueSetpoint`); and `Speed` → PADIM `3:SignalTag` (owned by PADIM `SignalType`). So the units do exist for `Speed`, but only through those shared type nodes.

## OPC UA → i3X mapping notes (our design guidance, not spec text)
- **Namespaces**: one i3X Namespace per OPC UA NamespaceUri (`http://opcfoundation.org/UA/`, `.../DI/`, `.../Machinery/`). Add `?projection=i3X` wherever the projection is lossy, which is likely all of them.
- **Ids**: `sourceTypeId` / `metadata.sourceTypeId` = OPC UA type NodeId (prefer the URI-qualified `nsu=…;i=1012` form, since namespace indexes are server-local) or BrowseName. ElementIds must be persistent, so derive them from `nsu` + identifier, not from `ns=` index.
- **`metadata.system`**: store `nodeId`, `nodeClass`, `browseName`, etc. here. Clients must not depend on it.
- **Types**: ObjectTypes → i3X ObjectTypes with JSON Schema. Use `HasSubtype` for `InheritsFrom` and `allOf`. `HasInterface` → also `allOf` the interface's schema (interfaces are abstract `BaseInterfaceType` subtypes), or record a graph relationship. ModellingRule `Mandatory` → JSON Schema `required`, and `Optional` → not required. `*Placeholder` → variable-count children (`additionalProperties`/`patternProperties`, or separate composition children). Abstract types can still be served, but no instance points at them directly.
- **Hierarchy vs composition**: `Organizes` (and folder membership) → i3X `HasChildren`/`HasParent`. `HasComponent` to Objects (incl. `HasAddIn`, `HasOrderedComponent`) → i3X `HasComponent`/`ComponentOf` with `isComposition: true` on the parent. Choose one i3X parent per node (`parentId`); additional hierarchical paths to the same node become graph relationships.
- **Variables**: `HasProperty` targets → attributes in the owning object's JSON value (static-ish metadata). `HasComponent` DataVariables → either attributes of the parent value or leaf i3X objects with a scalar schema, which makes them individually subscribable. Pick one strategy per type and keep `isComposition` consistent. Variables with sub-variables are Annex A's "complex variables": structure value plus component children.
- **Graph**: every other non-hierarchical ReferenceType becomes an i3X RelationshipType with `reverseOf` = the OPC UA InverseName, registered as its own type. Symmetric types (e.g. `AssociatedWith`) are their own reverse. Drop type-system plumbing (HasTypeDefinition → `typeElementId`, HasModellingRule → schema, HasEncoding) instead of exposing it as edges.
- **DataTypes → JSON Schema**: Boolean → boolean. Integer types → integer with min/max (Int64/UInt64 risk precision loss in JSON; decide whether to emit them as strings). Float/Double/Decimal/Duration → number. String and its subtypes → string. DateTime/UtcTime → string `format: date-time` (UTC `Z`). Guid → string `format: uuid`. ByteString → base64 string (`contentEncoding: base64`). NodeId → string. QualifiedName → string (`nsu;Name` or `Name`). LocalizedText → string (the `text` part; locale in metadata). Enumeration → integer with `enum`, or string names (pick one and document it). Structure → object built from StructureDefinition fields. OptionSet → integer bitmask or object of booleans. ValueRank ≥ 0 → `type: array` (nested for n dims). Abstract `BaseDataType`/`Number` → union / `{}`.
- **Units**: `EngineeringUnits` Property (EUInformation, Part 8) → UNECE Rec 20 code (EUInformation `UnitId` encodes CommonCode). i3X has no normative unit field (discrepancy #12), so for now put it in `metadata.system.engUnit`.
- **Values**: OPC UA StatusCode → quality: pass the StatusCode symbolic name through (`Good`, `Uncertain_LastUsableValue`, `Bad_NotConnected`, …). Bad* → value null; not yet sampled → `GoodNoData`. Prefer SourceTimestamp, falling back to ServerTimestamp, converted to UTC `Z`.
- **Roots**: i3X `GET /objects?root=true` ≈ children of OPC UA `Objects` (i=85). Consider excluding or hiding the `Server` diagnostics object.
- **State machines** (`FromState`/`ToState`, `MachineryItemState_StateMachineType`): the current state (`CurrentState` LocalizedText + `Id`) is the useful value. Transitions are type-level structure and probably shouldn't become instance graph edges.
