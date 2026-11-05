# "UNS-style" i3X server (third comparison point)

*First swag, 2026-11-05. Meant to be shaped with the user into a realistic stand-in for how the UNS community would do this.*

**The persona:** an integrator who knows MQTT/UNS and JSON well and knows OPC UA only as "the server I pull tags from". They build an i3X endpoint by **hand-authoring an asset model** and pointing a **polling connector** at the plant's OPC UA server. They don't use OPC UA types, references, companion specs, or anything derived from the address space.

```
node --import tsx uns/src/main.ts        # or ./start.sh: it's the `uns` entry in compare/gateways.yaml
http://localhost:8083/v1                 # front door: http://localhost:8080/uns/v1
```

## What it is

- `model.yaml` holds everything:
  - the company namespace and hand-written JSON Schema types;
  - the asset tree (topic-style ids);
  - per-asset tag maps (OPC UA paths picked from UaExpert);
  - graph relationships.
- `src/main.ts` is a single file: it builds the model, polls about 200 tags every second, publishes changes, and serves i3X 1.0.
- **Conformance: 1.0 Compatible (52 passed, 0 failed).** Writes and history aren't supported, and say so honestly.

## Deliberately naive choices (where to shape it)

| Area | What it does | Contrast with cesmii / i3x2ua |
|---|---|---|
| Tree | `demobev/plant1/<area>/<asset>`: enterprise → site → area/line → asset. No ISA-95 levels, no `Machines`, `EquipmentClasses`, `PackMLObjects`, DI folders, ports or `MachineryBuildingBlocks` | Both OPC UA gateways expose the whole address-space structure |
| Size | **49 objects**: 34 assets/areas + 18 nameplates | cesmii 855, i3x2ua 5,621 |
| ElementIds | Readable topic paths: `demobev/plant1/line1/filler` | NodeId strings / SHA1 hashes |
| Types | 17 company types in `https://demo-beverage.example/uns` (`Tank`, `Pump`, `MixingTank`, one `PackagingMachine` for all five machines); `sourceTypeId` = the type name; no inheritance | OPC UA types (PackML, Pumps, ISA-95, PA-DIM …) with provenance |
| Values | **One flat JSON payload per asset** with unit-suffixed keys (`level_m`, `temperature_c`, `speed_rpm`); instruments and valves are fields of their asset, not objects | Instruments are objects; values are per variable |
| Units | In the key name only (`_m3h`, `_bar`, `_pct`) | EngineeringUnits metadata (cesmii) or component objects (i3x2ua) |
| Mixed units | `Tank` has both `level_m` (T-101/T-102) and `level_pct` (T-301), because the instruments differ | — |
| Derived values | Computed in the connector: `brix` (from density), blend `ratio`, `co2_volumes`, `running` (from speed or state) | Not computed |
| State | PackML state as text (`"Execute"`, falling back to the machine state when not running); `mode` from a hand-written enum map; Machinery state machines ignored | Full state-machine objects |
| Counters | `good_count` / `reject_count` lifted out of `PackMLCountDataType[0].Count` | Whole PackML structures |
| Composition | Only `<asset>/nameplate` (manufacturer, model, serial, year) | Deep composition (cesmii) or hierarchy (i3x2ua) |
| Graph | `Feeds`/`FedBy` (process flow, asset to asset, hand-listed) and `Supplies`/`SuppliedBy` (CO₂ → carbonator, air → packaging machines) | cesmii synthesizes FlowsTo from ports; i3x2ua has none |
| Timestamps | **When the connector saw the change** (poll time), not the source timestamp | Source timestamps |
| Quality | Per asset: `Good`, `Uncertain` (some tags unreadable: those fields are simply omitted) or `Bad` (none readable) | Per variable, with OPC UA status detail (cesmii) |
| History | None (`capabilities.query.history = false`; the endpoint returns `GoodNoData`) | OPC UA HistoryRead |
| Subscriptions | Change-based publishing at the poll rate (1 s); sync and SSE | MonitoredItems / polling |
| Writes | Not supported (501) | cesmii: nameplate fields; i3x2ua: optional |
| Self-description | Type `description` only; no provenance or fidelity notes; the OPC UA tag map isn't published | `metadata.opcua` (cesmii) |

## Ideas for shaping (not done)

- **Sparkplug-style per-metric leaves** (`…/filler/speed`) alongside or instead of the asset payloads.
- **Per-field quality** or `{value, unit, ts}` objects per metric (another common UNS payload shape).
- **More typical UNS sloppiness:**
  - inconsistent naming across areas;
  - state codes as numbers on some machines and text on others;
  - a "Metrics"/"OEE" object computed at the line level.
- **An MQTT broker in the middle** (connector → broker → i3X), so the i3X server truly only knows the UNS, not OPC UA.
