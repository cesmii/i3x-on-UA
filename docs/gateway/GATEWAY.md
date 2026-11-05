# Gateway "cesmii": build notes

*Phase 4 built 2026-11-05. The interpretation is in `MAPPING.md`; this note covers running it, its structure, and results.*

## Run

```
npm start -w server                      # OPC UA server + simulation (opc.tcp://localhost:4840/UA/BeverageFactory)
npm start -w gateway                     # i3X at http://localhost:8081/v1
I3X_ENUMS=name I3X_INT64=number npm start -w gateway      # flip interpretation switches via env
GATEWAY_CONFIG=/path/to/other.yaml npm start -w gateway   # or a whole alternative config
```

**Config:** `gateway/gateway.config.yaml`.
- Every interpretation switch can be overridden as `I3X_<SNAKE_CASE_KEY>` (e.g. `I3X_TYPE_IDS=nsu`, `I3X_SCHEMA_INHERITANCE=allOf`, `I3X_SYNTHESIZE_FLOW=false`).
- The endpoint, port and base path use `OPCUA_ENDPOINT`, `GATEWAY_PORT` and `GATEWAY_BASE_PATH`.
- The gateway serves plain HTTP; Nginx adds TLS and auth (D8).

## Structure

| File | Role |
|---|---|
| `src/ua/crawl.ts` | Generic OPC UA crawl, Browse/Read only: instance tree from `Objects`, ObjectTypes/VariableTypes (with members, modelling rules, interfaces, supertypes), ReferenceTypes, DataTypes (DataTypeDefinition, or EnumStrings/EnumValues), namespace metadata |
| `src/i3x/project.ts` | MAPPING.md as code: Object set, reference classification, parent choice, edges, ObjectTypes and leaf types, metadata.opcua/fidelity, namespaces |
| `src/i3x/schema.ts` | DataType + ValueRank → JSON Schema |
| `src/profiles/ports.ts` | Opt-in companion-spec profile: Pumps ports + DI ConnectsTo → FlowsTo/FedBy |
| `src/http/server.ts` | i3X envelopes, bulk responses, 400/404/206/501, gzip, all endpoints |
| `src/i3x/values.ts` | Variant → JSON, quality, branch/leaf values, flattened components, history, all-or-nothing writes |
| `src/i3x/subs.ts` | Subscriptions on OPC UA MonitoredItems: register with depth, sync batches/acks/overflow, SSE stream, TTL |
| `src/config.ts`, `src/main.ts` | config + env overrides; connect (auto-reconnect), crawl, project, serve |

## Phase 4 results (against the Line 1 server)

**Speed:** crawl 0.25 s (1,861 OPC UA nodes, 176 types) and projection 0.04 s. *Corrected 2026-11-05: the first Phase 4 run reported 4,669 nodes and 1,356 Objects because it still followed node-opcua's historian configuration (≈10 nodes under each of ≈280 historized variables) before that was made plumbing.*

**What gets projected:**
- 855 i3X Objects (400 from Objects, 455 leaf Variables), 97 ObjectTypes, 15 RelationshipTypes, 3,542 edges.
- 23 synthesized FlowsTo links (one per pipe in `line1.yaml`).
- Roots: `DeviceSet`, `NetworkSet`, `DeviceTopology` (DI), `Machines` (Machinery), `PackMLObjects` (PackML), `Demo Beverage Co.`, `EquipmentClasses`. Each is a real node the loaded specs place under `Objects`.

**Spot checks:**
- `FL-401`: parent is `Bottling Line 1`, not `Machines` (the folder rule). It has 8 composition children, `FedBy` T-301, and a `multiPath` note for `Machines`. Its 4 PackML methods are listed as dropped.
- `FL-401/Identification`: parent is the machine. The `MachineryBuildingBlocks` path is kept as `UA:AddInOf`.
- `LT-101/…/AnalogSignal`: leaf type `PADIM:LevelMeasurementVariableType[Double]`. `metadata.opcua.properties` carries the EngineeringUnits `MTR`/m and EURange 0–5.
- `ISA95:EquipmentType`: its schema carries `EquipmentLevel` as an enum (`oneOf` const/title).

