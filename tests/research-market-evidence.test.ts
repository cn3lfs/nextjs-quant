import { expect, it } from "vitest";
import {
  researchEvidenceLookup,
  researchMarketEvidenceSchema,
} from "../src/lib/research-market-evidence";
const row = {
  symbol: "sh600000",
  date: "2024-01-02",
  tradable: true,
  limitUp: 11,
  limitDown: 9,
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 1000000,
  evidenceId: "source-row-1",
};
const input = {
  version: "research-market-evidence-1",
  source: "imported-test-provider",
  exportedAt: 1,
  adjustment: "none",
  rows: [row],
};
it("matches historical rules by both stock and date without falling back to current state", () => {
  const lookup = researchEvidenceLookup(
    researchMarketEvidenceSchema.parse(input),
  );
  expect(lookup(row.symbol, row.date)?.limitUp).toBe(11);
  expect(lookup(row.symbol, "2024-01-03")).toBeNull();
  expect(lookup("sh600001", row.date)).toBeNull();
});
it("rejects duplicate days, inverted limits, invalid dates and adjustment mismatch", () => {
  for (const invalid of [
    { ...input, rows: [row, row] },
    { ...input, rows: [{ ...row, limitDown: 12 }] },
    { ...input, rows: [{ ...row, date: "2024-02-30" }] },
    { ...input, adjustment: "forward" },
  ])
    expect(researchMarketEvidenceSchema.safeParse(invalid).success).toBe(false);
});
