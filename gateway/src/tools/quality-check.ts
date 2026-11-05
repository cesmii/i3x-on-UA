/** Offline check of the StatusCode → i3X quality mapping (MAPPING §7). */
import { StatusCodes, StatusCode } from "node-opcua";
import { ValueService } from "../i3x/values.js";
const mk = (q: "detailed" | "base") => new ValueService({} as never, {} as never, {} as never, { quality: q } as never);
const cases: Array<[string, StatusCode, boolean]> = [
  ["Good", StatusCodes.Good, false], ["GoodNoData", StatusCodes.GoodNoData, true], ["BadNotConnected", StatusCodes.BadNotConnected, true],
  ["BadStateNotActive", StatusCodes.BadStateNotActive, true], ["UncertainLastUsableValue", StatusCodes.UncertainLastUsableValue, false],
  ["Good + null value", StatusCodes.Good, true], ["Good#HistorianInterpolated", StatusCode.makeStatusCode(StatusCodes.Good, "HistorianInterpolated"), false],
];
for (const [label, sc, isNull] of cases) console.log(label.padEnd(30), "detailed:", mk("detailed").quality(sc, isNull).padEnd(28), "base:", mk("base").quality(sc, isNull));