**Payloads:** `GET /objects?includeMetadata=true` is 1.27 MB raw, 50 KB gzipped, served in 17 ms.

**i3X conformance suite** (`~/Projects/API/conformance-tests`, `node bin/i3x-test.js run http://localhost:8081/v1`):
- **All CORE (01–04) and EXP (01–22) tests pass.**
- The 10 failures are all Phase 5 endpoints (value, history, subscriptions), which currently return 501.
- The 2 advisory warnings (plain HTTP, no auth) are expected until Nginx is in front.

## Interpretation refinements found while building

1. `HasHistoricalConfiguration` (node-opcua's historian config objects) showed up as 15 bogus roots. It's now plumbing and never crawled.
2. ISA-95 `EquipmentLevel` (a PropertyType variable under `HasISA95Attribute`, a HasComponent subtype) became a separate leaf Object under the reference-only rule. **Our rule is now:** a PropertyType-typed Variable is an attribute too (MAPPING §1).
3. PA-DIM/ProcessValues signals declare ValueRank −2, which gave `anyOf[number, array]` leaf schemas that clients can't recognize as points. **Our rule is now:** a ValueRank −2/−3 leaf is projected as a scalar, with a fidelity note (MAPPING §5).

## Phase 5 results (2026-11-05)

**i3X conformance suite: 55 passed, 0 failed, 3 skipped. Verdict "1.0 Compatible": all MUST behaviour passes.** It's "Compatible" rather than "Full" only because historical writes (a MAY) are declared unsupported.
- **Skips:** UPD-04 (historical writes, not declared), SUB-12 (only applies when streaming is *not* declared), and SUB-13 ("untestable": the suite happened to sample static objects).
- **SUB-13 by hand:** `-1` clears all batches and pending updates.

**Hand-tested against the live plant:**
- **Values:** `FL-401` with maxDepth 0 returns 40 components (speeds, `PackMLCountDataType[]`, StopReason, nested PackML states, Machinery state, nameplate). Leaves are bare numbers; branches are their Properties (`T-101` → `{EquipmentLevel: 9}`).
- **History:** about 300 values per 5 min per signal.
- **Sync:** batch 1 is re-sent until acknowledged, acknowledging 1 leaves batch 2, `-1` clears everything, and a wrong clientId gets 404.
- **SSE:** live updates arrive about once a second.
- **Writes:**
  - A measurement → 403 `BadNotWritable`.
  - A nameplate `Location` change → 200, reads back.
  - A write that also changes the read-only `SerialNumber` → 403, and **nothing** is written.
- **Quality mapping** (`src/tools/quality-check.ts`): `BadNotConnected` → `Bad_NotConnected` (detailed) / `Bad` (base); `GoodNoData` stays as it is; a null with Good becomes `GoodNoData`.

**Model fix found by the gateway:** node-opcua instantiates Variables read/write, so the gateway could "write" a level measurement. The generator now makes every plant Variable `CurrentRead` only, except the Machinery nameplate fields the spec defines as user-writable (`AssetId`, `ComponentName`, `Location`): 63 writable, 1,396 read-only. UaExpert sees the same.

**Open issue to raise:** the conformance suite treats `quality` as the closed set {Good, GoodNoData, Bad, Uncertain} (`lib/validators.js` `QUALITIES`). That conflicts with our reading that quality is an open string carrying OPC UA status names (MAPPING §7). Use `I3X_QUALITY=base` to pass the suite with faults injected.

## Fixes from the side-by-side comparison (2026-11-05)

- An `Uncertain` status returned `null`/`GoodNoData`. node-opcua's `StatusCode.isGoodish()` excludes Uncertain, so only Bad severity (bit 31) now drops the value. Found by comparing with i3x2ua (`COMPARISON.md` F2); conformance still 55/0.

## Next

- **Gateway switch (D9): done.** See `compare/README.md`; cesmii and i3x2ua both pass as "1.0 Compatible" against the plant.
- **Next:** the WG comparison of the two interpretations, then Phase 6 (fidelity audit).
