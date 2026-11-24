import { expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { researchExecutionCosts } from "trading-strategy-core/costs";
import {
  runDiagnoseTimeHoldout,
  DEFAULT_HOLDOUT_START,
} from "~/server/research/diagnose/time-holdout";

function fixture(): PortfolioRequest {
  const bars = Array.from({ length: 110 }, (_, i) => {
    const date = new Date(Date.UTC(2022, 9, 20 + i)).toISOString().slice(0, 10);
    const close = 20 + Math.sin(i) + i / 15;
    return {
      date,
      open: close,
      close,
      high: close + 1,
      low: close - 1,
      volume: 100000,
      amount: 1e7,
    };
  });
  return {
    market: "cn-equity",
    initial: 100000,
    start: bars[0]!.date,
    end: bars.at(-1)!.date,
    calendar: bars.map((b) => b.date),
    costs: researchExecutionCosts("cn-equity", "double-cost"),
    strategies: [
      {
        id: "trend",
        market: "cn-equity",
        version: 1,
        sleeve: "s",
        period: "day",
        universe: { kind: "symbols", symbols: ["sh600001"] },
        entry: { kind: "constant", value: true },
        exit: { maxBars: 3 },
        sizing: { kind: "weight", weight: 0.5 },
      },
    ],
    sleeves: [{ id: "s", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    instruments: [
      {
        market: "cn-equity",
        symbol: "sh600001",
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixture",
          tradable: true,
          minimum: 100,
          step: 100,
          limitUp: null,
          limitDown: null,
        },
      },
    ],
  };
}

it("reviews historical holdout, isolates dev, and reproduces each leg's fees and equity from one frozen request", () => {
  const req = fixture(),
    benchmark = req.instruments[0]!.bars;
  const review = runDiagnoseTimeHoldout(req, {
    trainBars: 15,
    testBars: 8,
    benchmark,
  });
  expect(review.status).toBe("reviewed");
  expect(review.classification).toBe("historical-holdout-review");
  expect(review.disclosure).toContain(
    "历史留出复核（Historical Holdout Review）",
  );
  expect(review.holdoutStart).toBe(DEFAULT_HOLDOUT_START);
  expect(review.devWindowRange!.end < review.holdoutStart).toBe(true);
  expect(review.devSummary!.windowCount).toBe(
    Math.floor((req.calendar.indexOf(DEFAULT_HOLDOUT_START) - 15) / 8),
  );
  for (const leg of ["base", "doubledCost", "delayed"] as const) {
    const result = runPortfolio({
      ...req,
      start: review.holdoutRange!.start,
      signalDelayBars: leg === "delayed" ? 1 : 0,
      costs: researchExecutionCosts(
        req.market,
        leg === "doubledCost" ? "double-cost" : "base",
      ),
    });
    const m = review.holdout![leg];
    expect(m.fees).toBeGreaterThan(0);
    expect(m.fees).toBe(result.fills.reduce((n, f) => n + f.fee, 0));
    expect(m.return).toBeCloseTo(
      result.curve.at(-1)!.equity / req.initial - 1,
      12,
    );
    expect(m.excess).not.toBeNull();
  }
  expect(review.statistics).toMatchObject({
    dsrThreshold: 0.95,
    pbo: null,
    effectiveTrials: 1,
  });
  expect(review.statistics.dsr).toEqual(expect.any(Number));
  expect(review.statistics.note).toContain("候选不足");
  expect(review.reasons).toContain("family-cscv-pbo");
  expect(review.passed).toBe(false);
  expect(JSON.parse(JSON.stringify(review))).toEqual(review);
});

it("uses an explicit cut, and leaves unobserved benchmark and multi-trial statistics unavailable", () => {
  const req = fixture(),
    holdoutStart = req.calendar[58]!;
  const review = runDiagnoseTimeHoldout(req, {
    holdoutStart,
    trainBars: 10,
    testBars: 6,
    effectiveTrials: 4,
  });
  expect(review.holdoutRange?.start).toBe(holdoutStart);
  expect(review.devWindowRange!.end < holdoutStart).toBe(true);
  expect(review.holdout?.base.excess).toBeNull();
  expect(review.statistics).toMatchObject({
    dsr: null,
    pbo: null,
    effectiveTrials: 4,
  });
  expect(review.reasons).toContain("missing-trial-sharpe-distribution");
});

it.each([
  ["2026-01-01", "留出段没有交易日"],
  ["2019-01-01", "开发段不足"],
  ["2023-02-06", "留出段不足"],
])(
  "reports insufficient evidence at %s without inventing scored observations",
  (holdoutStart, reason) => {
    const review = runDiagnoseTimeHoldout(fixture(), { holdoutStart });
    expect(review).toMatchObject({
      status: "insufficient",
      holdout: null,
      passed: false,
      statistics: { dsr: null, pbo: null },
    });
    expect(review.reasons.join(" ")).toContain(reason);
  },
);

it("does not score an unobserved instrument day as a flat day", () => {
  const req = fixture(),
    ins = req.instruments[0]!,
    bars = ins.bars.filter((b) => b.date !== "2023-01-10");
  req.instruments = [{ ...ins, bars, signalBars: bars }];
  expect(runDiagnoseTimeHoldout(req).holdout?.base.return).toBeNull();
});
