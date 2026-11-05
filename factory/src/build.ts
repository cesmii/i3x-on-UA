/**
 * Build the plant's OPC UA instance model into an address space that already holds
 * the standard + vendor NodeSets (lib/load.ts). Pure model: static values only;
 * the Phase 3 simulator owns the dynamic ones.
 *
 * Structure decisions: docs/factory/PLANT_DESIGN.md §5, STANDARDS_COVERAGE.md (P1-a/b/c),
 * UA_MODEL_NOTES.md (node-opcua conventions).
 */
import {
  type AddressSpace, type BaseNode, type Namespace, type UAObject, type UAObjectType,
  type UAVariable, type UAVariableType, type UAReferenceType,
} from "node-opcua-address-space";
import { BrowseDirection, DataType, NodeClass, Range, Variant, makeAccessLevelFlag, makeEUInformation } from "node-opcua";
import { NSU, nsIndex } from "./lib/load.js";
import { allEquipment, type Area, type Equipment, type Instrument, type Plant, type Vendor } from "./plant.js";

type NsKey = keyof typeof NSU;

/** EngineeringUnits for the Acme vendor type's built-in process values (the type declares the property but ships no value). */
const ACME_UNITS: Record<string, string> = {
  "Monitoring/Process/Tank/Level": "m", "Monitoring/Process/Tank/LevelPercent": "%",
  "Monitoring/Process/Tank/Pressure": "bar", "Monitoring/Process/Tank/Temperature": "degC",
  "Component/Drive/OutputHz": "Hz", "Component/Drive/OutputVolts": "V",
  "Component/Motor/Speed": "rpm", "Component/Motor/Load": "%", "Component/Motor/Current": "A",
  "Component/Motor/SealPressure": "bar", "Component/Motor/Temperature": "degC",
  "Component/Motor/BearingTemperature": "degC", "Component/Motor/Vibration": "mm/s",
};

/** PA-DIM signal BrowseName + instrument model by measurement VariableType. */
const SIGNAL_ROLE: Record<string, [string, string]> = {
  LevelMeasurementVariableType: ["Level", "IT-LR200"],
  PressureMeasurementVariableType: ["Pressure", "IT-PT100"],
  TemperatureMeasurementVariableType: ["Temperature", "IT-TT50"],
  ActualVolumeFlowRateVariableType: ["Flow", "IT-MAG80"],
  ActualDensityVariableType: ["Density", "IT-DN10"],
  AnalyticalMeasurementVariableType: ["Concentration", "IT-AN30"],
  ConductivitySignalType: ["Conductivity", "IT-CD20"],
};

const NUMERIC = new Set([DataType.SByte, DataType.Byte, DataType.Int16, DataType.UInt16, DataType.Int32, DataType.UInt32,
  DataType.Int64, DataType.UInt64, DataType.Float, DataType.Double]);

const LEVELS = ["Enterprise", "Site", "Area", "ProcessCell", "Unit", "ProductionLine", "WorkCell", "ProductionUnit",
  "StorageZone", "StorageUnit", "WorkCenter", "WorkUnit", "EquipmentModule", "ControlModule", "Other"];

export class PlantBuilder {
  readonly ns: Namespace;
  private readonly idx: Record<NsKey, number>;
  private readonly classes = new Map<string, UAObject>();
  private readonly ports = new Map<string, UAObject>();
  private machines!: UAObject;

  constructor(private readonly as: AddressSpace, private readonly plant: Plant) {
    this.ns = as.registerNamespace(plant.namespace);
    this.ns.version = "1.0.0";
    this.ns.publicationDate = new Date("2026-11-05T00:00:00Z"); // fixed, so output is deterministic
    this.idx = Object.fromEntries(Object.entries(NSU).map(([k, u]) => [k, k === "FACTORY" ? this.ns.index : nsIndex(as, u)])) as any;
  }

