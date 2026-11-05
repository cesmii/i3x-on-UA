/**
 * Writes simulator readings into the OPC UA address space. Keys are our NodeId paths
 * (`ns=<factory>;s=<key>`), so the binding needs no per-signal configuration.
 *
 * - plain values: coerced to the variable's built-in DataType (Float vs Double, Int32 enums, …)
 * - { state }: a FiniteStateMachine's CurrentState (+ Id, + Number when present). An empty state
 *   marks an inactive PackML sub-state machine: written as Bad_StateNotActive (OPC 10000-16).
 * - { packmlCount } / { packmlAlarm }: PackML structures as ExtensionObjects.
 * Quality overrides (scenario layer): Bad codes replace the value with null; Uncertain codes keep the
 * (last usable) value and only change the StatusCode.
 */
import {
  type AddressSpace, type BaseNode, type UAObject, type UAObjectType, type UAVariable,
} from "node-opcua-address-space";
import { DataType, LocalizedText, NodeClass, StatusCode, StatusCodes, Variant, VariantArrayType, makeEUInformation } from "node-opcua";
import type { Reading } from "./model.js";

const NUMERIC = new Set([DataType.SByte, DataType.Byte, DataType.Int16, DataType.UInt16, DataType.Int32, DataType.UInt32,
  DataType.Int64, DataType.UInt64, DataType.Float, DataType.Double]);
const INTEGER = new Set([DataType.SByte, DataType.Byte, DataType.Int16, DataType.UInt16, DataType.Int32, DataType.UInt32, DataType.Int64, DataType.UInt64]);
const PIECE = makeEUInformation("H87", "pce", "piece");

interface Bound { node: BaseNode; last?: string; historized?: boolean }

export class UaBinder {
  private readonly ns: number;
  private readonly cache = new Map<string, Bound | null>();
  private readonly packmlNs: number;
  readonly missing = new Set<string>();

  constructor(private readonly as: AddressSpace, factoryUri: string, private readonly opts: { historyValues: number }) {
    this.ns = as.getNamespaceIndex(factoryUri);
    this.packmlNs = as.getNamespaceIndex("http://opcfoundation.org/UA/PackML/");
  }

  private bound(key: string): Bound | null {
    if (this.cache.has(key)) return this.cache.get(key)!;
    const node = this.as.findNode(`ns=${this.ns};s=${key}`);
    if (!node) this.missing.add(key);
    const b = node ? { node } : null;
    this.cache.set(key, b);
    return b;
  }

  private historize(b: Bound, v: UAVariable) {
    if (b.historized || this.opts.historyValues <= 0) return;
    this.as.installHistoricalDataNode(v, { maxOnlineValues: this.opts.historyValues });
    b.historized = true;
  }

  write(readings: Map<string, Reading>, ts: Date, quality: (key: string) => StatusCode | undefined = () => undefined) {
    for (const [key, value] of readings) {
      const b = this.bound(key);
      if (!b) continue;
      const q = quality(key);
      if (typeof value === "object" && "state" in value) this.writeState(b, value.state, ts, q);
      else this.writeValue(b, b.node as UAVariable, value, ts, q);
    }
  }

  private writeValue(b: Bound, v: UAVariable, value: Reading, ts: Date, q?: StatusCode) {
    if (v.nodeClass !== NodeClass.Variable) return;
    let variant: Variant;
    if (q && q !== StatusCodes.Good && !q.name.startsWith("Uncertain")) {
      variant = new Variant({ dataType: DataType.Null });       // Bad: no value
    } else if (typeof value === "object" && "packmlCount" in value) {
      const dt = v.dataType;
      const items = value.packmlCount.map((c) => this.as.constructExtensionObject(dt, { ID: c.id, name: c.name, unit: PIECE, count: c.count, accCount: c.acc }));
      variant = new Variant({ dataType: DataType.ExtensionObject, arrayType: VariantArrayType.Array, value: items });
    } else if (typeof value === "object" && "packmlAlarm" in value) {
      const a = value.packmlAlarm;
      variant = new Variant({ dataType: DataType.ExtensionObject, value: this.as.constructExtensionObject(v.dataType, {
        ID: a.id, value: a.value, message: a.message, category: a.id === 0 ? 0 : a.id < 200 ? 2 : 1, dateTime: a.id ? ts : new Date(0), trigger: a.id !== 0 }) });
    } else if (typeof value === "number") {
      let dt = v.getBasicDataType();
      if (!NUMERIC.has(dt)) dt = DataType.Double; // abstract Number / Duration
      variant = new Variant({ dataType: dt, value: INTEGER.has(dt) ? Math.round(value) : value });
    } else if (typeof value === "boolean") {
      variant = new Variant({ dataType: DataType.Boolean, value });
    } else {
      variant = new Variant({ dataType: DataType.String, value: String(value) });
    }
    // constants and slow values: only write on change, so history stays meaningful
    const sig = q ? `q:${q.name}` : JSON.stringify(variant.value);
    if (b.last === sig) return;
    b.last = sig;
    this.historize(b, v);
    v.setValueFromSource(variant, q ?? StatusCodes.Good, ts);
  }

  private writeState(b: Bound, state: string, ts: Date, q?: StatusCode) {
    if (b.last === state && !q) return;
    b.last = state;
    const sm = b.node as UAObject;
    const cur = sm.getComponentByName("CurrentState") as UAVariable | null;
    if (!cur) return;
    this.historize(b, cur);
    if (!state) { // inactive sub-state machine
      cur.setValueFromSource(new Variant({ dataType: DataType.Null }), StatusCodes.BadStateNotActive, ts);
      return;
    }
    const stateNode = this.findState(sm.typeDefinitionObj as UAObjectType, state);
    cur.setValueFromSource(new Variant({ dataType: DataType.LocalizedText, value: new LocalizedText({ locale: "", text: state }) }), q ?? StatusCodes.Good, ts);
    const id = cur.getPropertyByName("Id");
    if (id && stateNode) id.setValueFromSource(new Variant({ dataType: DataType.NodeId, value: stateNode.nodeId }), StatusCodes.Good, ts);
    const num = cur.getPropertyByName("Number");
    const sn = stateNode && (stateNode as UAObject).getPropertyByName("StateNumber");
    if (num && sn) num.setValueFromSource(new Variant({ dataType: DataType.UInt32, value: sn.readValue().value.value }), StatusCodes.Good, ts);
  }

  /** States are declared on the state machine's type (or a supertype); no ModellingRule, so not on the instance. */
  private findState(type: UAObjectType | null, name: string): BaseNode | null {
    for (let t = type; t; t = t.subtypeOfObj as UAObjectType | null) {
      const s = t.getComponentByName(name);
      if (s) return s;
    }
    return null;
  }
}
