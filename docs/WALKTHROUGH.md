# Walkthrough: find it in all four views

*Phase 6, 2026-11-05. A guided compare for the WG: follow the syrup to the bottle and find each thing in the OPC UA model (UaExpert) and in the three i3X interpretations (i3X Explorer). Values below were observed live on Line 1; counts and readings will move.*

| View | Connect to | What it is |
|---|---|---|
| **UA** | UaExpert → `opc.tcp://localhost:4840/UA/BeverageFactory` (security None) | The standards-based model (Machinery, PackML, PA-DIM, Pumps, ISA-95, Acme) |
| **cesmii** | Explorer → `http://localhost:8080/cesmii/v1` | Our gateway: generic, with fidelity notes in `metadata.opcua` (`docs/gateway/MAPPING.md`) |
| **i3x2ua** | Explorer → `http://localhost:8080/i3x2ua/v1` | Andreas Heine's gateway, run with its defaults |
| **uns** | Explorer → `http://localhost:8080/uns/v1` | A naive, hand-authored UNS-style model (`uns/README.md`) |

Start everything with `./start.sh`.

**Element ids:**
- **cesmii:** the OPC UA ExpandedNodeId. Below, `FL-401` means `nsu=https://cesmii.net/i3x-demo/BeverageFactory/;s=FL-401`.
- **i3x2ua:** `<kind>-SHA1(cesmii id)[:16]`. Both forms are given below.
- **uns:** a topic path.

`COMPARISON.md` row numbers (e.g. **C4**) point to the cesmii vs i3x2ua details.

---

### 1. Where does the plant start?
- **UA:** `Objects` has 7 model children, among them `Demo Beverage Co.` (ISA-95), `Machines` (Machinery), `DeviceSet` (DI/PA-DIM) and `PackMLObjects`, plus `Server`.
- **cesmii:** 7 roots, the same children; `Server`, `Aliases` and `Locations` are left out. *Where it's said:* the UA namespace's `notProjected` note names them.
- **i3x2ua:** one root, `Objects` (**A4**).
- **uns:** one root, `demobev` ("Demo Beverage Co."). There are no Machines, DeviceSet or PackMLObjects folders: they're OPC UA organization, not plant.
- *WG question:* should a gateway expose the companion specs' entry-point folders as roots?

### 2. The filler
- **UA:** `Objects › Demo Beverage Co. › Plant 1 › Bottling Line 1 › FL-401`, and also `Objects › Machines › FL-401`: one node, two paths (Machinery §7.3).
- **cesmii:** `FL-401`, parent `Bottling Line 1`.
  - Fidelity `parent / multiPath`: "Also reached from Machines (UA:Organizes)…".
  - `Machines` is kept as a `UA:OrganizedBy` graph edge.
  - Type `PackML:PackMLBaseObjectType`; value `{PackMLVersion, TagID}`.
- **i3x2ua:** `asset-02f12ced378a0243`, parent `Bottling Line 1`, value `null / GoodNoData`: the data is in the child objects (**C4**, **E1**).
- **uns:** `demobev/plant1/line1/filler`, type `PackagingMachine`. **One flat payload has the whole machine:**
  - `{state: "Execute", mode: "Production", speed: 360, speed_setpoint: 400, good_count: 246, reject_count: 0, …, running: true}`
  - Getting the same picture from the other two takes a `maxDepth: 0` read of 40 components (cesmii, **C2**) or a browse (i3x2ua).
- *WG question:* is "the machine's value" its own Properties, its whole composition, or a curated summary?

### 3. Its nameplate
- **UA:** `FL-401 › Identification` (`MachineIdentificationType`, all Properties). It's also reachable via `MachineryBuildingBlocks`.
- **cesmii:** `FL-401/Identification`.
  - Its value is the Properties as one object: `{AssetId, ComponentName, Manufacturer, SerialNumber, YearOfConstruction, …}`.
  - `writableProperties: [AssetId, ComponentName, Location]`, from the OPC UA access level.
  - Fidelity `parent / multiPath` (MachineryBuildingBlocks).
