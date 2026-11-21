import {
  runPortfolio,
  type PortfolioRequest,
  type ValidationScore,
  type ValidationPolicy,
} from "quant-backtest";
import { evaluatePerformance } from "quant-performance";
import {
  equityDailyReturns,
  sharpeDaily,
} from "~/lib/backtest/multiple-testing";
import { validationHash, type ValidationDataset } from "../validation-capture";
import { economicFillList } from "~/lib/backtest/economic-fills";

type TerminalValuationBlock = {
  symbol: string;
  sleeve: string;
  unavailableFrom: string;
  reason: string;
};

function terminalValuationBlocks(
  result: ReturnType<typeof runPortfolio>,
  request: PortfolioRequest,
  dataset: ValidationDataset,
) {
  const unavailable = new Map(
    (dataset.sources ?? []).flatMap(({ symbol, terminalCoverage }) => {
      const from = terminalCoverage?.unavailableFrom;
      const reason = terminalCoverage?.gap;
      return from && from <= request.end && reason
        ? [[symbol, { unavailableFrom: from, reason }] as const]
        : [];
    }),
  );
  const blocked = new Map<string, TerminalValuationBlock>();
  if (!unavailable.size) return [];
  const record = (
    {
      symbol,
      sleeve,
      quantity,
    }: Pick<
      (typeof result.positionSnapshots)[number],
      "symbol" | "sleeve" | "quantity"
    >,
    date: string,
  ) => {
    const gap = unavailable.get(symbol);
    if (gap && quantity > 0 && date.slice(0, 10) >= gap.unavailableFrom)
      blocked.set(`${sleeve}:${symbol}`, { symbol, sleeve, ...gap });
  };
  for (const position of result.positionSnapshots)
    record(position, position.date);
  // The requested window can outlast the final replay clock observation.
  for (const position of result.positions) record(position, request.end);
  return [...blocked.values()];
}

type ScoredValidationResult = ValidationScore & {
  valuation?: { status: "blocked"; positions: TerminalValuationBlock[] };
};

/** Benchmark opens on the first observed evaluation bar, then holds. Missing
 * any daily benchmark value leaves all excess statistics unavailable. */
export function scoreValidationResult(
  result: ReturnType<typeof runPortfolio>,
  request: PortfolioRequest,
  dataset: ValidationDataset,
  method: ValidationPolicy["method"] = "legacy",
): ScoredValidationResult {
  const blocked = terminalValuationBlocks(result, request, dataset);
  const valuation = blocked.length
    ? { status: "blocked" as const, positions: blocked }
    : undefined;
  const benchmark = new Map<string, { open: number; close: number }>();
  for (const b of dataset.benchmark.filter(
    (b) =>
      b.date.slice(0, 10) >= request.start &&
      b.date.slice(0, 10) <= request.end,
  )) {
    const date = b.date.slice(0, 10),
      prior = benchmark.get(date);
    benchmark.set(date, { open: prior?.open ?? b.open, close: b.close });
  }
  let previous: number | undefined;
  const points = result.equity.map((p) => {
    const b = benchmark.get(p.date);
    const benchmarkReturn = b ? b.close / (previous ?? b.open) - 1 : undefined;
    previous = b?.close;
    return { date: p.date, value: p.equity, benchmarkReturn };
  });
  const annualizationDays = request.market === "crypto" ? 365 : 252;
  const evaluation = valuation
    ? null
    : evaluatePerformance(
        request.initial,
        points,
        points[0]?.date,
        annualizationDays,
      );
  let benchmarkNav = request.initial;
  const benchmarkEvaluation = points.every(
    (p) => p.benchmarkReturn !== undefined,
  )
    ? evaluatePerformance(
        request.initial,
        points.map((p) => ({
          date: p.date,
          value: (benchmarkNav *= 1 + p.benchmarkReturn!),
        })),
        points[0]?.date,
        annualizationDays,
      )
    : null;
  const difference = (a: number | null, b: number | null) =>
    a === null || b === null ? null : a - b;
  const benchmarkSharpe = benchmarkEvaluation?.sharpe.value ?? null;
  const benchmarkCalmar = benchmarkEvaluation?.calmar.value ?? null;
  const daily = valuation
    ? points.map(() => null)
    : equityDailyReturns(points, request.initial);
  const scale = Math.sqrt(annualizationDays);
  const sameSharpe = (values: readonly (number | null)[]) => {
    const value = sharpeDaily(values).value;
    return value === null ? null : value * scale;
  };
  const correctedSharpe =
    method === "lifecycle-2"
      ? sameSharpe(daily)
      : (evaluation?.sharpe.value ?? null);
  const correctedBenchmark =
    method === "lifecycle-2"
      ? sameSharpe(points.map((p) => p.benchmarkReturn ?? null))
      : benchmarkSharpe;
  return {
    ...(valuation ? { valuation } : {}),
    ...(method === "lifecycle-2"
      ? {
          dailyDates: result.equity.map((point) => point.date),
          // A neighbor's generated ID is provenance, not a different execution.
          // Keep the canonical strategy identity and every economic fill field.
          tradeListHash: validationHash(economicFillList(result.fills)),
        }
      : {}),
    riskAdjusted: {
      sharpe: correctedSharpe,
      benchmarkSharpe: correctedBenchmark,
      sharpeDifference: difference(correctedSharpe, correctedBenchmark),
      calmar: evaluation?.calmar.value ?? null,
      benchmarkCalmar,
      calmarDifference: difference(
        evaluation?.calmar.value ?? null,
        benchmarkCalmar,
      ),
      basis:
        method === "lifecycle-2"
          ? `daily close returns; zero risk-free; sample standard deviation; ${request.market === "crypto" ? 365 : 252} observations/year; same Sharpe as DSR`
          : "quant-performance: daily close, 252 observations/year, 2% risk-free; same-window benchmark; crypto comparison is a common convention, not 365-day annualization",
    },
    return: evaluation?.totalReturn.value ?? null,
    excess: evaluation?.excessReturn.value ?? null,
    drawdown: evaluation?.maxDrawdown.value ?? null,
    trades: result.fills.filter(
      (f) => f.side === "sell" && f.holdingAfter === 0,
    ).length,
    events: {
      entries: result.observationCounts
        ? Object.values(result.observationCounts).reduce(
            (n, v) => n + v.entries,
            0,
          )
        : result.observations.filter((o) => o.decision.entry === true).length,
      exits: result.observationCounts
        ? Object.values(result.observationCounts).reduce(
            (n, v) => n + v.exits,
            0,
          )
        : result.observations.filter((o) => o.decision.exit === true).length,
      orders: result.orders.length,
      fills: result.fills.length,
      rejectionAttempts: result.rejections.length,
    },
    daily,
  };
}