  // ---------- small helpers ----------
  private id(s: string) { return `ns=${this.ns.index};s=${s}`; }
  private qn(key: NsKey, name: string) { return { namespaceIndex: this.idx[key], name }; }
  private own(name: string) { return this.qn("FACTORY", name); }
  private ot(key: NsKey, name: string): UAObjectType {
    const t = this.as.findObjectType(name, this.idx[key]);
    if (!t) throw new Error(`ObjectType ${key}:${name} not found`);
    return t;
  }
  private vt(key: NsKey, name: string): UAVariableType {
    const t = this.as.findVariableType(name, this.idx[key]);
    if (!t) throw new Error(`VariableType ${key}:${name} not found`);
    return t;
  }
  private rt(key: NsKey, name: string): UAReferenceType {
    const t = this.as.findReferenceType(name, this.idx[key]);
    if (!t) throw new Error(`ReferenceType ${key}:${name} not found`);
    return t;
  }
  /** Child by BrowseName over any forward hierarchical reference (Acme hangs `Component` off Organizes, not an Aggregate). */
  private child(node: BaseNode, name: string): BaseNode | null {
    const agg = (node as UAObject).getChildByName(name);
    if (agg) return agg;
    for (const r of node.findReferencesEx("HierarchicalReferences", BrowseDirection.Forward)) {
      const c = this.as.findNode(r.nodeId);
      if (c?.browseName.name === name) return c;
    }
    return null;
  }
  private path(node: BaseNode, p: string): BaseNode {
    let n: BaseNode | null = node;
    for (const part of p.split("/")) {
      n = n && this.child(n, part);
      if (!n) throw new Error(`${node.browseName.toString()}: no child path ${p}`);
    }
    return n!;
  }
  private set(v: BaseNode | null, dataType: DataType, value: unknown) {
    if (!v || v.nodeClass !== NodeClass.Variable) return false;
    if (typeof value === "number") { // numbers follow the variable's own built-in type (Float vs Double, Int32 enums, …)
      const basic = (v as UAVariable).getBasicDataType();
      if (NUMERIC.has(basic)) dataType = basic;
    }
    (v as UAVariable).setValueFromSource(new Variant({ dataType, value }));
    return true;
  }
  private lt(text: string) { return { locale: "", text }; } // language-neutral (Machinery §7.1)
  private eu(unitKey: string) {
    const u = this.plant.units[unitKey];
    return makeEUInformation(u.code, u.symbol, u.name);
  }
  private setAnalog(v: UAVariable, unitKey: string | undefined, range?: [number, number], nominal?: number) {
    if (unitKey) this.set(this.child(v, "EngineeringUnits"), DataType.ExtensionObject, this.eu(unitKey));
    if (range) this.set(this.child(v, "EURange"), DataType.ExtensionObject, new Range({ low: range[0], high: range[1] }));
    if (nominal !== undefined) this.set(v, DataType.Double, nominal);
  }
  private serial(eq: { tag: string; model?: string }) {
    let h = 2166136261; // FNV-1a: deterministic serials from the tag
    for (const c of eq.tag) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return `${(eq.model ?? "SN").replace(/[^A-Z0-9]/gi, "")}-${String(h % 100000).padStart(5, "0")}`;
  }

