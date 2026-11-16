/**
 * Reload the generated NodeSet on top of the standard ones (fresh address space, nothing
 * from the generator in memory) and check it against the plant definition.
 *   npm run verify -w factory [-- plant/line1.yaml]
 */
import path from "node:path";
import { type AddressSpace, type BaseNode, type UAObject, type UAVariable } from "node-opcua-address-space";
import { BrowseDirection, NodeClass } from "node-opcua";
import { FACTORY_NODESETS, loadBase, nsIndex, NSU, ROOT } from "./lib/load.js";
import { allEquipment, loadPlant } from "./plant.js";

const plant = loadPlant(path.resolve(process.argv[2] ?? path.join(ROOT, "factory/plant/line1.yaml")));
const as: AddressSpace = await loadBase(FACTORY_NODESETS);
const F = nsIndex(as, plant.namespace);
const node = (s: string) => as.findNode(`ns=${F};s=${s}`);
const fails: string[] = [];
let checks = 0;
const check = (ok: unknown, msg: string) => { checks++; if (!ok) fails.push(msg); };
const typeOf = (n: BaseNode | null) => (n as UAObject | null)?.typeDefinitionObj?.browseName.name;
/** ReferenceType by BrowseName, searching ns0 then the companion namespaces (non-ns0 types can't be passed by name). */
const R = (name: string) => {
  for (const uri of [...Object.values(NSU), plant.namespace]) {
    const i = as.getNamespaceIndex(uri);
    const t = i >= 0 ? as.findReferenceType(name, i) : null;
    if (t) return t.nodeId;
  }
  throw new Error(`ReferenceType ${name} not found`);
};
const refsTo = (from: BaseNode, refType: string, to: BaseNode, dir = BrowseDirection.Forward) =>
  from.findReferencesEx(R(refType), dir).some((r) => r.nodeId.toString() === to.nodeId.toString());
const kid = (n: BaseNode | null, name: string): BaseNode | null => {
  if (!n) return null;
  for (const r of n.findReferencesEx("HierarchicalReferences", BrowseDirection.Forward)) {
    const c = as.findNode(r.nodeId);
    if (c?.browseName.name === name) return c;
  }
  return null;
};
const val = (n: BaseNode | null) => (n && n.nodeClass === NodeClass.Variable ? (n as UAVariable).readValue().value.value : undefined);

const EXPECTED_TYPE = { isa95: "EquipmentType", acmeTank: "MixingTankType", pump: "PumpType", packml: "PackMLBaseObjectType" } as const;
const machines = as.findNode(`ns=${nsIndex(as, NSU.MACHINERY)};i=1001`)!;

// hierarchy
const ent = node(plant.enterprise.id), site = node(plant.site.id);
check(ent && refsTo(as.rootFolder.objects, "Organizes", ent), "enterprise organized by Objects");
check(ent && site && refsTo(ent, "MadeUpOfEquipment", site), "site MadeUpOfEquipment of enterprise");

