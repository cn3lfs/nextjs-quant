import {
  evaluatePerformance,
  evaluateTrades,
  type TradeCycle,
  assessForwardConformance,
  type ForwardObservation,
} from "quant-performance";
import { equityDailyReturns } from "~/lib/backtest/multiple-testing";
import {
  portfolioClosedTradeReturns,
  portfolioModelSlippage,
} from "~/lib/backtest/portfolio-forward-distribution";
import { closeScanOpen } from "~/lib/market/close-scan-window";
import {
  forwardDefinitionHash,
  forwardSizingPolicyHash,
  type FrozenForwardReference,
} from "../db/forward-reference-repository";
import { paperCompletedAt } from "./advance-clock";
import { beijingClock } from "~/lib/market/market-session";
import type { PaperAccount, PaperState, PaperSummary } from "./model";
import { usesStrategyBook, type StrategyObjectInput } from "trading-strategies";
import { eligibleStrategySymbol } from "../strategies/drivers/evaluation";

export type PaperConformanceContext = {
  reference: FrozenForwardReference | null;
  buildHash: string | null;
  calendar: readonly string[];
};

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
  now: number,
  context: PaperConformanceContext = {
    reference: null,
    buildHash: null,
    calendar: [],
  },
): PaperSummary {
  const evaluation = evaluatePerformance(
    account.initial,
    state.result.equity.map((p) => ({ date: p.date, value: p.equity })),
  );
  const trades = evaluateTrades(paperCycles(state));
  const dates = [
    ...new Set(state.request.calendar.map((d) => paperDay(account, d))),
  ];
  const benchmarkComplete = state.request.calendar.every((d) =>
    state.benchmark.some((b) => b.date === d),
  );
  const first = state.benchmark[0],
    last = state.benchmark.at(-1);
  const assessment = assessPaperPortfolio(account, state, now, context);
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

const paperDay = (account: PaperAccount, date: string) => {
  if (date.length === 10) return date;
  const at =
    Date.parse(date) -
    (/^\d+[mh]$/.test(account.candidates[0]!.strategy.period) ? 1 : 0);
  return account.market === "crypto"
    ? new Date(at).toISOString().slice(0, 10)
    : beijingClock(at).date;
};
const lifecycleStrategy = (strategy: StrategyObjectInput) =>
  usesStrategyBook(strategy) ||
  !!strategy.exit.chandelier ||
  !!strategy.exit.timeReentry;
const dayCompletedAt = (account: PaperAccount, date: string) =>
  account.market === "crypto"
    ? Date.parse(`${paperDay(account, date)}T00:00:00Z`) + 86400000
    : Date.parse(`${paperDay(account, date)}T15:00:00+08:00`);
function expectedDays(
  account: PaperAccount,
  state: PaperState,
  now: number,
  calendar: readonly string[],
) {
  if (account.market === "cn-equity")
    return [
      ...new Set([
        ...calendar,
        ...state.request.calendar.map((date) => paperDay(account, date)),
      ]),
    ]
      .sort()
      .filter(
        (date) =>
          dayCompletedAt(account, date) > account.startedAt &&
          dayCompletedAt(account, date) <= now,
      );
  const days: string[] = [];
  let first = new Date(account.startedAt).toISOString().slice(0, 10);
  const strategy = account.candidates[0]!.strategy;
  // At or after the first 4h completion, registration cannot observe all six
  // decisions of that UTC day. Keep its money; compare complete days only.
  if (
    lifecycleStrategy(strategy) &&
    strategy.period === "4h" &&
    Date.parse(first) + 4 * 3600000 <= account.startedAt
  )
    first = new Date(Date.parse(first) + 86400000).toISOString().slice(0, 10);
  for (
    let date = first;
    dayCompletedAt(account, date) <= now;
    date = new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10)
  )
    days.push(date);
  return days;
}

/** Forward observations are compared with their registered distribution. A
 * historical accounting catch-up is retained financially but is not a timely
 * prospective decision, and never repairs an observation gap. */