  /** Fill whichever DI / Machinery nameplate properties exist on `ident`. */
  private nameplate(ident: BaseNode, o: { tag: string; name: string; model?: string; year?: number; deviceClass?: string; location: string }, vendor: Vendor) {
    const serial = this.serial(o);
    const model = o.model ?? "custom";
    const year = o.year ?? 2018;
    const vals: Array<[string, DataType, unknown]> = [
      ["Manufacturer", DataType.LocalizedText, this.lt(vendor.manufacturer)],
      ["ManufacturerUri", DataType.String, vendor.uri],
      ["Model", DataType.LocalizedText, this.lt(model)],
      ["ProductCode", DataType.String, model],
      ["SerialNumber", DataType.String, serial],
      ["ProductInstanceUri", DataType.String, `${vendor.uri}/${model}/${serial}`],
      ["HardwareRevision", DataType.String, "A"],
      ["SoftwareRevision", DataType.String, "1.0.0"],
      ["DeviceClass", DataType.String, o.deviceClass ?? ""],
      ["YearOfConstruction", DataType.UInt16, year],
      ["MonthOfConstruction", DataType.Byte, 1 + (this.serial(o).length % 12)],
      ["InitialOperationDate", DataType.DateTime, new Date(Date.UTC(year, 5, 1))],
      ["AssetId", DataType.String, o.tag],
      ["ComponentName", DataType.LocalizedText, this.lt(`${o.tag} ${o.name}`)],
      ["Location", DataType.String, o.location],
      ["RevisionCounter", DataType.Int32, 1],
    ];
    for (const [name, dt, v] of vals) this.set(this.child(ident, name), dt, v);
  }

  // ---------- build ----------
  build() {
    const objects = this.as.rootFolder.objects;
    this.machines = this.as.findNode(`ns=${this.idx.MACHINERY};i=1001`) as UAObject;
    if (!this.machines) throw new Error("Machinery Machines folder (i=1001) not found");

    const classesFolder = this.ns.addFolder(objects, { browseName: this.own("EquipmentClasses"), nodeId: this.id("EquipmentClasses"),
      description: "ISA-95 equipment classes used by this plant (EquipmentClassType instances)" });
    for (const { eq } of allEquipment(this.plant)) if (eq.kind === "isa95") this.equipmentClass(classesFolder, eq.class);

    const ent = this.isa95(this.plant.enterprise.id, this.plant.enterprise.name, "Enterprise", { organizedBy: objects });
    const site = this.isa95(this.plant.site.id, this.plant.site.name, "Site", { madeUpOf: ent });
    for (const area of this.plant.areas) {
      const a = this.isa95(`${this.plant.site.id}/${area.id}`, area.name, area.level, { madeUpOf: site, browseName: area.id });
      for (const eq of area.equipment) this.equipment(a, area, eq);
    }
    for (const [from, to] of this.plant.links) {
      this.ports.get(from)!.addReference({ referenceType: this.rt("DI", "ConnectsTo").nodeId, nodeId: this.ports.get(to)!.nodeId, isForward: true });
    }
    this.accessLevels();
    return this;
  }

  /**
   * node-opcua instantiates Variables as read/write. Real devices aren't: every Variable in the plant is
   * CurrentRead only, except the nameplate fields OPC 40001-1 defines as user-writable (§8: AssetId,
   * ComponentName, Location). The simulator writes server-side, which AccessLevel doesn't restrict.
   */
  private accessLevels() {
    const RW = new Set(["AssetId", "ComponentName", "Location"]);
    let ro = 0, rw = 0;
    for (const n of (this.ns as unknown as { nodeIterator(): Iterable<BaseNode> }).nodeIterator()) {
      if (n.nodeClass !== NodeClass.Variable) continue;
      const v = n as UAVariable;
      const parent = (v.parent ?? null) as BaseNode | null;
      const nameplate = RW.has(v.browseName.name ?? "") && !!parent && /Identification|Mixer/.test(parent.browseName.name ?? "");
      const level = makeAccessLevelFlag(nameplate ? "CurrentRead | CurrentWrite" : "CurrentRead");
      (v as unknown as { accessLevel: number; userAccessLevel: number }).accessLevel = level;
      (v as unknown as { accessLevel: number; userAccessLevel: number }).userAccessLevel = level;
      if (nameplate) rw++; else ro++;
    }
    this.accessSummary = { readOnly: ro, writable: rw };
  }
  accessSummary = { readOnly: 0, writable: 0 };

