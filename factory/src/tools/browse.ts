/**
 * Browse a running server like a generic OPC UA client would (only OPC UA services, no model knowledge).
 *   npx tsx src/tools/browse.ts [endpoint] [startNodeId] [depth]
 */
import { AttributeIds, BrowseDirection, NodeClass, OPCUAClient, resolveNodeId, type ClientSession } from "node-opcua";

const endpoint = process.argv[2] ?? "opc.tcp://localhost:4840/UA/BeverageFactory";
const start = process.argv[3] ?? "i=85";
const maxDepth = Number(process.argv[4] ?? 3);

const client = OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 30, initialDelay: 500, maxDelay: 2000 } });
await client.connect(endpoint);
const session: ClientSession = await client.createSession();
const nsArray: string[] = (await session.readNamespaceArray());

async function walk(nodeId: string, depth: number) {
  if (depth > maxDepth) return;
  const res = await session.browse({ nodeId, browseDirection: BrowseDirection.Forward, referenceTypeId: "HierarchicalReferences",
    includeSubtypes: true, nodeClassMask: 0, resultMask: 63 });
  for (const r of res.references ?? []) {
    if (r.nodeId.namespace === 0 && depth === 0 && r.browseName.name !== "Objects" && nodeId !== "i=85") continue;
    if (r.nodeId.namespace === 0 && ["Server", "Aliases", "Locations", "FileSystem", "Dictionaries"].includes(r.browseName.name!)) continue;
    const refName = (await session.read({ nodeId: r.referenceTypeId, attributeId: AttributeIds.BrowseName })).value.value.name;
    let val = "";
    if (r.nodeClass === NodeClass.Variable) {
      const dv = await session.read({ nodeId: r.nodeId, attributeId: AttributeIds.Value });
      const v = dv.value.value;
      val = ` = ${v?.text ?? (typeof v === "object" && v !== null ? JSON.stringify(v).slice(0, 60) : v)}`;
    }
    const td = r.typeDefinition && !r.typeDefinition.isEmpty() ? (await session.read({ nodeId: r.typeDefinition, attributeId: AttributeIds.BrowseName })).value.value.name : "";
    console.log(`${"  ".repeat(depth)}${refName} ${r.displayName.text}${td ? ` [${td}]` : ""}${val}`);
    if (r.nodeClass === NodeClass.Object) await walk(r.nodeId.toString(), depth + 1);
  }
}
console.log(`connected to ${endpoint}; ${nsArray.length} namespaces`);
const startId = start.startsWith("nsu=")
  ? `ns=${nsArray.indexOf(start.slice(4, start.indexOf(";")))};${start.slice(start.indexOf(";") + 1)}`
  : resolveNodeId(start).toString();
await walk(startId, 0);
await session.close();
await client.disconnect();
