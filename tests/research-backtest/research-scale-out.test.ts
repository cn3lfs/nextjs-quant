import { expect, it } from "vitest";
import { type ResearchEvent } from "../../src/lib/research/strategy-research";
import { researchManagementSchema } from "../../src/lib/research/workflow/research-management";
import {
  sellQuantity as researchSellQuantity,
  type ExecutionRules as ResearchExecutionRules,
} from "quant-backtest/execution";
import {
  researchMarketEvidenceSchema,
  researchEvidenceLookup,
} from "trading-strategies/research/factors/research-market-evidence";
import { researchMethodSnapshot } from "../../src/server/research/research-method";

const dates = Array.from(
  { length: 7 },
  (_, i) => `2024-01-${String(i + 2).padStart(2, "0")}`,
);
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: dates[0]!,
  endpointDate: dates[0]!,
  key: "fixture",
  strategyVersion: "fixture",
  evidence: "{}",
  partition: "development",
};
const rules: ResearchExecutionRules = {
  evidence: "fixture",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 10000,
  tradable: true,
  limitUp: null,
  limitDown: null,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 10000,
  sellOddLotAll: true,
};

it("sell-quantity rules are independent of buy minima and honor odd-lot policy", () => {
  expect(
    researchSellQuantity(100, 100, { ...rules, minimumBuy: 200, buyStep: 1 }),
  ).toBe(100);
  expect(researchSellQuantity(33, 100, rules)).toBe(0);
  expect(researchSellQuantity(101, 101, rules)).toBe(101);
  expect(
    researchSellQuantity(101, 101, { ...rules, sellOddLotAll: false }),
  ).toBe(100);
});

it("freezes scale-out sources separately and validates proportions and complete sell evidence", () => {
  expect(researchManagementSchema.parse({})).not.toHaveProperty("scaleOut");
  expect(
    researchManagementSchema.safeParse({
      scaleOut: [
        { atR: 2, fraction: 0.8, raiseStopR: 0 },
        { atR: 1, fraction: 0.8, raiseStopR: 3 },
      ],
    }).success,
  ).toBe(false);
  const method = researchMethodSnapshot("dual-breakout", true, true);
  expect(
    method.sources.some(
      (row) => row.path === "stop-loss/references/management.md",
    ),
  ).toBe(true);
  expect(researchMethodSnapshot("dual-breakout", true, true)).toEqual(method);
  const payload = {
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    rows: [
      { ...rules, symbol: event.symbol, date: dates[1], evidenceId: "fixture" },
    ],
  };
  const evidence = researchMarketEvidenceSchema.parse(payload);
  expect(
    researchEvidenceLookup(evidence)(event.symbol, dates[1]!)!.sellStep,
  ).toBe(100);
  expect(
    researchMarketEvidenceSchema.safeParse({
      ...payload,
      rows: [{ ...payload.rows[0], maximumSell: undefined }],
    }).success,
  ).toBe(false);
});