- **i3x2ua:** `asset-10e3ae624c1f5828`, value `null`; each Property is its own `property-…` object (**B2**).
- **uns:** `demobev/plant1/line1/filler/nameplate` has four fields (`manufacturer, model, serial_number, year_built`), all read-only. Machinery's 15 optional fields, `ProductInstanceUri` and the writable ones are gone, and nothing says so.

### 4. What state is it in?
- **UA:**
  - `FL-401 › BaseStateMachine › MachineState › CurrentState` = `Running` (LocalizedText);
  - nested `ExecuteState`;
  - Machinery's `MachineryItemState` and `MachineryOperationMode` alongside, referenced from `Monitoring/Status`.
- **cesmii:** `FL-401/BaseStateMachine/MachineState/CurrentState` = `"Running"`.
  - `metadata.opcua.properties.Id` = the state's NodeId.
  - *Where it's said:* the locale loss is in the namespace's `localizedText` note; the state machine's States and Transitions are type-only (the **T** `typeOnly` note on the state-machine types).
- **i3x2ua:** `property-f7d6f417741fcb8b` = `{"Locale": null, "Text": "Running"}` (**E2**).
- **uns:** `state: "Execute"`.
  - The connector reads the *Execute substate* and falls back to the machine state, so the two levels of PackML's nested state machine are collapsed into one string.
  - `mode` comes from a hand-written enum map, and Machinery's state machines are ignored.
- *WG question:* the same "state" is three different strings here. Does i3X need a convention for state values?

### 5. How many bottles?
- **UA:** `FL-401 › Admin › ProdProcessedCount` (array of `PackMLCountDataType`).
- **cesmii:** `FL-401/Admin/ProdProcessedCount` = `[{ID: 1, Name: "bottles", Unit: {…, DisplayName: "pce"}, Count: 246, AccCount: 246}]`. These are the DataTypeDefinition field names; nested LocalizedText is shown as its text.
- **i3x2ua:** `property-4c0df623cc100927`: the same fields, but nested LocalizedText as objects (**E5**).
- **uns:** `good_count: 246`. Only `Count` of the first array element is lifted out; the ID, unit and accumulated count are dropped silently.

### 6. Can I tell it to change speed?
- **UA:** `FL-401` has the Methods `SetMachSpeed`, `SetParameter`, `SetProduct` and `SetUnitMode`.
- **cesmii:** `metadata.opcua.methods` lists them, with fidelity `methods / dropped` ("Not callable through i3X 1.0"). `PackML:PackMLBaseObjectType` has the same note.
- **i3x2ua:** `action-…` children of type `UnknownType` (**B3**).
- **uns:** no trace.

### 7. A level reading and its units
- **UA:** `Objects › Demo Beverage Co. › Plant 1 › Water Treatment › T-101 › LT-101 › SignalSet › Level › AnalogSignal`. LT-101 is also under `DeviceSet` (PA-DIM). The reading's Properties are `EngineeringUnits` (m) and `EURange` (0–5).
- **cesmii:** `LT-101/SignalSet/Level/AnalogSignal` = `3.0018`.
  - `metadata.opcua.properties` = `{EngineeringUnits: {code: "MTR", symbol: "m", name: "metre"}, EURange: {low: 0, high: 5}}`.
  - Fidelity `variableProperties / flattened`, and `valueRank / approximated` (declared ValueRank Any, projected as a scalar).
  - `historizing: true`.
- **i3x2ua:** `property-d29c286cfc613d1a` = `3.0018`, with `isComposition: true`: the units are component objects (**E7**).
- **uns:** `demobev/plant1/water-treatment/raw-water-tank` → `level_m: 2.99`. The unit is in the key name only.
  - The same `Tank` type has `level_pct` for T-301, because that instrument is configured differently.
