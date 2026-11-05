# Acme Mix Tank Profile: Changelog

Namespace `https://cesmii.net/profiles/AcmeMixTank` · CESMII-owned profile.
Current file: `nodesets/vendor/Acme-Mix-Tank-Profile.NodeSet2.xml`. Previous release: `docs/acme/Acme-Mix-Tank-Profile-1.00.NodeSet2.xml`.

## 1.01 (2026-11-05)

**Fix: every InstanceDeclaration now has its own node.**

In 1.00, 80 aggregating references (HasComponent/HasProperty) pointed at declarations owned by *another* node, so several parents shared one child:

- **39 cross-namespace references** pointed into other specifications' type definitions instead of declaring their own members:
  - ProcessValues `ProcessValueType/AnalogSignal` (13×)
  - PA-DIM `SignalType/SignalTag` (13×)
  - ProcessValues setpoint `EngineeringUnits`/`EURange` (8×)
  - ns0 `AnalogItemType/EURange` (3×)
  - Machinery `SerialNumber`, `ProductInstanceUri`, `MachineryEquipmentTypeId` (3×)
- **41 same-namespace references:** declarations inside `MixingTankType` pointed at the members of other Acme types instead of their own copies:
  - `Identification` → `AcmeMachineIdType`
  - `Component/Drive` → `IDrive`
  - `Component/Motor` → `IMotor`
  - `Monitoring` → `MonitoringAcmeType` / `MixTankMonitoring`
  - `Monitoring/Process/Tank` → `ProcessVesselType`
  - `CleanInPlace` → `ICleanInPlaceEquipment`
  - `Phases` → `ProcessPhases`

**Effect in 1.00:** servers that instantiate `MixingTankType` produced one `AnalogSignal` and one `SignalTag` node shared by all 13 process values of a tank, so the motor speed, motor current, tank level, and so on all appeared to share one signal.

**Change:**
- Each such reference now targets a new node owned by the referencing declaration. Copies are made recursively, keeping BrowseName, DataType, ValueRank, TypeDefinition, ModellingRule, DisplayName, Description and default Value: **548 nodes added**.
- No existing NodeId was removed or renumbered.
- New NodeIds were allocated after the highest used ones: `ns=1;i=5033…` for Objects, `ns=1;i=6077…` for Variables.

**Model header changes:**
- Version `1.00` → `1.01`; PublicationDate `2026-11-05`.
- New RequiredModel **`http://opcfoundation.org/UA/Dictionary/IRDI` 1.01.0** (2023-10-27), the same version PA-DIM 1.01.0 requires. The copied PA-DIM `SignalTag` declarations carry their `HasDictionaryEntry` to IRDI `0112/2///61987#ABB271#008`. Before, that was only reachable through PA-DIM.
- New alias `HasDictionaryEntry` (`i=17597`).

**Unchanged** (known departures, kept deliberately; see `docs/factory/STANDARDS_COVERAGE.md`, "Vendor type review"):
- Interfaces used as TypeDefinitions (`IDrive`, `IMotor`, `ICleanInPlaceEquipment`, Machinery `IMachineryEquipmentType`)
- Look-alike Machinery state machines in `Monitoring/Status`
- `MonitoringAcmeType` ← FolderType instead of Machinery `MonitoringType`
- `Component` attached by `Organizes`, and no Identification on its components
- Units only in descriptions (EngineeringUnits declared but without values)
- The misplaced descriptions on `ICleanInPlaceEquipment` / `ICleanInPlaceSystem`
- `NamespaceVersion` / `NamespacePublicationDate` properties without values (as in 1.00)

**How it was produced:**
```
python3 -I tools/repair_shared_declarations.py nodesets/vendor/Acme-Mix-Tank-Profile.NodeSet2.xml nodesets/standard \
    --version 1.01 --date 2026-11-05T00:00:00Z
```

**Checks:**
- No shared declarations remain.
- The file is well-formed, and every reference resolves against the OPC Foundation NodeSets. The one exception is the IRDI 1.01.0 entry above, which our local IRDI copy (1.00) doesn't contain.
- The plant generator instantiates it with no per-instance repair, and the verifier confirms that no variable has more than one parent.
