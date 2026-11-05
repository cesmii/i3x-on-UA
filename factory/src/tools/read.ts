/**
 * Read live values (and optionally history) from the running server like a generic client.
 *   npx tsx src/tools/read.ts [--history <seconds>] <path> [<path> ...]
 * <path> is a NodeId path in the factory namespace, e.g. FL-401/Status/CurMachSpeed
 */
import { AttributeIds, OPCUAClient, TimestampsToReturn } from "node-opcua";

const args = process.argv.slice(2);
let history = 0;
if (args[0] === "--history") { history = Number(args[1]); args.splice(0, 2); }
const endpoint = process.env.OPCUA_ENDPOINT ?? "opc.tcp://localhost:4840/UA/BeverageFactory";
const NSU = "https://cesmii.net/i3x-demo/BeverageFactory/";

const client = OPCUAClient.create({ endpointMustExist: false, connectionStrategy: { maxRetry: 30, initialDelay: 500, maxDelay: 2000 } });
await client.connect(endpoint);
const session = await client.createSession();
const ns = (await session.readNamespaceArray()).indexOf(NSU);
const fmt = (v: any): string => {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return `[${Array.from(v as any[]).map(fmt).join(", ")}]`;
  if (typeof v === "object" && "text" in v) return v.text ?? "";
  if (typeof v === "object" && "count" in v) return `{${v.name}: count ${v.count}}`;
  if (typeof v === "object" && "message" in v) return `{ID ${v.ID}: "${v.message}"}`;
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(3);
  return String(v);
};
const dvs = await session.read(args.map((p) => ({ nodeId: `ns=${ns};s=${p}`, attributeId: AttributeIds.Value })), TimestampsToReturn.Both);
args.forEach((p, i) => {
  const dv = dvs[i];
  console.log(`${p.padEnd(62)} ${fmt(dv.value.value).padEnd(28)} ${dv.statusCode.name.padEnd(20)} ${dv.sourceTimestamp?.toISOString() ?? "-"}`);
});
if (history > 0) {
  const end = new Date(), start = new Date(end.getTime() - history * 1000);
  const res = await session.readHistoryValue(args.map((p) => `ns=${ns};s=${p}`), start, end);
  res.forEach((r, i) => {
    const vals = ((r.historyData as any)?.dataValues ?? []).filter((d: any) => d.statusCode.name !== "BadBoundNotFound"); // drop window-bound markers
    console.log(`history ${args[i]}: ${r.statusCode.name}, ${vals.length} values${vals.length ? `, first ${fmt(vals[0].value.value)} @ ${vals[0].sourceTimestamp.toISOString()}, last ${fmt(vals.at(-1).value.value)}` : ""}`);
  });
}
await session.close();
await client.disconnect();