  private equipmentClass(folder: UAObject, name: string) {
    if (this.classes.has(name)) return this.classes.get(name)!;
    const c = this.ot("ISA95", "EquipmentClassType").instantiate({
      browseName: this.own(name), namespace: this.ns, organizedBy: folder, nodeId: this.id(`Class/${name}`), optionals: ["EquipmentLevel"],
    });
    this.set(this.child(c, "EquipmentLevel"), DataType.Int32, LEVELS.indexOf(this.plant.classes[name].level));
    this.classes.set(name, c);
    return c;
  }

  /** ISA-95 Equipment (EquipmentType) at a hierarchy level. */
  private isa95(nodeId: string, name: string, level: string, where: { organizedBy?: UAObject; madeUpOf?: UAObject; browseName?: string }) {
    const references = where.madeUpOf
      ? [{ referenceType: this.rt("ISA95", "MadeUpOfEquipment").nodeId, isForward: false, nodeId: where.madeUpOf.nodeId }] : [];
    const e = this.ot("ISA95", "EquipmentType").instantiate({
      browseName: this.own(where.browseName ?? nodeId), displayName: name, namespace: this.ns, nodeId: this.id(nodeId),
      organizedBy: where.organizedBy, references, optionals: ["EquipmentLevel"],
    });
    if (LEVELS.indexOf(level) < 0) throw new Error(`unknown ISA-95 level ${level}`);
    this.set(this.child(e, "EquipmentLevel"), DataType.Int32, LEVELS.indexOf(level));
    return e;
  }

