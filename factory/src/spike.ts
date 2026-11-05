/**
 * Phase 2 risk spike: can node-opcua load our NodeSets and instantiate every
 * type family the plant needs (incl. the Acme types whose children use
 * Interfaces as TypeDefinitions)? Exports the result to NodeSet2 XML.
 *
 *   npm run spike -w factory
 */
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { AddressSpace, NamespaceOptions, type UAObject, type BaseNode } from "node-opcua-address-space";
import { generateAddressSpace } from "node-opcua-address-space/nodeJS.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const std = (f: string) => path.join(root, "nodesets/standard", f);
const FILES = [
  std("OPC-UA-Core-Model.NodeSet2.xml"),
  std("Unified-Architecture-Device-Model.NodeSet2.xml"),
  std("Industrial-Automation-Basics.NodeSet2.xml"),
  std("IRDI-Dictionary.NodeSet2.xml"),
  std("Process-Automation-Devices-PADIM.NodeSet2.xml"),
  std("Machinery-Basic-Building-Blocks.NodeSet2.xml"),
  std("Machinery-Process-Values.NodeSet2.xml"),
  std("PackML-Packaging-Control.NodeSet2.xml"),
  std("Opc.Ua.Pumps.NodeSet2.xml"),
  std("Opc.ISA95.NodeSet2.xml"),
  path.join(root, "nodesets/vendor/Acme-Mix-Tank-Profile.NodeSet2.xml"),
];
const NS = "https://cesmii.net/i3x-demo/BeverageFactory/";

function ns(as: AddressSpace, uri: string) {
  const i = as.getNamespaceIndex(uri);
  if (i < 0) throw new Error(`namespace not loaded: ${uri}`);
  return i;
}

function tree(node: BaseNode, depth = 0, max = 3, out: string[] = []): string[] {
  if (depth > max) return out;
  for (const ref of node.findReferencesEx("HierarchicalReferences", 0 /* BrowseDirection.Forward */)) {
    const child = node.addressSpace.findNode(ref.nodeId);
    if (!child) continue;
    const td = (child as any).typeDefinitionObj?.browseName?.toString() ?? "";
    const rt = node.addressSpace.findNode(ref.referenceType)?.browseName.name;
    out.push(`${"  ".repeat(depth + 1)}${rt} ${child.browseName.toString()}  [${td}]  ${child.nodeId.toString()}`);
    tree(child, depth + 1, max, out);
  }
  return out;
}

async function main() {
  NamespaceOptions.nodeIdNameSeparator = "/"; // child NodeIds: s=FL-401/Identification/SerialNumber
  const t0 = Date.now();
  const as = AddressSpace.create();
  await generateAddressSpace(as, FILES);
  console.log(`loaded ${FILES.length} nodesets in ${Date.now() - t0} ms`);
  const own = as.registerNamespace(NS);
  const objects = as.rootFolder.objects;

  const MACH = ns(as, "http://opcfoundation.org/UA/Machinery/");
  const cases: Array<[string, () => UAObject]> = [
    ["Acme MixingTankType (interfaces as TypeDefinitions)", () =>
      as.findObjectType("MixingTankType", ns(as, "https://cesmii.net/profiles/AcmeMixTank"))!
        .instantiate({ browseName: { name: "SD-201", namespaceIndex: own.index }, namespace: own, organizedBy: objects, nodeId: `ns=${own.index};s=SD-201` })],
    ["PackML PackMLBaseObjectType", () =>
      as.findObjectType("PackMLBaseObjectType", ns(as, "http://opcfoundation.org/UA/PackML/"))!
        .instantiate({ browseName: { name: "FL-401", namespaceIndex: own.index }, namespace: own, organizedBy: objects, nodeId: `ns=${own.index};s=FL-401` })],
    ["Pumps PumpType", () =>
      as.findObjectType("PumpType", ns(as, "http://opcfoundation.org/UA/Pumps/"))!
        .instantiate({ browseName: { name: "P-101", namespaceIndex: own.index }, namespace: own, organizedBy: objects, nodeId: `ns=${own.index};s=P-101`, optionals: ["Ports"] })],
    ["PA-DIM PADIMType", () =>
      as.findObjectType("PADIMType", ns(as, "http://opcfoundation.org/UA/PADIM/"))!
        .instantiate({ browseName: { name: "LT-101", namespaceIndex: own.index }, namespace: own, organizedBy: objects, nodeId: `ns=${own.index};s=LT-101` })],
    ["ISA-95 EquipmentType", () =>
      as.findObjectType("EquipmentType", ns(as, "http://www.OPCFoundation.org/UA/2013/01/ISA95"))!
        .instantiate({ browseName: { name: "T-101", namespaceIndex: own.index }, namespace: own, organizedBy: objects, nodeId: `ns=${own.index};s=T-101` })],
    ["Machinery MachineIdentificationType as AddIn on FL-401", () => {
      const fl = as.findNode(`ns=${own.index};s=FL-401`) as UAObject;
      return as.findObjectType("MachineIdentificationType", MACH)!.instantiate({
        browseName: { name: "Identification", namespaceIndex: ns(as, "http://opcfoundation.org/UA/DI/") },
        namespace: own, nodeId: `ns=${own.index};s=FL-401/Identification`,
        references: [{ referenceType: "HasAddIn", isForward: false, nodeId: fl.nodeId }],
      });
    }],
    ["Machinery MachineryItemState_StateMachineType as AddIn on FL-401", () => {
      const fl = as.findNode(`ns=${own.index};s=FL-401`) as UAObject;
      return as.findObjectType("MachineryItemState_StateMachineType", MACH)!.instantiate({
        browseName: { name: "MachineryItemState", namespaceIndex: MACH },
        namespace: own, nodeId: `ns=${own.index};s=FL-401/MachineryItemState`,
        references: [{ referenceType: "HasAddIn", isForward: false, nodeId: fl.nodeId }],
      });
    }],
  ];

  let failures = 0;
  for (const [label, make] of cases) {
    try {
      const obj = make();
      const lines = tree(obj, 0, 2);
      console.log(`\n✅ ${label}: ${obj.nodeId.toString()} (${lines.length} nodes within depth 3)`);
      console.log(lines.slice(0, 25).join("\n") + (lines.length > 25 ? `\n    … ${lines.length - 25} more` : ""));
    } catch (e) {
      failures++;
      console.log(`\n❌ ${label}:`, e);
    }
  }

  const xml = own.toNodeset2XML();
  const out = path.join(root, "factory/out/spike.NodeSet2.xml");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, xml);
  console.log(`\nexported own namespace: ${out} (${(xml.length / 1024).toFixed(0)} KiB)`);
  as.dispose();

  // Round trip: the exported instance NodeSet must load on top of the standard ones.
  const as2 = AddressSpace.create();
  await generateAddressSpace(as2, [...FILES, out]);
  const i2 = as2.getNamespaceIndex(NS);
  const reloaded = ["SD-201", "FL-401", "P-101", "LT-101", "T-101", "FL-401/Identification", "SD-201/Component/Drive/OutputHz"]
    .map((s) => [s, !!as2.findNode(`ns=${i2};s=${s}`)] as const);
  for (const [s, ok] of reloaded) console.log(`${ok ? "✅" : "❌"} reload ${s}`);
  if (reloaded.some(([, ok]) => !ok)) failures++;
  as2.dispose();
  process.exitCode = failures ? 1 : 0;
}

main().catch((e) => { console.error(e); process.exit(1); });