export function assessPaperPortfolio(
  account: PaperAccount,
  state: PaperState,
  now: number,
  context: PaperConformanceContext,
): NonNullable<PaperSummary["assessment"]> {
  const candidate = account.candidates[0]!;
  const strategy = candidate.strategy;
  const lifecycle = lifecycleStrategy(strategy);
  const evidenceEligibility = (symbol: string, date: string) => {
    const instrument = state.request.instruments.find(
      (s) => s.symbol === symbol,
    );
    if (!instrument) return null;
    try {
      return eligibleStrategySymbol(
        strategy,
        { ...instrument, bars: instrument.signalBars },
        date,
        state.request.memberships?.find(
          (m) => m.strategyId === strategy.id && m.date === date,
        )?.symbols,
      );
    } catch {
      return null;
    }
  };
  const reference = account.candidates.length === 1 ? context.reference : null;
  const expected = expectedDays(account, state, now, context.calendar);
  const expectedSet = new Set(expected);
  const byDay = new Map<string, { date: string; equity: number; at: number }>();
  const valuations = /^\d+[mh]$/.test(strategy.period)
    ? state.result.curve
    : state.result.equity;
  for (const point of valuations) {
    const date = paperDay(account, point.date),
      at = Date.parse(point.date);
    if (!byDay.has(date) || at >= byDay.get(date)!.at)
      byDay.set(date, { date, equity: point.equity, at });
  }
  const dailyEquity = [...byDay.values()].sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  const daily = equityDailyReturns(
    dailyEquity.map((point) => ({ value: point.equity })),
    account.initial,
  );
  const points = dailyEquity
    .map((point, i) => ({ point, return: daily[i] }))
    .filter(
      ({ point }) =>
        dayCompletedAt(account, point.date) > account.startedAt &&
        dayCompletedAt(account, point.date) <= now &&
        (!lifecycle || expectedSet.has(point.date)),
    );
  const decisions = state.decisions.filter(
    (decision) =>
      decision.strategyId === strategy.id &&
      dayCompletedAt(account, decision.date) <= now &&
      (!lifecycle || expectedSet.has(paperDay(account, decision.date))) &&
      (!lifecycle ||
        evidenceEligibility(decision.symbol, decision.date) !== false),
  );
  const invalidDays = new Set<string>();
  let unknownDecisions = decisions.filter((decision) => {
    const completedAt = paperCompletedAt(account, decision.date);
    const timely =
      account.market === "cn-equity" &&
      (strategy.period === "day" || strategy.period === "week")
        ? closeScanOpen(
            paperDay(account, decision.date),
            decision.observedAt,
            context.calendar,
          )
        : decision.observedAt >= completedAt &&
          decision.observedAt <=
            completedAt +
              (strategy.period === "day" ? 12 * 3600000 : 5 * 60000);
    const invalid =
      decision.entry === null ||
      decision.exit === null ||
      !timely ||
      decision.observedAt < account.startedAt ||
      decision.observedAt > now ||
      (lifecycle &&
        evidenceEligibility(decision.symbol, decision.date) === null);
    if (invalid) invalidDays.add(paperDay(account, decision.date));
    return invalid;
  }).length;
  for (const date of state.request.calendar.filter(
    (date) => dayCompletedAt(account, date) <= now,
  )) {
    if (paperCompletedAt(account, date) < account.startedAt) continue;
    if (lifecycle && !expectedSet.has(paperDay(account, date))) continue;
    for (const instrument of state.request.instruments) {
      if (lifecycle && evidenceEligibility(instrument.symbol, date) === false)
        continue;
      if (!instrument.bars.some((bar) => bar.date === date)) continue;
      if (
        !decisions.some(
          (decision) =>
            decision.date === date && decision.symbol === instrument.symbol,
        )
      ) {
        unknownDecisions++;
        invalidDays.add(paperDay(account, date));
      }
    }
  }
  const engineSignals = new Map<string, number>();
  const engineBars = new Map<string, Set<number>>();
  if (lifecycle) {
    for (const date of state.request.calendar) {
      if (
        paperCompletedAt(account, date) < account.startedAt ||
        dayCompletedAt(account, date) > now
      )
        continue;
      const day = paperDay(account, date);
      if (!expectedSet.has(day)) continue;
      const counts = state.result.dailyDecisionCounts?.filter(
        (c) => c.strategyId === strategy.id && c.date === date,
      );
      const book = state.result.bookDecisions?.filter(
        (d) => d.strategyId === strategy.id && d.decision.date === date,
      );
      if (
        counts?.length !== 1 ||
        counts[0]!.unknown > 0 ||
        counts[0]!.expected <= 0 ||
        (usesStrategyBook(strategy) &&
          (book?.length !== 1 || !book[0]!.decision.available))
      ) {
        invalidDays.add(day);
        unknownDecisions++;
      } else {
        engineSignals.set(
          day,
          (engineSignals.get(day) ?? 0) + counts[0]!.entries,
        );
        const bars = engineBars.get(day) ?? new Set<number>();
        bars.add(Date.parse(date));
        engineBars.set(day, bars);
      }
    }
    if (account.market === "crypto" && strategy.period === "4h")
      for (const day of expected) {
        const bars = engineBars.get(day);
        if (
          !bars ||
          bars.size !== 6 ||
          Array.from(
            { length: 6 },
            (_, i) => Date.parse(day) + (i + 1) * 4 * 3600000,
          ).some((time) => !bars.has(time))
        ) {
          invalidDays.add(day);
          unknownDecisions++;
        }
      }
  }
  const fills = state.result.fills.filter(
    (fill) => dayCompletedAt(account, fill.date) <= now,
  );
  const execution = {
    ...state.result,
    fills,
    corporateActions: state.result.corporateActions.filter(
      (action) => dayCompletedAt(account, action.date) <= now,
    ),
  };
  const closed = portfolioClosedTradeReturns(execution).filter(
    (trade) => trade.strategyId === strategy.id,
  );
  const slippage = portfolioModelSlippage(execution, state.request);
  const days = points.flatMap(({ point, return: value }) =>
    value === null ||
    value === undefined ||
    invalidDays.has(point.date) ||
    (lifecycle && !engineSignals.has(point.date))
      ? []
      : [
          {
            date: point.date,
            return: value,
            signals: lifecycle
              ? engineSignals.get(point.date)!
              : decisions.filter(
                  (decision) =>
                    paperDay(account, decision.date) === point.date &&
                    decision.entry === true &&
                    decision.exit !== true,
                ).length,
          },
        ],
  );
  const observed: ForwardObservation = {
    identity: {
      strategyId: strategy.id,
      version: strategy.version,
      definitionHash: forwardDefinitionHash(strategy),
      inputHash: reference?.identity.inputHash ?? "",
      buildHash: context.buildHash ?? "",
    },
    days,
    tradeReturns: closed.map((trade) => trade.return),
    slippageBps: slippage.samples
      .filter((sample) => sample.strategyId === strategy.id)
      .map((sample) => sample.bps),
    entries: fills.filter(
      (fill) =>
        fill.strategyId === strategy.id &&
        fill.side === "buy" &&
        Math.abs(fill.holdingAfter - fill.quantity) < 1e-8,
    ).length,
    missingDates: expected.filter(
      (date) => !days.some((point) => point.date === date),
    ),
    unknownDecisions,
  };
  const conformance = assessForwardConformance({
    market: account.market,
    period: strategy.period,
    reference,
    observed,
    startedAt: account.startedAt,
    asOf: now,
    expectedDates: expected,
  });
  if (!context.buildHash) {
    conformance.reasons.push("missing-current-execution-identity");
    conformance.verdict = "insufficient";
  }
  if (account.candidates.length !== 1)
    conformance.reasons.push("shared-account-needs-frozen-portfolio-reference");
  if (
    reference &&
    reference.sizingPolicyHash !== forwardSizingPolicyHash(state.request)
  )
    conformance.reasons.push("forward-sizing-policy-mismatch");
  if (reference && reference.slippageBasis !== "paper-model")
    conformance.reasons.push("forward-slippage-basis-mismatch");
  if (
    slippage.missing &&
    !(account.market === "crypto" && strategy.period === "day")
  )
    conformance.reasons.push("incomplete-model-slippage-reference");
  if (
    conformance.reasons.some((reason) =>
      [
        "shared-account-needs-frozen-portfolio-reference",
        "forward-sizing-policy-mismatch",
        "forward-slippage-basis-mismatch",
        "incomplete-model-slippage-reference",
      ].includes(reason),
    )
  )
    conformance.verdict = "insufficient";
  const backtestPassed =
    reference?.backtestPassed === true &&
    reference.method === "lifecycle-2" &&
    reference.purpose === "preregistered";
  const eligible = conformance.verdict === "conforming" && backtestPassed;
  return {
    method: "forward-conformance-1",
    verdict: conformance.verdict,
    backtestPassed,
    eligible,
    referenceHash: reference?.contentHash ?? null,
    asOf: now,
    slippageBasis: "paper-model",
    realExecutionVerified: false,
    observedSignals: days.reduce((sum, day) => sum + day.signals, 0),
    conformance,
    reasons: [
      ...conformance.reasons,
      ...(!backtestPassed ? ["backtest-gates-not-passed"] : []),
    ],
    recommendation:
      conformance.verdict === "conforming"
        ? eligible
          ? "前推一致；可手动晋级并开启提醒"
          : "影子前推一致；历史回测未通过，仅研究观察"
        : conformance.verdict === "degraded"
          ? "前推衰减；建议暂停 live 并复核"
          : "证据不足；继续模拟观察",
  };
}
