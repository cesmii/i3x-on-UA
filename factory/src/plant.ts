/** Plant definition (factory/plant/*.yaml): types, loading and validation. */
import fs from "node:fs";
import { parse } from "yaml";

export type Quantity = [number, string]; // [value, unit key]
export type Direction = "In" | "Out";

export interface Port { category: string; direction: Direction }
export interface Instrument {
  name: string;
  kind?: "analog" | "onoff" | "control";
  device?: string;   // PA-DIM device ObjectType (default PADIMType)
  signal?: string;   // PA-DIM signal ObjectType (default AnalogSignalType)
  variable?: string; // VariableType override for <signal>/AnalogSignal
  unit?: string;
  range?: [number, number];
  nominal?: number;
}
export type EquipmentKind = "isa95" | "acmeTank" | "pump" | "packml";
export interface Equipment {
  tag: string;
  name: string;
  kind: EquipmentKind;
  class: string;
  vendor?: string;
  model?: string;
  year?: number;
  machinery?: boolean;
  designSpeed?: number;
  properties?: Record<string, Quantity>;
  ratings?: Record<string, Quantity>;
  ports?: Record<string, Port>;
  instruments?: Record<string, Instrument>;
}
export interface Area { id: string; name: string; level: string; equipment: Equipment[] }
export interface Unit { code: string; symbol: string; name: string }
export interface Vendor { manufacturer: string; uri: string }
export interface Plant {
  namespace: string;
  enterprise: { id: string; name: string };
  site: { id: string; name: string };
  units: Record<string, Unit>;
  vendors: Record<string, Vendor>;
  classes: Record<string, { level: string }>;
  areas: Area[];
  links: Array<[string, string]>;
  personnel?: Personnel;
  materials?: Materials;
  orders?: Record<string, WorkRequest>;
}

/** Equipment reference: an equipment tag, or "<site id>/<area id>" for an area or line. */
export type EquipmentRef = string;
export interface Personnel {
  classes: Record<string, { name: string }>;
  persons: Record<string, { name: string; class: string; operates?: EquipmentRef[] }>;
}
export interface MaterialLot {
  definition: string;
  quantity: Quantity;
  status: string;
  storedIn?: EquipmentRef;
  consumedBy?: EquipmentRef[];
  producedBy?: EquipmentRef[];
}
export interface Materials {
  classes: Record<string, { name: string }>;
  definitions: Record<string, { name: string; class: string }>;
  lots: Record<string, MaterialLot>;
}
export interface JobOrder {
  description: string;
  workMaster: string;
  dispatchedTo: EquipmentRef;
  plannedQuantity: Quantity;
  consumes?: string[];
  produces?: string[];
}
export interface WorkRequest { description: string; priority: number; jobOrders: Record<string, JobOrder> }

export function loadPlant(file: string): Plant {
  const plant = parse(fs.readFileSync(file, "utf8")) as Plant;
  for (const a of plant.areas) {
    for (const e of a.equipment) {
      // PackML machines always carry the Machinery building blocks (decision D5)
      if (e.kind === "packml") e.machinery = true;
      if (e.kind === "pump") e.class ??= "Pump";
    }
  }
  const errors = validate(plant);
  if (errors.length) throw new Error(`plant definition ${file} is invalid:\n  - ${errors.join("\n  - ")}`);
  return plant;
}

/** Every equipment item in plant order, with its area. */
export function allEquipment(plant: Plant): Array<{ area: Area; eq: Equipment }> {
  return plant.areas.flatMap((area) => area.equipment.map((eq) => ({ area, eq })));
}

