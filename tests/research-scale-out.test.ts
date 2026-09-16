import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import {
  researchScaleOutPreset,
  researchManagementSchema,
} from "../src/lib/research-management";
import {
  researchSellQuantity,
  type ResearchExecutionRules,
} from "../src/lib/research-execution";
import {
  researchMarketEvidenceSchema,
  researchEvidenceLookup,
} from "../src/lib/research-market-evidence";
import { researchPortfolio } from "../src/server/research-portfolio";
import { projectResearchWeights } from "../src/lib/weight-backtest";
import {
  researchMethodSnapshot,
  validateResearchMethod,
} from "../src/server/research-method";

const dates = Array.from(
  { length: 7 },
  (_, i) => `2024-01-${String(i + 2).padStart(2, "0")}`,
);
const spec = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: dates[0],
  end: dates[6],
  validationStart: dates[5],
  initialCapital: 40000,
  maxPositions: 1,
  holdingDays: 60,
  risk: { fraction: 0.04, maxWeight: 1 },
  management: { scaleOut: researchScaleOutPreset },
  costs: {
    commissionBps: 0,
    minimumCommission: 5,
    sellTaxBps: 10,
    slippageBps: 0,
  },
});
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
function bars(
  opens = [100, 100, 110, 120, 117, 90],
  closes = [100, 110, 120, 117, 114, 91],
): Bar[] {
  return opens.map((open, i) => ({
    date: dates[i]!,
    open,
    close: closes[i]!,
    high: Math.max(open, closes[i]!) + 1,
    low: Math.min(open, closes[i]!) - 1,
    volume: 10000,
    amount: 1000000,
  }));
}
function run(
  input = bars(),
  config = spec,
  daily: (date: string) => ResearchExecutionRules = () => rules,
) {
  return researchPortfolio(
    config,
    [event],
    input.map((bar) => bar.date),
    new Map([[event.symbol, input]]),
    (_, date) => daily(date),
  );
}

it("accounts for partial sales, per-order fees, remaining NAV and one closed outcome under a gap", () => {
  const result = run();
  const trade = result.trades[0]!;
  expect(trade.quantity).toBe(300);
  expect(
    trade.sales!.map((sale) => [
      sale.date,
      sale.quantity,
      sale.price,
      sale.commission,
      sale.tax,
    ]),
  ).toEqual([
    [dates[2], 100, 110, 5, 11],
    [dates[3], 100, 120, 5, 12],
    [dates[5], 100, 90, 5, 9],
  ]);
  expect(trade.sales![0]!.triggerDate).toBe(dates[1]);
  expect(trade.stopHistory!.map((row) => [row.date, row.stop])).toEqual([
    [dates[1], 95],
    [dates[2], 100],
    [dates[3], 115],
  ]);
  expect(trade).toMatchObject({
    remainingQuantity: 0,
    profit: 1948,
    realizedProfit: 1948,
    exitDate: dates[5],
  });
  expect(trade.exitPrice).toBeCloseTo(320 / 3);
  expect(trade.netReturn).toBeCloseTo(1948 / 30005);
  expect(result.nav.map((point) => point.value)).toEqual([
    40000, 42995, 44979, 44662, 44362, 41948,
  ]);
  expect(result.statistics.count).toBe(1);
  const weights = projectResearchWeights(
    result,
    new Map([[event.symbol, bars()]]),
  ).rows;
  expect(weights.map((row) => row.weight)).toEqual([
    0,
    33000 / 42995,
    24000 / 44979,
    11700 / 44662,
    11400 / 44362,
    0,
  ]);
  const open = run(bars().slice(0, 4));
  expect(open.trades[0]).toMatchObject({
    remainingQuantity: 100,
    profit: null,
    netReturn: null,
    exitDate: null,
  });
  expect(open.statistics.count).toBe(0);
  expect(open.trades[0]!.realizedProfit).toBeCloseTo(22967 - (30005 * 2) / 3);
  const waiting = run(bars().slice(0, 2));
  expect(waiting.pendingSales).toEqual([
    {
      symbol: event.symbol,
      remainingQuantity: 300,
      targetQuantity: 100,
      triggerDate: dates[1],
      reason: "第1档待卖",
    },
  ]);
});

it("a blocked target never lifts stops; full stop exit supersedes an unfilled partial", () => {
  const input = bars([100, 100, 110, 90], [100, 110, 90, 91]);
  const result = run(input, spec, (date) => ({
    ...rules,
    tradable: date !== dates[2],
  }));
  expect(result.trades[0]!.sales!.map((sale) => sale.quantity)).toEqual([300]);
  expect(result.trades[0]!.stopHistory).toHaveLength(1);
  expect(result.trades[0]!.exitReason).toContain("失守");
  expect(
    result.attempts.some((row) => row.date === dates[2] && row.side === "sell"),
  ).toBe(true);
});

it("respects independent sell limits, retains pending liquidation and refuses missing sell evidence", () => {
  const limited = run(bars(), { ...spec, holdingDays: 1 }, () => ({
    ...rules,
    maximumSell: 100,
  }));
  expect(
    limited.trades[0]!.sales!.map((sale) => [sale.date, sale.quantity]),
  ).toEqual([
    [dates[2], 100],
    [dates[3], 100],
    [dates[4], 100],
  ]);
  expect(limited.trades[0]!.exitDate).toBe(dates[4]);
  expect(limited.statistics.count).toBe(1);
  expect(
    run(bars(), spec, () => ({ ...rules, sellStep: undefined })).excluded[0]!
      .reason,
  ).toContain("卖出数量规则");
  expect(
    researchSellQuantity(100, 100, { ...rules, minimumBuy: 200, buyStep: 1 }),
  ).toBe(100);
  expect(researchSellQuantity(33, 100, rules)).toBe(0);
  expect(researchSellQuantity(101, 101, rules)).toBe(101);
  expect(
    researchSellQuantity(101, 101, { ...rules, sellOddLotAll: false }),
  ).toBe(100);
});

it("never creates a fill or lifts a stop for sub-lot targets; highs alone do not trigger a close rule", () => {
  const small = run(bars(), {
    ...spec,
    risk: { fraction: 0.015, maxWeight: 1 },
  });
  expect(small.trades[0]!.quantity).toBe(100);
  expect(small.trades[0]!.stopHistory).toHaveLength(1);
  expect(
    small.trades[0]!.managementWarnings!.some((row) =>
      row.reason.includes("跳过该档"),
    ),
  ).toBe(true);
  const input = bars([100, 100, 100], [100, 100, 100]);
  input[1]!.high = 150;
  expect(run(input).trades[0]!.sales).toEqual([]);
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
  expect(() =>
    validateResearchMethod("dual-breakout", method, true, true),
  ).not.toThrow();
  expect(() => validateResearchMethod("dual-breakout", method, true)).toThrow(
    "方法版本",
  );
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
