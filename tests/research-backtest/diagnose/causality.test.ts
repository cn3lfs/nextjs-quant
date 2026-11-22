import { expect, it } from "vitest";
import { prepareStrategy } from "trading-strategies";
import { adjustmentFactors, applyAdjustment } from "tstdx/local";
import type { TdxXdxr } from "tstdx/wire";
import type { Bar } from "trading-strategy-core/bars";
import type { PortfolioRequest } from "quant-backtest";
import { causalResearchPrices } from "~/server/research/causal-price-basis";
import {
  researchCorporateActions,
  researchExecutionEvidence,
} from "~/server/research/corporate-actions";
import {
  replayLabBacktest,
  type FrozenLabBacktest,
} from "~/server/research/lab-backtest";
import { runDiagnostics } from "../../../scripts/lib/backtest-diagnose/diagnostics";
import { buildStrategy } from "../../../scripts/lib/backtest-diagnose/strategy-specs";

const symbol = "sh600000";
const cutoff = 23;
const raw: Bar[] = Array.from({ length: 27 }, (_, i) => {
  const close = i < 10 || i === cutoff ? 10 : i > cutoff ? 6 : 9;
  const volume = i === cutoff ? 2_000 : 1_000;
  return {
    date: new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10),
    open: close,
    high: close + 0.1,
    low: close - 0.1,
    close,
    volume,
    amount: close * volume,
  };
});
const events: TdxXdxr[] = [
  { date: raw[10]!.date, category: 1, name: "past dividend", dividend: 1 },
  {
    date: raw[cutoff + 1]!.date,
    category: 1,
    name: "future dividend",
    dividend: 4,
  },
];
const prefix = raw.slice(0, cutoff + 1);
const source = "synthetic GBBQ";

it("keeps every prefix OHLC value and a true formula breakout unchanged when a future ex-date enters the window", () => {
  const full = causalResearchPrices(raw, events, source, []);
  const truncated = causalResearchPrices(prefix, events, source, []);
  const columns = ({ date, open, high, low, close }: Bar) => [
    date,
    open,
    high,
    low,
    close,
  ];
  expect(full.bars.slice(0, cutoff + 1).map(columns)).toEqual(
    truncated.bars.map(columns),
  );
  // Past dividend multiplies by 10/9. The future dividend adds 10/6 only from its ex-date.
  expect(full.bars[cutoff]?.close).toBeCloseTo(100 / 9, 10);
  expect(full.bars[cutoff + 1]?.close).toBeCloseTo(100 / 9, 10);
  expect(full.bars[cutoff + 1]!.close / raw[cutoff + 1]!.close).toBeCloseTo(
    50 / 27,
    10,
  );

  const strategy = buildStrategy("formula", [symbol], "single");
  const fullDecision = prepareStrategy(strategy, full.bars).evaluate(cutoff);
  const prefixDecision = prepareStrategy(strategy, truncated.bars).evaluate(
    cutoff,
  );
  // 10 × 10/9 clears 20 prior highs (at most 9.1 × 10/9 or 10.1), with volume above MA20.
  expect(prefixDecision.entry).toBe(true);
  expect(prefixDecision.exit).toBe(false);
  expect(fullDecision.entry).toBe(prefixDecision.entry);
  expect(fullDecision.exit).toBe(prefixDecision.exit);
  expect(fullDecision.stopLevel).toBe(prefixDecision.stopLevel);
});

it("flags a forward-adjusted prefix spliced at a new future anchor on a non-action date", () => {
  const forward = (bars: Bar[]) =>
    applyAdjustment(bars, adjustmentFactors(bars, events), "forward");
  const original = forward(prefix);
  const rebased = forward(raw);
  expect(original[cutoff]?.close).toBeCloseTo(10, 10);
  expect(rebased[cutoff]?.close).toBeCloseTo(6, 10);

  // Simulate a stale cache joining two differently anchored windows a day early.
  const signalBars = [...original.slice(0, cutoff), ...rebased.slice(cutoff)];
  const start = raw[0]!.date,
    end = raw.at(-1)!.date;
  const actions = researchCorporateActions(events, source, start, end);
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 10_000,
    start,
    end,
    calendar: raw.map(({ date }) => date),
    instruments: [
      {
        symbol,
        market: "cn-equity",
        bars: raw,
        signalBars,
        actions,
        execution: researchExecutionEvidence(symbol, raw, actions),
      },
    ],
    strategies: [buildStrategy("hold", [symbol], "single")],
    sleeves: [{ id: "diag", share: 1, riskPerTrade: 0.1, maxPositions: 1 }],
  };
  const frozen: FrozenLabBacktest = {
    request,
    sources: [],
    dataSource: "local",
    corporateActionCoverage: "included",
    costScenario: "fixed",
    strategyBuildHash: "",
    executionBuildHash: "",
    boundary: source,
    marketPolicy: {
      signalBars: "forward",
      executionBars: "raw",
      priceLimits: "scenario",
      quantityGrid: {
        kind: "fixture",
        minimumStepCells: ["100/100"],
        evidence: source,
      },
    },
  };
  const report = runDiagnostics({
    request,
    frozen,
    replay: replayLabBacktest(frozen),
  });
  const check = report.checks.find(
    ({ id }) => id === "priceBasisChangeWithoutAction",
  );
  expect(check?.status).toBe("fail");
  expect(check?.evidence).toContainEqual(
    expect.objectContaining({
      symbol,
      from: raw[cutoff - 1]!.date,
      to: raw[cutoff]!.date,
      basis: "forward",
    }),
  );
});
