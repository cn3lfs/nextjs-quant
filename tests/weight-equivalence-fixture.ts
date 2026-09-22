import type { Bar } from "../src/lib/domain";
import {
  researchCommission,
  type ResearchExecutionRules,
} from "../src/lib/research-execution";
import {
  researchSpecSchema,
  type ResearchEvent,
  type ResearchSpec,
} from "../src/lib/strategy-research";
import {
  closeReturns,
  projectResearchWeights,
  weightBacktest,
} from "../src/lib/weight-backtest";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";

export const anchorDays = [
  "2024-01-02",
  "2024-01-03",
  "2024-01-04",
  "2024-01-05",
  "2024-01-08",
];
export const anchorRules: ResearchExecutionRules = {
  evidence: "synthetic",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 1000000,
  limitUp: null,
  limitDown: null,
  tradable: true,
};
export function projectionAnchor(intradayEntry = false) {
  // Analytic control chosen before measurement: nonzero holding returns,
  // no fees, flat execution-day intraday returns, and 50% initial cash.
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: anchorDays[0],
    end: anchorDays.at(-1),
    validationStart: anchorDays[3],
    initialCapital: 10000,
    maxPositions: 2,
    holdingDays: 3,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const event: ResearchEvent = {
    symbol: "sh600000",
    observedDate: anchorDays[0]!,
    endpointDate: anchorDays[0]!,
    key: "anchor",
    strategyVersion: "test",
    partition: "development",
    evidence: "synthetic",
  };
  const series = new Map([
    [
      event.symbol,
      anchorDays.map((date, i): Bar => ({
        date,
        open: [10, 10, 10, 11, 12][i]!,
        close: [10, intradayEntry ? 11 : 10, 11, 12, 12][i]!,
        high: 14,
        low: 8,
        volume: 10000,
        amount: 100000,
      })),
    ],
  ]);
  const simulation = researchPortfolio(
    spec,
    [event],
    anchorDays,
    series,
    () => anchorRules,
  );
  return { spec, series, simulation };
}

export const absoluteSummary = (values: readonly number[]) => ({
  days: values.length,
  meanAbs: values.length
    ? values.reduce((sum, value) => sum + Math.abs(value), 0) / values.length
    : null,
  maxAbs: values.length ? Math.max(...values.map(Math.abs)) : null,
});

/** Accounting attribution on the SAME realized fills, no parameter sweeps.
 * Sign: weight minus E3. Fees include commission, tax and actual slippage.
 * Price timing is separately visible, never forced into one of seven causes.
 */
export function compareProjection(
  spec: ResearchSpec,
  simulation: ReturnType<typeof researchPortfolio>,
  series: ReadonlyMap<string, readonly Bar[]>,
) {
  const calendar = simulation.nav.map((point) => point.date);
  const projection = projectResearchWeights(simulation, series);
  const replay = weightBacktest(
    calendar,
    projection.rows,
    closeReturns(calendar, series),
    spec.costs,
  );
  const daily = replay.map((point, i) => {
    const previousNav = i ? simulation.nav[i - 1]!.value : spec.initialCapital;
    const stale =
      simulation.nav[i]!.stale.length > 0 ||
      (i > 0 && simulation.nav[i - 1]!.stale.length > 0);
    const actual = stale ? null : simulation.nav[i]!.value / previousNav - 1;
    let executionCosts = 0,
      timing = 0;
    for (const trade of simulation.trades) {
      const bar = series
        .get(trade.event.symbol)
        ?.find((bar) => bar.date === point.dt);
      if (trade.entryDate === point.dt) {
        if (!bar) throw new Error("缺入场日行情，不能归因");
        executionCosts += trade.entryCost - trade.quantity * bar.open;
        timing -= (trade.quantity * (bar.close - bar.open)) / previousNav;
      }
      if (trade.exitDate === point.dt) {
        if (!bar || trade.exitPrice === null)
          throw new Error("缺退出日行情，不能归因");
        const amount = trade.quantity * trade.exitPrice;
        executionCosts +=
          trade.quantity * (bar.open - trade.exitPrice) +
          researchCommission(amount, spec.costs) +
          (amount * spec.costs.sellTaxBps) / 10000;
        timing += (trade.quantity * (bar.close - bar.open)) / previousNav;
      }
    }
    const difference =
      point.netReturn === null || actual === null
        ? null
        : point.netReturn - actual;
    const fees =
      point.cost === null ? null : executionCosts / previousNav - point.cost;
    const sevenSourceResidual =
      difference === null || fees === null ? null : difference - fees;
    return {
      ...point,
      actual,
      difference,
      fees,
      timing,
      sevenSourceResidual,
      unexplained:
        sevenSourceResidual === null ? null : sevenSourceResidual - timing,
    };
  });
  const summary = (
    key:
      "difference" | "fees" | "timing" | "sevenSourceResidual" | "unexplained",
  ) =>
    absoluteSummary(
      daily.flatMap((row) => (row[key] === null ? [] : [row[key]])),
    );
  return {
    projection,
    daily,
    difference: summary("difference"),
    fees: summary("fees"),
    timing: summary("timing"),
    sevenSourceResidual: summary("sevenSourceResidual"),
    unexplained: summary("unexplained"),
  };
}
