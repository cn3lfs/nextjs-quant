import {
  evaluatePerformance,
  evaluateTrades,
  type TradeCycle,
} from "quant-performance";
import {
  runValidationSuite,
  validationDefaults,
  validationRowReasons,
} from "quant-backtest";
import { multipleTesting } from "~/lib/backtest/multiple-testing";
import { scoreValidationResult } from "../research/validation-replay";
import type { PaperAccount, PaperState, PaperSummary } from "./model";

/** Map the engine's already-settled cash to flat-to-flat cycles. Shares and
 * entitlements are never recalculated by this read-only metrics adapter. */
export function paperCycles(state: PaperState) {
  const cycles: TradeCycle[] = [];
  const active = new Map<string, { cycle: TradeCycle; cash: number }>();
  const events = [
    ...state.result.corporateActions.map((a) => ({
      date: a.date,
      action: a,
      fill: null,
    })),
    ...state.result.fills.map((f) => ({ date: f.date, action: null, fill: f })),
  ].sort(
    (a, b) =>
      a.date.localeCompare(b.date) || (a.action ? -1 : 0) - (b.action ? -1 : 0),
  );
  for (const event of events) {
    const row = event.action ?? event.fill!;
    const key = JSON.stringify([row.strategyId, row.symbol]);
    let current = active.get(key);
    if (event.action) {
      if (current) current.cash += event.action.cash;
      continue;
    }
    const fill = event.fill!;
    if (!current) {
      const cycle: TradeCycle = {
        id: String(cycles.length),
        symbol: key,
        openedAt: fill.date.slice(0, 10),
        closedAt: null,
        netPnl: null,
      };
      cycles.push(cycle);
      current = { cycle, cash: 0 };
      active.set(key, current);
    }
    current.cash +=
      (fill.side === "buy" ? -1 : 1) * fill.price * fill.quantity - fill.fee;
    if (fill.holdingAfter === 0) {
      current.cycle.closedAt = fill.date.slice(0, 10);
      current.cycle.netPnl = current.cash;
      active.delete(key);
    }
  }
  return cycles;
}
export function summarizePaper(
  account: PaperAccount,
  state: PaperState,
  _now: number,
): PaperSummary {
  const evaluation = evaluatePerformance(
    account.initial,
    state.result.equity.map((p) => ({ date: p.date, value: p.equity })),
  );
  const trades = evaluateTrades(paperCycles(state));
  const dates = [...new Set(state.request.calendar.map((d) => d.slice(0, 10)))];
  const benchmarkComplete = state.request.calendar.every((d) =>
    state.benchmark.some((b) => b.date === d),
  );
  const first = state.benchmark[0],
    last = state.benchmark.at(-1);
  const assessment = assessPaperPortfolio(account, state, dates);
  return {
    return: evaluation.totalReturn.value,
    drawdown: evaluation.maxDrawdown.value,
    trades: trades.closedTrades,
    winRate: trades.winRate.value,
    benchmarkReturn:
      benchmarkComplete && first && last ? last.close / first.open - 1 : null,
    signals: state.decisions.filter((d) => d.entry === true && d.exit !== true)
      .length,
    days: dates.length,
    assessment,
  };
}

/** Apply the existing forward gates to this actual shared-cash request and its
 * configured initial capital, including cost/delay stress. Never grade an
 * imagined independent million-unit account in place of a sleeve account. */
function assessPaperPortfolio(
  account: PaperAccount,
  state: PaperState,
  dates: string[],
): PaperSummary["assessment"] {
  const signals = state.decisions.filter(
    (d) => d.entry === true && d.exit !== true,
  ).length;
  if (signals < 30 && dates.length < 60) return null;
  const pending = (reasons: string[]) => ({
    recommendation: "衰减 / 证据不足；继续模拟观察",
    reasons,
  });
  if (dates.length < 35) return pending(["insufficient-forward-windows"]);
  if (
    state.request.calendar.some(
      (d) => !state.benchmark.some((b) => b.date === d),
    )
  )
    return pending(["incomplete-forward-execution-evidence"]);
  const policy = {
    ...validationDefaults,
    trainBars: Math.max(20, Math.floor(dates.length * 0.4)),
    testBars: Math.max(5, Math.floor(dates.length * 0.1)),
  };
  const dataset = {
    period: account.candidates[0]!.strategy.period,
    instruments: [...state.request.instruments],
    sources: [],
    benchmark: state.benchmark,
    benchmarkName: "First-observed forward benchmark",
    dates,
  };
  const suite = runValidationSuite(
    [{ id: account.id, family: account.sleeve, request: state.request }],
    dates,
    policy,
    (result, request) => scoreValidationResult(result, request, dataset),
  );
  const row = {
    ...suite.rows[0]!,
    neighbors: account.candidates.flatMap((c) => c.registration.neighbors),
  };
  const reasons = validationRowReasons(row, policy);
  if (state.decisions.some((d) => d.entry === null || d.exit === null))
    reasons.push("unknown-forward-rule-inputs");
  const distribution = account.candidates[0]!.registration.trialSharpes;
  const dsr = multipleTesting(
    row.windows.flatMap((w) => w.base.daily),
    distribution,
  ).selected.dsr.value;
  if (dsr === null || dsr < 0.95) reasons.push("multiple-testing-dsr-0.95");
  for (const c of account.candidates) {
    const neighbors = c.registration.neighbors;
    if (
      !neighbors.length ||
      neighbors.filter((n) => n.excess !== null && n.excess > 0).length /
        neighbors.length <
        validationDefaults.minimumStableNeighbors
    )
      reasons.push("parameter-neighborhood");
    if (c.strategy.sleeve === "low-zone") {
      if (c.registration.completeMarketCycles < 3)
        reasons.push("insufficient-complete-market-cycles");
      if (!c.registration.lowZoneCorroborated)
        reasons.push("low-zone-input-confidence");
    }
    if (c.registration.sizing === "volatility" && dates.length < 61)
      reasons.push("insufficient-forward-volatility-warmup");
  }
  return reasons.length
    ? pending([...new Set(reasons)])
    : { recommendation: "可考虑开启提醒；请手动启用live及订阅", reasons: [] };
}
