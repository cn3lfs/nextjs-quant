import type { PortfolioInstrument, PortfolioRequest } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import type { ExecutionCosts } from "trading-strategy-core/costs";

export const dates = [
  "2026-01-05",
  "2026-01-06",
  "2026-01-07",
  "2026-01-08",
  "2026-01-09",
  "2026-01-12",
] as const;
export const allocationSymbol = "sh600000";
export const protectedSymbol = "sh600001";
export const limitUpSymbol = "sh600002";
export const initialTargetHash = "a".repeat(64);
export const rebalanceTargetHash = "b".repeat(64);
export const terminalEvidence =
  "fixture: final observed close before delisting";
export const costs = {
  version: "cost-experiment-1",
  commissionBps: 20,
  minimumCommission: 5,
  transferBps: 4,
  sellTaxBps: 4,
  dividendTaxBps: 1000,
  slippageBps: 0,
} satisfies ExecutionCosts;

function bar(date: string, open: number, close = open): Bar {
  return {
    date,
    open,
    close,
    high: Math.max(open, close) + 0.25,
    low: Math.min(open, close) - 0.25,
    volume: 1_000_000,
    amount: close * 1_000_000,
  };
}

function instrument(symbol: string, bars: Bar[]): PortfolioInstrument {
  return {
    symbol,
    market: "cn-equity",
    bars,
    signalBars: bars,
    execution: (day) => ({
      evidence: "fixture: daily execution limits",
      limitUp: symbol === limitUpSymbol && day?.date === dates[1] ? 11 : null,
      limitDown: null,
      tradable: true,
    }),
  };
}

export function sixOutputRequest(withTerminal: boolean): PortfolioRequest {
  const [signal, entry, dividend, bonus, lastClose, end] = dates;
  const allocation = instrument(allocationSymbol, [
    bar(signal, 10),
    bar(entry, 10),
    bar(dividend, 9.5),
    bar(bonus, 6.25, 6.4),
    bar(lastClose, 6.5, 6.8),
  ]);
  allocation.actions = [
    {
      date: dividend,
      availableAt: signal,
      cashAvailableAt: dividend,
      timingAssumption: "ex-date-research-scenario",
      evidence: "fixture: cash credited before the ex-date open",
      dividend: 0.5,
      bonus: 0,
    },
    {
      date: bonus,
      availableAt: signal,
      cashAvailableAt: bonus,
      timingAssumption: "ex-date-research-scenario",
      evidence:
        "fixture: bonus credited before the ex-date open, sellable next session",
      dividend: 0,
      bonus: 0.5,
      sharesSellableAt: lastClose,
    },
  ];
  if (withTerminal)
    allocation.terminal = {
      date: lastClose,
      valuation: "last-close",
      evidence: terminalEvidence,
    };
  const blocked = bar(entry, 11);
  return {
    market: "cn-equity",
    initial: 20_000,
    start: signal,
    end,
    calendar: dates,
    costs,
    instruments: [
      allocation,
      instrument(protectedSymbol, [
        bar(signal, 20),
        { ...bar(entry, 20, 20.25), low: 19 },
        bar(dividend, 19, 19.25),
      ]),
      instrument(limitUpSymbol, [
        bar(signal, 10),
        { ...blocked, high: blocked.open, low: blocked.open },
      ]),
    ],
    strategies: [
      {
        id: "targets",
        sleeve: "allocation",
        version: 1,
        market: "cn-equity",
        period: "day",
        universe: {
          kind: "symbols",
          symbols: [allocationSymbol, limitUpSymbol],
        },
        entry: { kind: "constant", value: false },
        exit: { rule: { kind: "constant", value: false } },
        sizing: { kind: "weight", weight: 0.4 },
      },
      {
        id: "stop-loss",
        sleeve: "tactical",
        version: 1,
        market: "cn-equity",
        period: "day",
        universe: { kind: "symbols", symbols: [protectedSymbol] },
        entry: { kind: "formula", source: "选股:C=20;" },
        exit: { stop: { kind: "fixed", fraction: 0.05 } },
        sizing: { kind: "weight", weight: 0.3 },
      },
    ],
    sleeves: [
      { id: "allocation", share: 0.6, riskPerTrade: 1, maxPositions: 2 },
      { id: "tactical", share: 0.4, riskPerTrade: 1, maxPositions: 1 },
    ],
    scheduledTargets: [
      {
        strategyId: "targets",
        date: signal,
        availableAt: signal,
        sourceHash: initialTargetHash,
        targets: { [allocationSymbol]: 0.4, [limitUpSymbol]: 0.2 },
      },
      {
        strategyId: "targets",
        date: dividend,
        availableAt: dividend,
        sourceHash: rebalanceTargetHash,
        targets: { [allocationSymbol]: 0.2 },
      },
    ],
  };
}