  private equipment(areaNode: UAObject, area: Area, eq: Equipment) {
    const displayName = /\d/.test(eq.tag) ? `${eq.tag} ${eq.name}` : eq.name; // site-boundary items have no ISA tag
    const organizes = [{ referenceType: "Organizes", isForward: false, nodeId: areaNode.nodeId }];
    const location = `${this.plant.site.name} / ${area.name}`;
    const vendor = eq.vendor ? this.plant.vendors[eq.vendor] : undefined;
    let node: UAObject;

    switch (eq.kind) {
      case "isa95": {
        node = this.isa95(eq.tag, displayName, this.plant.classes[eq.class].level, { madeUpOf: areaNode });
        node.addReference({ referenceType: this.rt("ISA95", "DefinedByEquipmentClass").nodeId, nodeId: this.classes.get(eq.class)!.nodeId, isForward: true });
        for (const [k, [v, unit]] of Object.entries(eq.properties ?? {})) this.isa95Property(node, k, v, unit);
        break;
      }
      case "acmeTank": {
        node = this.ot("ACME", "MixingTankType").instantiate({
          browseName: this.own(eq.tag), displayName, namespace: this.ns, nodeId: this.id(eq.tag), references: organizes,
          optionals: ["Monitoring", "Monitoring.Process.Phases", "Equipment.Mixer"],
        });
        this.nameplate(this.child(node, "Identification")!, { ...eq, deviceClass: "Mixing tank", location }, vendor!);
        this.nameplate(this.path(node, "Equipment/Mixer"), { tag: `${eq.tag}-AG`, name: "Agitator", model: "AMX-AG", year: eq.year, deviceClass: "Agitator", location }, vendor!);
        this.set(this.path(node, "Equipment/Mixer/MachineryEquipmentTypeId"), DataType.String, "Agitator");
        for (const [p, unit] of Object.entries(ACME_UNITS)) {
          const pv = this.path(node, p);
          const sig = this.child(pv, "AnalogSignal") as UAVariable | null;
          if (sig) this.setAnalog(sig, unit);
          this.set(this.child(pv, "SignalTag"), DataType.String, `${eq.tag}/${p}`); // PA-DIM SignalTag (Mandatory)
        }
        this.machines.addReference({ referenceType: "Organizes", nodeId: node.nodeId, isForward: true });
        break;
      }
      case "pump": {
        node = this.ot("PUMPS", "PumpType").instantiate({
          browseName: this.own(eq.tag), displayName, namespace: this.ns, nodeId: this.id(eq.tag), references: organizes,
          optionals: [
            "Identification.ManufacturerUri", "Identification.Model", "Identification.ProductCode", "Identification.YearOfConstruction",
            "Identification.MonthOfConstruction", "Identification.HardwareRevision", "Identification.SoftwareRevision",
            "Identification.AssetId", "Identification.ComponentName", "Identification.Location", "Identification.DeviceClass",
            "Operational", "Operational.Measurements",
            "Operational.Measurements.DifferentialPressure", "Operational.Measurements.FluidTemperature",
            "Operational.Measurements.PumpPowerInput", "Operational.Measurements.Speed",
            "Ports",
          ],
        });
        this.nameplate(this.child(node, "Identification")!, { ...eq, deviceClass: "Pump", location }, vendor!);
        const m = this.path(node, "Operational/Measurements");
        this.setAnalog(this.child(m, "DifferentialPressure") as UAVariable, "bar");
        this.setAnalog(this.child(m, "FluidTemperature") as UAVariable, "degC");
        this.setAnalog(this.child(m, "PumpPowerInput") as UAVariable, "kW");
        this.setAnalog(this.child(m, "Speed") as UAVariable, "rpm");
        this.machines.addReference({ referenceType: "Organizes", nodeId: node.nodeId, isForward: true });
        break;
      }
      case "packml": {
        node = this.ot("PACKML", "PackMLBaseObjectType").instantiate({
          browseName: this.own(eq.tag), displayName, namespace: this.ns, nodeId: this.id(eq.tag), references: organizes,
          optionals: ["PackMLVersion", "TagID", "Admin.MachDesignSpeed", "Admin.ProdProcessedCount", "Admin.ProdDefectiveCount",
            "Admin.ProdConsumedCount", "Admin.StopReason", "Admin.StateCurrentTime", "Admin.AccTimeSinceReset"],
        });
        this.set(this.child(node, "PackMLVersion"), DataType.String, "1.01");
        this.set(this.child(node, "TagID"), DataType.String, eq.tag);
        this.set(this.path(node, "Admin/MachDesignSpeed"), DataType.Float, eq.designSpeed ?? 0);
        for (const s of ["CurMachSpeed", "MachSpeed"]) this.setAnalog(this.path(node, `Status/${s}`) as UAVariable, "1/min");
        break;
      }
    }
    if (eq.machinery) this.machineryBlocks(node, eq, vendor!, location);
    if (eq.ports) this.addPorts(node, eq);
    for (const [itag, ins] of Object.entries(eq.instruments ?? {})) this.instrument(node, itag, ins, location);
    return node;
  }

  private isa95Property(eq: UAObject, name: string, value: number, unit: string) {
    const p = this.vt("ISA95", "EquipmentPropertyType").instantiate({
      browseName: this.own(name), namespace: this.ns, dataType: "Double",
      references: [{ referenceType: this.rt("ISA95", "HasISA95ClassProperty").nodeId, isForward: false, nodeId: eq.nodeId }],
    });
    this.set(p, DataType.Double, value);
    this.ns.addVariable({ propertyOf: p, browseName: "EngineeringUnits", dataType: "EUInformation", typeDefinition: "PropertyType",
      value: { dataType: DataType.ExtensionObject, value: this.eu(unit) } });
  }