for (const area of plant.areas) {
  const a = node(`${plant.site.id}/${area.id}`);
  check(a && site && refsTo(site, "MadeUpOfEquipment", a), `area ${area.id} under site`);
  for (const eq of area.equipment) {
    const n = node(eq.tag);
    check(n, `${eq.tag} exists`);
    if (!n || !a) continue;
    check(typeOf(n) === EXPECTED_TYPE[eq.kind], `${eq.tag} type ${typeOf(n)} ≠ ${EXPECTED_TYPE[eq.kind]}`);
    const parentRef = eq.kind === "isa95" ? "MadeUpOfEquipment" : "Organizes";
    check(refsTo(a, parentRef, n), `${eq.tag} linked from ${area.id} by ${parentRef}`);
    if (eq.kind === "isa95") check(n.findReferencesEx(R("DefinedByEquipmentClass"), BrowseDirection.Forward).length === 1, `${eq.tag} DefinedByEquipmentClass`);

    const isMachineryItem = eq.machinery || eq.kind !== "isa95";
    check(refsTo(machines, "Organizes", n) === isMachineryItem, `${eq.tag} ${isMachineryItem ? "missing from" : "wrongly in"} Machines folder`);
    if (eq.machinery) {
      const ident = kid(n, "Identification"), mbb = kid(n, "MachineryBuildingBlocks"), mon = kid(n, "Monitoring");
      for (const p of ["Manufacturer", "SerialNumber", "ProductInstanceUri"]) check(val(kid(ident, p)), `${eq.tag}/Identification/${p} has a value`);
      check(mbb && ident && refsTo(mbb, "HasAddIn", ident), `${eq.tag}: MachineryBuildingBlocks → Identification (second path)`);
      const st = kid(mbb, "MachineryItemState"), mode = kid(mbb, "MachineryOperationMode");
      check(val(kid(st, "CurrentState"))?.text, `${eq.tag}: MachineryItemState.CurrentState set`);
      const status = kid(mon, "Status");
      check(status && st && mode && refsTo(status, "Organizes", st) && refsTo(status, "Organizes", mode), `${eq.tag}: Monitoring/Status references both state machines (§16)`);
    }
    for (const [itag, ins] of Object.entries(eq.instruments ?? {})) {
      const d = node(itag);
      check(d && refsTo(n, "HasComponent", d), `${itag} is a component of ${eq.tag}`);
      const sigs = d && kid(d, "SignalSet");
      const sig = sigs && as.findNode(sigs.findReferencesEx("HasComponent", BrowseDirection.Forward)[0]?.nodeId);
      check(val(kid(sig ?? null, "SignalTag")) === itag, `${itag}: SignalTag`);
      if ((ins.kind ?? "analog") === "analog") {
        const v = kid(sig ?? null, "AnalogSignal");
        if (ins.variable) check(typeOf(v) === ins.variable, `${itag}: AnalogSignal type ${typeOf(v)} ≠ ${ins.variable}`);
        check(val(kid(v, "EngineeringUnits"))?.unitId, `${itag}: EngineeringUnits`);
        check(val(v) === ins.nominal || Math.abs((val(v) ?? NaN) - (ins.nominal ?? NaN)) < 1e-4, `${itag}: nominal value`);
      }
    }
  }
}

// material flow
const portsOf = new Map<string, BaseNode>();
for (const { eq } of allEquipment(plant)) for (const p of Object.keys(eq.ports ?? {})) {
  const port = kid(kid(node(eq.tag), "Ports"), p);
  check(port, `${eq.tag}.${p} port exists`);
  if (port) portsOf.set(`${eq.tag}.${p}`, port);
}
for (const [from, to] of plant.links) {
  const a = portsOf.get(from), b = portsOf.get(to);
  if (!a || !b) continue;
  check(refsTo(a, "ConnectsTo", b) || refsTo(b, "ConnectsTo", a), `ConnectsTo ${from} → ${to}`);
  check(val(kid(a, "Direction")) === 1 && val(kid(b, "Direction")) === 0, `${from} → ${to}: Direction Out → In`);
  check(val(kid(a, "Category")) === val(kid(b, "Category")), `${from} → ${to}: same Category`);
}

