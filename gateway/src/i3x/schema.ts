/** OPC UA DataType (+ ValueRank) → JSON Schema 2020-12, per docs/gateway/MAPPING.md §5. */
import type { Interpretation } from "../config.js";
import type { UaModel } from "../ua/crawl.js";

export type JsonSchema = Record<string, unknown>;

const INT_RANGE: Record<string, [number, number]> = {
  "i=2": [-128, 127], "i=3": [0, 255], "i=4": [-32768, 32767], "i=5": [0, 65535], "i=6": [-2147483648, 2147483647], "i=7": [0, 4294967295],
};

export class SchemaMapper {
  constructor(private readonly m: UaModel, private readonly policy: Interpretation) {}

  /** The nearest built-in DataType (i=1…29) at or above `id`. */
  builtin(id: string | undefined): string {
    for (let t = id, g = 0; t && g < 64; t = this.m.dataTypes.get(t)?.supertype, g++) if (/^i=([1-9]|1\d|2\d)$/.test(t)) return t;
    return "i=24";
  }
  name(id: string | undefined) { return id ? this.m.dataTypes.get(id)?.browseName.name ?? id : "BaseDataType"; }
  isEnum(id: string | undefined) {
    const dt = id ? this.m.dataTypes.get(id) : undefined;
    return dt?.kind === "enum" || this.builtin(id) === "i=29";
  }

  /** Schema for a value of DataType `id` with ValueRank `vr` (not yet nullable). */
  forType(id: string | undefined, vr = -1, depth = 0): JsonSchema {
    const base = this.scalar(id, depth);
    if (vr === -1) return base;
    if (vr >= 1) {
      let s: JsonSchema = base;
      for (let i = 0; i < vr; i++) s = { type: "array", items: s };
      return s;
    }
    return { anyOf: [base, { type: "array", items: base }] };   // -2 any, -3 scalar or 1-D, 0 ≥1 dims
  }

  private scalar(id: string | undefined, depth: number): JsonSchema {
    const dt = id ? this.m.dataTypes.get(id) : undefined;
    const title = dt?.browseName.name;
    if (dt?.kind === "enum" && dt.enumValues) {
      return this.policy.enums === "name"
        ? { type: "string", title, enum: dt.enumValues.map((e) => e.name) }
        : { type: "integer", title, oneOf: dt.enumValues.map((e) => ({ const: e.value, title: e.name, ...(e.description ? { description: e.description } : {}) })) };
    }
    if (dt?.kind === "structure" && dt.fields && depth < 6) {
      return {
        type: "object", title,
        properties: Object.fromEntries(dt.fields.map((f) => [f.name, { ...this.forType(f.dataType, f.valueRank, depth + 1), ...(f.description ? { description: f.description } : {}) }])),
        required: dt.fields.filter((f) => !f.isOptional).map((f) => f.name),
      };
    }
    const b = this.builtin(id);
    const t = (x: JsonSchema) => (title && title !== this.name(b) ? { ...x, title } : x);
    switch (b) {
      case "i=1": return t({ type: "boolean" });
      case "i=2": case "i=3": case "i=4": case "i=5": case "i=6": case "i=7": {
        const [min, max] = INT_RANGE[b];
        return t({ type: "integer", minimum: min, maximum: max });
      }
      case "i=8": case "i=9":
        return t(this.policy.int64 === "string" ? { type: "string", pattern: b === "i=8" ? "^-?[0-9]+$" : "^[0-9]+$" } : { type: "integer" });
      case "i=27": case "i=28": return t({ type: "integer" });
      case "i=10": case "i=11": case "i=26": return t({ type: "number" });
      case "i=12": return t({ type: "string" });
      case "i=13": return t({ type: "string", format: "date-time" });
      case "i=14": return t({ type: "string", format: "uuid" });
      case "i=15": return t({ type: "string", contentEncoding: "base64" });
      case "i=16": return t({ type: "string", contentMediaType: "application/xml" });
      case "i=17": case "i=18": return t({ type: "string", description: "OPC UA NodeId (nsu= form)" });
      case "i=19": return t({ type: "string", description: "OPC UA StatusCode symbolic name" });
      case "i=20": return t({ type: "string", description: "OPC UA QualifiedName (<ns>:<Name>)" });
      case "i=21": return t({ type: "string", description: "OPC UA LocalizedText (text only)" });
      case "i=29": return t(this.policy.enums === "name" ? { type: "string" } : { type: "integer" });
      case "i=22": return t({ type: "object" });
      default: return title ? { title } : {};
    }
  }

  nullable(s: JsonSchema): JsonSchema {
    if (s.oneOf || s.enum) return { anyOf: [s, { type: "null" }] };       // null must not be tested against the enum
    if (typeof s.type === "string") return { ...s, type: [s.type, "null"] };
    if (s.anyOf || s.oneOf || !s.type) return { anyOf: [s, { type: "null" }] };
    return s;
  }
}