- *WG question:* this is discrepancy #12: i3X has no home for engineering units. Three views, three answers.

### 8. Big integers
- **UA:** `SD-201 › Component › Drive › FaultCount` (Int64).
- **cesmii:** `"0"`, a decimal string. *Where it's said:* the `int64` note on its type `UA:BaseDataVariableType[Int64]` (switch `int64: number`).
- **i3x2ua:** `property-e04bf7daa0226f22` = `0` (**E4**).
- **uns:** not mapped.

### 9. Where does the product flow?
- **UA:** there is no "flows to" reference. Pumps ports (`T-101 › Ports › WaterOut`) are joined by DI `ConnectsTo`, and the direction is in each port's `Direction` Property (our convention P1-b).
- **cesmii:**
  - `DI:ConnectsTo` edges between the ports. The **R** `semantics` note says this is topology, not containment.
  - Synthesized `FlowsTo`/`FedBy` between the equipment, e.g. `T-101 → FlowsTo` the raw-water pump. The **R** note says it's `synthesized`, not an OPC UA reference.
- **i3x2ua:** the `ConnectsTo` edges between ports only (**C5**).
- **uns:** hand-listed `Feeds`/`FedBy` between assets, plus `Supplies` (CO₂, compressed air).
  - It's the most readable graph, and also the only one with links no OPC UA reference expresses: `filler → Feeds → capper` is a conveyor, not a pipe.
  - Nothing distinguishes a drawn line from a measured one.

### 10. A vendor profile that bends the rules
- **UA:** `SD-201 › Equipment › Mixer` has an *Interface* (`IMachineryEquipmentType`) as its TypeDefinition, a departure in the CESMII Acme profile (`docs/factory/STANDARDS_COVERAGE.md`).
- **cesmii:** `SD-201/Equipment/Mixer`, fidelity `typeDefinition / approximated`: "TypeDefinition … is an OPC UA Interface (abstract)…".
- **i3x2ua:** `asset-84d298f1b08c6f27`, no annotation (**H2**).
- **uns:** `demobev/plant1/syrup-room/sugar-dissolver` → `agitator_running`, `agitator_speed_rpm`. The mixer isn't an object at all.

### 11. What happened in the last 20 seconds?
`POST /objects/history` on the LT-101 reading:
- **cesmii:** 22 values. The first is `Good_HistorianInterpolated`, the bound value at `startTime` (**F3**).
- **i3x2ua:** 20 values, all `Good`.
- **uns:** one `GoodNoData` value. A UNS keeps current state only, and `capabilities.query.history = false` says so.

*Timestamps:* cesmii and i3x2ua return source timestamps. uns returns **when its connector saw the change**, so a 1 s poll quantizes them. The cesmii UA namespace's `timestamps` note says which timestamp is used.

### 12. Notes above the instances
- **Object:** `Machines` (`nsu=http://opcfoundation.org/UA/Machinery/;i=1001`) is an OPC UA EventNotifier.
  - cesmii: fidelity `events / dropped`.
  - i3x2ua: makes it a special `eventSource-50f258eb735fd22f` element (**B4**).
- **ObjectType:** `ISA95:EquipmentType` → `placeholders`, `nullability`.
- **RelationshipType:** `UA:Organizes` (`multiPath`), `DI:ConnectsTo`, `FlowsTo`.
- **Namespace:** `http://opcfoundation.org/UA/?projection=i3X` → methods, events, properties, localizedText, timestamps, quality, nonFinite, int64, references, accessRights, notProjected.
- i3x2ua and uns carry no notes. uns has only a `description` per type.

### 13. Check it yourself
```
node --import tsx gateway/src/tools/fidelity-audit.ts      # 40 rules, 6,170 checks, 0 gaps
```
It reads the plant as a plain OPC UA client and fails if any loss it finds isn't described in the cesmii i3X output. See `docs/gateway/FIDELITY.md`.