// personnel, materials, orders: own top-level hierarchies, linked to equipment only by graph references
const eqOf = (ref: string) => node(ref);
const isGraph = (refType: string) => {
  const t = as.findNode(R(refType)) as unknown as { isSubtypeOf(t: unknown): boolean };
  return t.isSubtypeOf(as.findReferenceType("NonHierarchicalReferences")) && !t.isSubtypeOf(as.findReferenceType("HierarchicalReferences"));
};
for (const r of ["Operates", "Consumes", "Produces", "StoredIn", "DispatchedTo", "DefinedByMaterialClass"]) check(isGraph(r), `${r} is a non-hierarchical ReferenceType`);
for (const top of ["Personnel", "Materials", "Orders"]) check(node(top) && refsTo(as.rootFolder.objects, "Organizes", node(top)!), `${top} folder organized by Objects`);
if (plant.personnel) for (const [id, p] of Object.entries(plant.personnel.persons)) {
  const n = node(`Person/${id}`);
  check(typeOf(n) === "PersonType", `person ${id} is a PersonType`);
  if (!n) continue;
  check(refsTo(n, "DefinedByPersonnelClass", node(`PersonnelClass/${p.class}`)!), `person ${id} DefinedByPersonnelClass ${p.class}`);
  for (const e of p.operates ?? []) check(refsTo(n, "Operates", eqOf(e)!), `person ${id} Operates ${e}`);
}
if (plant.materials) {
  for (const [id, d] of Object.entries(plant.materials.definitions)) {
    const n = node(`Material/${id}`);
    check(typeOf(n) === "MaterialDefinitionType" && refsTo(n!, "DefinedByMaterialClass", node(`MaterialClass/${d.class}`)!), `material ${id} DefinedByMaterialClass ${d.class}`);
  }
  for (const [id, l] of Object.entries(plant.materials.lots)) {
    const n = node(`Lot/${id}`);
    check(typeOf(n) === "MaterialLotType", `lot ${id} is a MaterialLotType`);
    if (!n) continue;
    check(refsTo(n, "DefinedByMaterialDefinition", node(`Material/${l.definition}`)!), `lot ${id} DefinedByMaterialDefinition`);
    const q = kid(n, "Quantity");
    check(Math.abs(val(q) - l.quantity[0]) < 1e-9 && val(kid(q, "EngineeringUnits"))?.unitId, `lot ${id}: Quantity + EngineeringUnits`);
    if (l.storedIn) check(refsTo(n, "StoredIn", eqOf(l.storedIn)!), `lot ${id} StoredIn ${l.storedIn}`);
    for (const e of l.consumedBy ?? []) check(refsTo(eqOf(e)!, "Consumes", n), `${e} Consumes lot ${id}`);
    for (const e of l.producedBy ?? []) check(refsTo(eqOf(e)!, "Produces", n), `${e} Produces lot ${id}`);
  }
}
for (const [wrId, wr] of Object.entries(plant.orders ?? {})) {
  const w = node(`Orders/${wrId}`);
  check(typeOf(w) === "WorkRequestType" && refsTo(node("Orders")!, "Organizes", w!), `work request ${wrId} under Orders`);
  for (const [joId, jo] of Object.entries(wr.jobOrders)) {
    const j = node(`Orders/${wrId}/${joId}`);
    check(typeOf(j) === "JobOrderType" && w && refsTo(w, "HasComponent", j!), `job order ${joId} is a component of ${wrId}`);
    if (!j) continue;
    check(val(kid(j, "JobOrderID")) === joId && val(kid(j, "State")), `job order ${joId}: JobOrderID + State`);
    check(val(kid(j, "PlannedQuantity")) === jo.plannedQuantity[0] && val(kid(kid(j, "PlannedQuantity"), "EngineeringUnits"))?.unitId, `job order ${joId}: PlannedQuantity + unit`);
    check(refsTo(j, "DispatchedTo", eqOf(jo.dispatchedTo)!), `job order ${joId} DispatchedTo ${jo.dispatchedTo}`);
    for (const l of jo.consumes ?? []) check(refsTo(j, "Consumes", node(`Lot/${l}`)!), `job order ${joId} Consumes ${l}`);
    for (const l of jo.produces ?? []) check(refsTo(j, "Produces", node(`Lot/${l}`)!), `job order ${joId} Produces ${l}`);
  }
}

// no variable left with several aggregating parents in our namespace (vendor shared-node repair)
let sharedLeft = 0, units = 0, missingUnits: string[] = [];
const seen = new Set<string>();
const walk = (n: BaseNode) => {
  if (seen.has(n.nodeId.toString())) return;
  seen.add(n.nodeId.toString());
  for (const r of n.findReferencesEx("HierarchicalReferences", BrowseDirection.Forward)) {
    const c = as.findNode(r.nodeId);
    if (!c || c.nodeId.namespace !== F) continue;
    if (c.nodeClass === NodeClass.Variable) {
      if (c.findReferencesEx("Aggregates", BrowseDirection.Inverse).length > 1) sharedLeft++;
      if (c.browseName.name === "AnalogSignal") {
        units++;
        if (!val(kid(c, "EngineeringUnits"))?.unitId) missingUnits.push(String(c.nodeId.value));
      }
    }
    walk(c);
  }
};
walk(node(plant.enterprise.id)!);
check(sharedLeft === 0, `${sharedLeft} variables still shared between parents`);
check(missingUnits.length === 0, `AnalogSignals without EngineeringUnits: ${missingUnits.slice(0, 5).join(", ")}${missingUnits.length > 5 ? " …" : ""}`);

console.log(`${checks - fails.length}/${checks} checks passed · ${seen.size} nodes reachable from ${plant.enterprise.id} · ${units} AnalogSignals`);
for (const f of fails) console.log(`  ❌ ${f}`);
as.dispose();
process.exitCode = fails.length ? 1 : 0;
