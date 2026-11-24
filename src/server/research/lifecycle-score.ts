import {
  portfolioObservationDay,
  type PortfolioRequest,
  type runPortfolio,
  type ValidationScore,
} from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import {
  portfolioClosedTradeReturns,
  portfolioModelSlippage,
} from "~/lib/backtest/portfolio-forward-distribution";
import { scoreValidationResult } from "./validation-replay";
import { validationHash, type ValidationDataset } from "./validation-capture";
import { economicFillList } from "~/lib/backtest/economic-fills";

/** Count eligible symbol/session pairs once across strategies in all sleeves. */
export function summarizePortfolioSuspensions(
  result: ReturnType<typeof runPortfolio>,
) {
  const byDate = new Map<string, Set<string>>();
  for (const row of result.dailyDecisionCounts ?? []) {
    if (!row.suspendedSymbols?.length) continue;
    const symbols = byDate.get(row.date) ?? new Set<string>();
    for (const symbol of row.suspendedSymbols) symbols.add(symbol);
    byDate.set(row.date, symbols);
  }
  return {
    symbolSuspensionDays: [...byDate.values()].reduce(
      (sum, symbols) => sum + symbols.size,
      0,
    ),
    portfolioAffectedDays: byDate.size,
  };
}

/** Same completed-day clock for engine, OOS statistics and forward distributions. */
export function lifecycleDailyEvidence(
  result: ReturnType<typeof runPortfolio>,
  request: PortfolioRequest,
  expectedAxis: readonly string[],
) {
  const period = request.strategies[0]!.period;
  const day = (date: string) =>
    portfolioObservationDay(request.market, period, date);
  const expected = expectedAxis.filter(
    (d) => d >= request.start && d <= request.end,
  );
  const closes = new Map(result.equity.map((p) => [p.date, p.equity]));
  const count = new Map<
    string,
    { entries: number; unknown: number; bars: Set<string> }
  >();
  for (const c of result.dailyDecisionCounts ?? []) {
    const date = day(c.date),
      current = count.get(date) ?? {
        entries: 0,
        unknown: 0,
        bars: new Set<string>(),
      };
    current.entries += c.entries;
    // Suspended symbols already count toward expected. Other unknowns, even
    // in the same sleeve on the same session, still invalidate the period.
    current.unknown += c.unknown + (c.expected ? 0 : 1);
    current.bars.add(c.date);
    count.set(date, current);
  }
  const native = new Map<string, string[]>();
  for (const date of request.calendar) {
    const key = day(date);
    native.set(key, [...(native.get(key) ?? []), date]);
  }
  const unavailable = new Set<string>();
  for (const decision of result.bookDecisions ?? [])
    if (!decision.decision.available)
      unavailable.add(day(decision.decision.date));
  let previous = request.initial;
  return expected.map((date) => {
    const value = closes.get(date),
      observations = count.get(date),
      timestamps = native.get(date) ?? [];
    const completeClock =
      request.market !== "crypto" ||
      period !== "4h" ||
      (timestamps.length === 6 &&
        timestamps.every(
          (label, i) =>
            Date.parse(label) === Date.parse(date) + (i + 1) * 4 * 3600000,
        ));
    const missing =
      value === undefined ||
      !Number.isFinite(value) ||
      value < 0 ||
      !(previous > 0) ||
      !observations ||
      observations.unknown > 0 ||
      observations.bars.size !== timestamps.length ||
      !completeClock ||
      unavailable.has(date);
    const change = missing ? null : value! / previous - 1;
    // A missing day must not be silently bridged by tomorrow's return.
    previous = missing ? NaN : value!;
    return {
      date,
      return: change,
      signals: missing ? null : observations!.entries,
      missing,
    };
  });
}

export function scoreLifecycleResult(
  result: ReturnType<typeof runPortfolio>,
  request: PortfolioRequest,
  benchmark: readonly Bar[],
  axis: readonly string[],
  centerId: string,
): ValidationScore {
  const period = request.strategies[0]!.period,
    byDay = new Map<string, Bar>();
  for (const b of benchmark) {
    const date = portfolioObservationDay(request.market, period, b.date),
      prior = byDay.get(date);
    byDay.set(
      date,
      prior
        ? {
            ...b,
            date,
            open: prior.open,
            high: Math.max(prior.high, b.high),
            low: Math.min(prior.low, b.low),
            volume: prior.volume + b.volume,
            amount: prior.amount + b.amount,
          }
        : { ...b, date },
    );
  }
  const legacy = scoreValidationResult(
    result,
    request,
    { benchmark: [...byDay.values()] } as ValidationDataset,
    "lifecycle-2",
  );
  const evidence = lifecycleDailyEvidence(result, request, axis),
    missing = evidence.some((d) => d.missing);
  const slippage = portfolioModelSlippage(result, request);
  return {
    ...legacy,
    ...(missing
      ? {
          return: null,
          excess: null,
          drawdown: null,
          riskAdjusted: {
            ...legacy.riskAdjusted!,
            sharpe: null,
            benchmarkSharpe: null,
            sharpeDifference: null,
            calmar: null,
            benchmarkCalmar: null,
            calmarDifference: null,
          },
        }
      : {}),
    dailyDates: evidence.map((d) => d.date),
    daily: evidence.map((d) => d.return),
    dailySignals: missing ? undefined : evidence.map((d) => d.signals!),
    ...(missing
      ? { tradeListHash: undefined }
      : {
          tradeListHash: validationHash(
            economicFillList(result.fills, centerId),
          ),
        }),
    tradeReturns: portfolioClosedTradeReturns(result).map((t) => t.return),
    slippageBps: slippage.missing
      ? undefined
      : slippage.samples.map((s) => s.bps),
  };
}

export function lifecycleSegments(axis: readonly string[]) {
  if (
    axis.length < 20 ||
    axis.some(
      (d, i) => !/^\d{4}-\d{2}-\d{2}$/.test(d) || (i > 0 && d <= axis[i - 1]!),
    )
  )
    throw new Error("Missing or invalid frozen family daily axis");
  const train = Math.floor(axis.length * 0.4),
    test = Math.max(1, Math.floor(axis.length * 0.1)),
    holdout = Math.floor(axis.length * 0.8);
  const windows = [];
  for (let i = train; i + test <= holdout; i += test)
    windows.push({
      trainStart: axis[i - train]!,
      trainEnd: axis[i - 1]!,
      start: axis[i]!,
      end: axis[i + test - 1]!,
    });
  // Fractional integer remainders belong to the final pre-holdout OOS window;
  // every declared OOS day is observed once, with no silent bridge to holdout.
  if (windows.length) windows[windows.length - 1]!.end = axis[holdout - 1]!;
  return {
    train,
    test,
    holdout,
    windows,
    inSample: { start: axis[0]!, end: axis[train - 1]! },
    holdoutWindow: { start: axis[holdout]!, end: axis.at(-1)! },
    callsPerConfiguration: windows.length * 4 + 4,
    scenarioIdentities: 3,
  };
}
