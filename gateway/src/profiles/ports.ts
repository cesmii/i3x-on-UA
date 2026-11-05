/**
 * Profile (opt-in, `synthesizeFlow`): material flow from OPC 40223 Pumps ports.
 * The Pumps spec gives each port a `Direction` (PortDirectionEnum In 0 / Out 1 / InOut 2) but defines
 * no reference for connecting ports; DI `ConnectsTo` (symmetric) is used by convention. This profile
 * turns each Out→In `ConnectsTo` into FlowsTo/FedBy between the equipment that owns the ports.
 * It is the only companion-spec knowledge in the gateway, and it is switchable.
 */
import type { Crawler, UaModel } from "../ua/crawl.js";
import { GW_NS, type Projection } from "../i3x/project.js";

const DI = "http://opcfoundation.org/UA/DI/";

export async function synthesizeFlow(p: Projection, m: UaModel, c: Crawler) {
  const connectsTo = [...m.refTypes.values()].find((r) => r.browseName.ns === DI && r.browseName.name === "ConnectsTo");
  if (!connectsTo) return;
  const rel = p.typeId(connectsTo.id);
  const pairs: Array<[string, string]> = [];
  for (const [from, list] of p.edges) for (const e of list) if (e.rel === rel && from < e.target) pairs.push([from, e.target]);
  if (!pairs.length) return;

  // Direction value of each port (a DataVariable child named "Direction")
  const ports = [...new Set(pairs.flat())];
  const dirNode = new Map<string, string>();
  for (const port of ports) {
    const d = m.nodes.get(port)?.refs.map((r) => m.nodes.get(r.target)).find((n) => n?.browseName.name === "Direction" && n.nodeClass === "Variable");
    if (d) dirNode.set(port, d.id);
  }
  const vals = await c.readValues([...dirNode.values()]);
  const dir = new Map([...dirNode.keys()].map((port, i) => [port, Number(vals[i].value?.value)]));
  // owner = the Object holding the port group ("Ports"): port → Ports → equipment
  const owner = (port: string) => {
    const group = p.objects.get(port)?.parentId;
    return group ? p.objects.get(group)?.parentId ?? group : undefined;
  };

  let n = 0;
  for (const [a, b] of pairs) {
    const [out, inn] = dir.get(a) === 1 && dir.get(b) !== 1 ? [a, b] : dir.get(b) === 1 && dir.get(a) !== 1 ? [b, a] : [undefined, undefined];
    if (!out || !inn) continue;
    const src = owner(out), dst = owner(inn);
    if (!src || !dst || src === dst) continue;
    p.edge(src, "FlowsTo", dst);
    p.edge(dst, "FedBy", src);
    n++;
  }
  const detail = "Synthesized by the gateway: two Objects whose Pumps ports (OPC 40223 PortType) are joined by DI ConnectsTo, oriented by the ports' Direction (Out → In). Not an OPC UA reference.";
  const meta = { opcua: { role: "synthesized", basedOn: [rel, "Pumps:PortType/Direction"], fidelity: [{ aspect: "relationship", loss: "synthesized", detail }] } };
  p.registerRel("FlowsTo", "FedBy", GW_NS, null, "synthesized", false, { description: "Material flows from this Object to the target (synthesized from port connections).", ...meta });
  p.registerRel("FedBy", "FlowsTo", GW_NS, null, "synthesized", false, { description: "Inverse of FlowsTo.", ...meta });
  p.stats.flowLinks = n;
}