export function validate(plant: Plant): string[] {
  const errs: string[] = [];
  const tags = new Map<string, string>();
  const claim = (tag: string, what: string) => {
    if (tags.has(tag)) errs.push(`duplicate tag ${tag} (${what} and ${tags.get(tag)})`);
    tags.set(tag, what);
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(tag)) errs.push(`tag ${tag}: only letters, digits and '-' allowed`);
  };
  const ports = new Map<string, Port>();
  for (const { area, eq } of allEquipment(plant)) {
    claim(eq.tag, `equipment in ${area.id}`);
    if (!plant.classes[eq.class]) errs.push(`${eq.tag}: unknown class ${eq.class}`);
    if (eq.vendor && !plant.vendors[eq.vendor]) errs.push(`${eq.tag}: unknown vendor ${eq.vendor}`);
    if ((eq.kind === "pump" || eq.kind === "packml" || eq.kind === "acmeTank" || eq.machinery) && !eq.vendor)
      errs.push(`${eq.tag}: ${eq.kind} needs a vendor (Machinery identification)`);
    for (const [k, q] of Object.entries({ ...eq.properties, ...eq.ratings }))
      if (!plant.units[q[1]]) errs.push(`${eq.tag}.${k}: unknown unit ${q[1]}`);
    for (const [name, p] of Object.entries(eq.ports ?? {})) {
      if (p.direction !== "In" && p.direction !== "Out") errs.push(`${eq.tag}.${name}: direction must be In or Out`);
      ports.set(`${eq.tag}.${name}`, p);
    }
    for (const [itag, ins] of Object.entries(eq.instruments ?? {})) {
      claim(itag, `instrument on ${eq.tag}`);
      const kind = ins.kind ?? "analog";
      if (kind === "analog") {
        if (!ins.unit || !plant.units[ins.unit]) errs.push(`${itag}: analog instrument needs a known unit (got ${ins.unit})`);
        if (!ins.range) errs.push(`${itag}: analog instrument needs a range`);
        if (ins.nominal !== undefined && ins.range && (ins.nominal < ins.range[0] || ins.nominal > ins.range[1]))
          errs.push(`${itag}: nominal ${ins.nominal} outside range ${ins.range}`);
      }
    }
  }
  // personnel, materials, orders: every cross-reference must resolve
  const eqRefs = new Set([...allEquipment(plant).map(({ eq }) => eq.tag), ...plant.areas.map((a) => `${plant.site.id}/${a.id}`)]);
  const eqRef = (where: string, r: string | undefined) => { if (r !== undefined && !eqRefs.has(r)) errs.push(`${where}: unknown equipment ${r}`); };
  const idOk = (id: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(id)) errs.push(`id ${id}: only letters, digits and '-' allowed`); };
  const pers = plant.personnel;
  if (pers) for (const [id, p] of Object.entries(pers.persons)) {
    idOk(id);
    if (!pers.classes[p.class]) errs.push(`person ${id}: unknown personnel class ${p.class}`);
    for (const e of p.operates ?? []) eqRef(`person ${id}`, e);
  }
  const mat = plant.materials;
  if (mat) {
    for (const [id, d] of Object.entries(mat.definitions)) if (!mat.classes[d.class]) errs.push(`material ${id}: unknown class ${d.class}`);
    for (const [id, l] of Object.entries(mat.lots)) {
      idOk(id);
      if (!mat.definitions[l.definition]) errs.push(`lot ${id}: unknown definition ${l.definition}`);
      if (!plant.units[l.quantity?.[1]]) errs.push(`lot ${id}: unknown unit ${l.quantity?.[1]}`);
      eqRef(`lot ${id}`, l.storedIn);
      for (const e of [...(l.consumedBy ?? []), ...(l.producedBy ?? [])]) eqRef(`lot ${id}`, e);
    }
  }
  for (const [wr, w] of Object.entries(plant.orders ?? {})) {
    idOk(wr);
    for (const [jo, j] of Object.entries(w.jobOrders)) {
      idOk(jo);
      eqRef(`job order ${jo}`, j.dispatchedTo);
      if (!plant.units[j.plannedQuantity?.[1]]) errs.push(`job order ${jo}: unknown unit ${j.plannedQuantity?.[1]}`);
      for (const l of [...(j.consumes ?? []), ...(j.produces ?? [])]) if (!mat?.lots[l]) errs.push(`job order ${jo}: unknown material lot ${l}`);
    }
  }

  for (const [from, to] of plant.links) {
    const a = ports.get(from), b = ports.get(to);
    if (!a) errs.push(`link ${from} → ${to}: unknown port ${from}`);
    if (!b) errs.push(`link ${from} → ${to}: unknown port ${to}`);
    if (a && b) {
      if (a.direction !== "Out") errs.push(`link ${from} → ${to}: source must be an Out port`);
      if (b.direction !== "In") errs.push(`link ${from} → ${to}: target must be an In port`);
      if (a.category !== b.category) errs.push(`link ${from} → ${to}: category ${a.category} ≠ ${b.category} (Pumps Table 81)`);
    }
  }
  return errs;
}
