/**
 * Print a type's InstanceDeclaration tree (incl. inherited members) with modelling rules.
 *   npx tsx src/tools/inspect-type.ts <NSU-key> <BrowseName> [depth]
 */
import { BrowseDirection, NodeClass } from "node-opcua-data-model";
import type { BaseNode, UAObjectType, UAVariable } from "node-opcua-address-space";
import { loadBase, nsIndex, NSU } from "../lib/load.js";

const [key, name, depthArg] = process.argv.slice(2);
const as = await loadBase();
const type = as.findObjectType(name, nsIndex(as, (NSU as any)[key])) ?? (as.findVariableType(name, nsIndex(as, (NSU as any)[key])) as any);
if (!type) throw new Error("type not found");
const maxDepth = Number(depthArg ?? 3);

function label(n: BaseNode) {
  const rule = (n as any).modellingRule ?? "-";
  const td = n.nodeClass === NodeClass.Object || n.nodeClass === NodeClass.Variable ? (n as any).typeDefinitionObj?.browseName?.toString?.() ?? "" : "";
  const dt = n.nodeClass === NodeClass.Variable ? ` dt=${as.findNode((n as UAVariable).dataType)?.browseName.toString()}` : "";
  return `${n.browseName.toString()} [${NodeClass[n.nodeClass]} ${td}${dt}] {${rule}}`;
}
function walk(n: BaseNode, d: number) {
  if (d > maxDepth) return;
  for (const r of n.findReferencesEx("HierarchicalReferences", BrowseDirection.Forward)) {
    const c = as.findNode(r.nodeId)!;
    if (!c || c.nodeClass === NodeClass.Method && d > 0) continue;
    const rt = as.findNode(r.referenceType)!.browseName.name;
    if (rt === "HasSubtype") continue;
    console.log(`${"  ".repeat(d)}${rt} ${label(c)}`);
    if ((c as any).modellingRule || d === 0) walk(c, d + 1);
  }
}
let t: UAObjectType | null = type;
while (t) {
  console.log(`== ${t.browseName.toString()}${t.isAbstract ? " (abstract)" : ""}`);
  walk(t, 1);
  t = t.subtypeOfObj as UAObjectType | null;
  if (t && t.browseName.name === "BaseObjectType") break;
}
as.dispose();
