import { expect, it } from "vitest";
import {
  adjustmentFactors,
  applyAdjustment,
  applyAdjustmentAtAnchor,
} from "tstdx/local";
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
const dates = [
  "2025-01-06",
  "2025-01-07",
  "2025-01-08",
  "2025-01-09",
  "2025-01-10",
] as const;
const [start, , dividendDay, , end] = dates;
const raw: Bar[] = dates.map((date, index) => {
  const close = [20, 20, 16, 18, 9][index]!;
  return {
    date,
    open: close,
    high: close + 0.1,
    low: close - 0.1,
    close,
    volume: 10_000,
    amount: close * 10_000,
  };
});
const events: TdxXdxr[] = [
  { date: dividendDay, category: 1, name: "cash dividend", dividend: 4 },
  { date: end, category: 1, name: "bonus shares", bonusRatio: 1 },
];
const source = "synthetic GBBQ";

function checkRatios(bars: Bar[], expected: number[]) {
  const ratios = bars.map(({ close }, i) => close / raw[i]!.close);
  ratios.forEach((ratio, i) => expect(ratio).toBeCloseTo(expected[i]!, 12));
  const changes = dates.filter(
    (_, i) => i > 0 && Math.abs(ratios[i]! - ratios[i - 1]!) > 1e-12,
  );
  expect(changes).toEqual([dividendDay, end]);
}

it("anchors the causal ratio at one and changes it only on the dividend and bonus ex-dates", () => {
  const { bars, proof } = causalResearchPrices(raw, events, source, []);
  // First action multiplies by 20/(20−4) = 1.25. One bonus share per share doubles it.
  expect(proof.anchorDate).toBe(start);
  expect(bars[0]!.close / raw[0]!.close).toBe(1);
  checkRatios(bars, [1, 1, 1.25, 1.25, 2.5]);
});

it("ends conventional forward adjustment at one and preserves the prefix at a fixed forward anchor", () => {
  const allFactors = adjustmentFactors(raw, events);
  const fullForward = applyAdjustment(raw, allFactors, "forward");
  expect(fullForward.at(-1)!.close / raw.at(-1)!.close).toBe(1);
  checkRatios(fullForward, [0.4, 0.4, 0.5, 0.5, 1]);

  // Fix the forward denominator at the scoring cutoff (1.25), while retaining earlier bars.
  const prefix = raw.slice(0, -1);
  const prefixForward = applyAdjustment(
    prefix,
    adjustmentFactors(prefix, events),
    "forward",
  );
  const fixedForward = applyAdjustment(
    prefix,
    allFactors.slice(0, -1),
    "forward",
  );
  const anchor = allFactors.at(-2)!;
  expect(anchor.factor).toBe(1.25);
  expect(prefixForward.map(({ close }) => close)).toEqual([16, 16, 16, 18]);
  expect(fixedForward.map(({ close }) => close)).toEqual(
    prefixForward.map(({ close }) => close),
  );
  // The first-raw anchor used by the lab likewise keeps earlier prices fixed
  // when the same factor table now includes the future bonus event.
  const initialAnchor = { date: start, factor: 1 };
  const before = applyAdjustmentAtAnchor(
    prefix,
    adjustmentFactors(prefix, events),
    initialAnchor,
  );
  const after = applyAdjustmentAtAnchor(raw, allFactors, initialAnchor);
  expect(after.slice(0, -1).map(({ close }) => close)).toEqual(
    before.map(({ close }) => close),
  );
});

it("fails a causal ratio jump whose matching company action is missing from the request", () => {
  const { bars: signalBars, proof } = causalResearchPrices(
    raw,
    events,
    source,
    [],
  );
  const actions = researchCorporateActions(
    events.slice(0, 1),
    source,
    start,
    end,
  );
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 10_000,
    start,
    end,
    calendar: dates,
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
    sources: [{ symbol, causalPrice: proof }],
    dataSource: "local",
    corporateActionCoverage: "included",
    costScenario: "fixed",
    strategyBuildHash: "",
    executionBuildHash: "",
    boundary: source,
    marketPolicy: {
      signalBars: "causal",
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
  expect(report.status).toBe("failed");
  expect(report.layer).toBe("causal-price");
  const check = report.checks.find(
    ({ id }) => id === "priceBasisChangeWithoutAction",
  );
  expect(check?.status).toBe("fail");
  expect(check?.evidence).toEqual([
    {
      symbol,
      from: dates[3],
      to: end,
      previous: 1.25,
      current: 2.5,
      basis: "causal",
    },
  ]);
});