  /** Machinery building blocks as AddIns (OPC 40001-1 §7.3 organization, §16 Monitoring/Status). */
  private machineryBlocks(item: UAObject, eq: Equipment, vendor: Vendor, location: string) {
    const hasAddIn = this.rt("UA", "HasAddIn").nodeId;
    const addInOf = (parent: UAObject) => [{ referenceType: hasAddIn, isForward: false, nodeId: parent.nodeId }];
    const mbb = this.ns.addObject({ browseName: this.qn("MACHINERY", "MachineryBuildingBlocks"), typeDefinition: "FolderType",
      componentOf: item, nodeId: this.id(`${eq.tag}/MachineryBuildingBlocks`) });

    // Identification: directly on the item AND referenced from MachineryBuildingBlocks (§7.3, one node, two paths)
    const ident = this.ot("MACHINERY", "MachineIdentificationType").instantiate({
      browseName: this.qn("DI", "Identification"), namespace: this.ns, nodeId: this.id(`${eq.tag}/Identification`), references: addInOf(item),
      optionals: ["ManufacturerUri", "Model", "ProductCode", "HardwareRevision", "SoftwareRevision", "DeviceClass", "YearOfConstruction",
        "MonthOfConstruction", "InitialOperationDate", "AssetId", "ComponentName", "Location"],
    });
    this.nameplate(ident, { ...eq, deviceClass: eq.class, location }, vendor);
    mbb.addReference({ referenceType: hasAddIn, nodeId: ident.nodeId, isForward: true });

    const state = this.ot("MACHINERY", "MachineryItemState_StateMachineType").instantiate({
      browseName: this.qn("MACHINERY", "MachineryItemState"), namespace: this.ns, nodeId: this.id(`${eq.tag}/MachineryItemState`), references: addInOf(mbb),
    });
    const mode = this.ot("MACHINERY", "MachineryOperationModeStateMachineType").instantiate({
      browseName: this.qn("MACHINERY", "MachineryOperationMode"), namespace: this.ns, nodeId: this.id(`${eq.tag}/MachineryOperationMode`), references: addInOf(mbb),
    });
    this.initialState(state, "NotExecuting");
    this.initialState(mode, "Processing");

    // Monitoring: top-level entry point on the item AND in MachineryBuildingBlocks; Status references the state machines (§16)
    const mon = this.ot("MACHINERY", "MonitoringType").instantiate({
      browseName: this.qn("MACHINERY", "Monitoring"), namespace: this.ns, nodeId: this.id(`${eq.tag}/Monitoring`), references: addInOf(item), optionals: ["Status"],
    });
    mbb.addReference({ referenceType: hasAddIn, nodeId: mon.nodeId, isForward: true });
    const status = this.child(mon, "Status") as UAObject;
    status.addReference({ referenceType: "Organizes", nodeId: state.nodeId, isForward: true });
    status.addReference({ referenceType: "Organizes", nodeId: mode.nodeId, isForward: true });

    if (eq.kind === "packml") {
      const oc = this.ot("MACHINERY", "MachineryOperationCounterType").instantiate({
        browseName: this.qn("DI", "OperationCounters"), namespace: this.ns, nodeId: this.id(`${eq.tag}/OperationCounters`), references: addInOf(item),
        optionals: ["OperationCycleCounter", "OperationDuration", "PowerOnDuration"],
      });
      mbb.addReference({ referenceType: hasAddIn, nodeId: oc.nodeId, isForward: true });
    }
    this.machines.addReference({ referenceType: "Organizes", nodeId: item.nodeId, isForward: true });
  }

  /** Set a Machinery finite state machine's CurrentState (+Id, Number) to one of the states defined on its type. */
  private initialState(sm: UAObject, stateName: string) {
    const type = sm.typeDefinitionObj as UAObjectType;
    const st = type.getChildByName(stateName) as UAObject | null;
    const cur = this.child(sm, "CurrentState") as UAVariable;
    if (!st || !cur) throw new Error(`${sm.browseName}: no state ${stateName}`);
    this.set(cur, DataType.LocalizedText, { locale: "", text: stateName });
    this.set(this.child(cur, "Id"), DataType.NodeId, st.nodeId);
    const num = this.child(st, "StateNumber") as UAVariable | null;
    const numVar = this.child(cur, "Number");
    if (num && numVar) this.set(numVar, DataType.UInt32, num.readValue().value.value);
  }

