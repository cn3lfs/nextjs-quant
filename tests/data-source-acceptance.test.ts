import { expect, it } from "vitest";
import {
  sourceAcceptanceSamples,
  sourceAcceptancePeriods,
  validateWestockBatch,
} from "./data-source-acceptance";
const rows = ["2026-09-10", "2026-09-11", "2026-09-14"].map((date) => ({
  symbol: "sh000001",
  date,
  open: 10,
  last: 11,
  high: 12,
  low: 9,
  volume: 100,
  amount: 1000,
}));
it("requires eight asset classes and three representative periods", () => {
  expect(sourceAcceptanceSamples.map((r) => r.kind)).toEqual([
    "sh-main",
    "sz-main",
    "chinext",
    "star",
    "beijing",
    "index",
    "sector",
    "etf",
  ]);
  expect(sourceAcceptancePeriods).toEqual(["day", "week", "5m"]);
});
it("detects the observed mixed-batch ETF omission despite other successful rows", () => {
  const result = validateWestockBatch(rows, ["sh000001", "sh510300"], "day");
  expect(result[0]?.ok).toBe(true);
  expect(result[1]).toEqual({
    symbol: "sh510300",
    ok: false,
    reason: "批量响应遗漏品种",
  });
});
it("rejects wrong identities, duplicated dates and invalid OHLC", () => {
  expect(() => validateWestockBatch(rows, ["sh510300"], "day")).toThrow("身份");
  expect(
    validateWestockBatch([rows[0], rows[0], rows[1]], ["sh000001"], "day")[0]
      ?.ok,
  ).toBe(false);
  expect(
    validateWestockBatch(
      rows.map((r) => ({ ...r, high: 1 })),
      ["sh000001"],
      "day",
    )[0]?.ok,
  ).toBe(false);
});