  /** Pumps (OPC 40223 §7.36) ports; the Pumps PortsGroupType is reused for non-pump equipment (decision P1-b). */
  private addPorts(item: UAObject, eq: Equipment) {
    let group = this.child(item, "Ports") as UAObject | null;
    if (!group) {
      group = this.ot("PUMPS", "PortsGroupType").instantiate({ browseName: this.qn("PUMPS", "Ports"), namespace: this.ns, componentOf: item });
    }
    for (const [name, p] of Object.entries(eq.ports!)) {
      const type = p.direction === "In" ? "InletConnectionPortType" : "OutletConnectionPortType";
      const port = this.ot("PUMPS", type).instantiate({
        browseName: this.own(name), namespace: this.ns, componentOf: group, optionals: ["Category", "Direction", "IdCarrier"],
      });
      this.set(this.child(port, "Category"), DataType.String, p.category);
      this.set(this.child(port, "Direction"), DataType.Int32, p.direction === "In" ? 0 : 1); // PortDirectionEnum: In 0, Out 1, InOut 2
      this.set(this.child(port, "IdCarrier"), DataType.String, eq.tag);
      this.ports.set(`${eq.tag}.${name}`, port);
    }
  }

  /** PA-DIM field device (instrument or valve) as a component of the equipment it sits on. */
  private instrument(parent: UAObject, tag: string, ins: Instrument, location: string) {
    const kind = ins.kind ?? "analog";
    const dev = this.ot("PADIM", ins.device ?? "PADIMType").instantiate({
      browseName: this.own(tag), displayName: `${tag} ${ins.name}`, namespace: this.ns, nodeId: this.id(tag), componentOf: parent,
      optionals: ["SignalSet"],
    });
    const roleKey = ins.signal ?? ins.variable ?? "";
    const [role, model] = kind === "onoff" ? ["Valve", "IT-XV100"] : kind === "control" ? ["Valve", "IT-VP400"] : (SIGNAL_ROLE[roleKey] ?? ["Measurement", "IT-GEN"]);
    this.nameplate(dev, { tag, name: ins.name, model, year: 2020, deviceClass: kind === "analog" ? "Transmitter" : "Valve", location }, this.plant.vendors.initech);
    this.set(this.child(dev, "DeviceHealth"), DataType.Int32, 0); // DeviceHealthEnumeration NORMAL

    const signalType = kind === "onoff" ? "TwoStateDiscreteControlSignalType" : kind === "control" ? "ControlSignalType" : (ins.signal ?? "AnalogSignalType");
    const sig = this.ot("PADIM", signalType).instantiate({ browseName: this.own(role), namespace: this.ns, componentOf: this.child(dev, "SignalSet") as UAObject });
    this.set(this.child(sig, "SignalTag"), DataType.String, tag);

    if (kind === "analog") {
      let v = this.child(sig, "AnalogSignal") as UAVariable;
      if (ins.variable) { // PA-DIM measurement-specific VariableType instead of the generic AnalogSignalVariableType
        this.ns.deleteNode(v);
        v = this.vt("PADIM", ins.variable).instantiate({ browseName: this.qn("PADIM", "AnalogSignal"), namespace: this.ns, componentOf: sig, dataType: "Double" });
      }
      this.setAnalog(v, ins.unit, ins.range, ins.nominal);
    } else if (kind === "onoff") {
      const cs = this.child(sig, "ControlSignal")!;
      this.set(this.child(cs, "TrueState"), DataType.LocalizedText, this.lt("Open"));
      this.set(this.child(cs, "FalseState"), DataType.LocalizedText, this.lt("Closed"));
      this.set(cs, DataType.Boolean, false);
    } else {
      const cs = this.child(sig, "ControlSignal") as UAVariable;
      this.setAnalog(cs, "%", [0, 100], 0);
      this.set(cs, DataType.Float, 0);
    }
  }

}

export function buildPlant(as: AddressSpace, plant: Plant) {
  return new PlantBuilder(as, plant).build();
}
