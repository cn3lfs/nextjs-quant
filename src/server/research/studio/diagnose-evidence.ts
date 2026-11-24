import type {
  PortfolioExecution,
  PortfolioRequest,
  runPortfolio,
} from "quant-backtest";
import {
  topDrawdownEpisodes,
  type PerformanceEvaluation,
  type TradeExcursionBar,
} from "quant-performance";
import type { DiagnoseScenarioEvidence } from "~/lib/research/diagnose-contract";

import { dailyRangeDisclosure, ledgerExcursions } from "./result-view";

type Result = ReturnType<typeof runPortfolio>;
export type EvidenceFill = NonNullable<
  DiagnoseScenarioEvidence["fullFills"]
>[number];
export type EvidenceBar = TradeExcursionBar & {
  close: number;
  signalClose?: number;
};
/** Old CLI archives record post-fill balances and raw/adjusted closes, but no
 * applied-action cash ledger. Never infer a net dividend or a return from them. */
export function cliTradeExcursions(
  fills: EvidenceFill[],
  calendar: readonly string[],
  bars: Record<string, EvidenceBar[]>,
) {
  const byDate = new Map(
    Object.entries(bars).map(([symbol, rows]) => [
      symbol,
      new Map(rows.map((row) => [row.date, row])),
    ]),
  );
  const balance = new Map<string, number>();
  const changed = new Set<string>();
  const closed: { fill: EvidenceFill; changed: boolean }[] = [];
  for (const fill of fills) {
    const key = JSON.stringify([fill.strategyId, fill.symbol]);
    const expected =
      (balance.get(key) ?? 0) +
      (fill.side === "buy" ? fill.quantity : -fill.quantity);
    if (Math.abs(expected - fill.holdingAfter) > 1e-8) changed.add(key);
    balance.set(key, fill.holdingAfter);
    if (fill.holdingAfter === 0) {
      closed.push({ fill, changed: changed.has(key) });
      changed.delete(key);
    }
  }
  const rows = ledgerExcursions(fills, [], calendar, bars);
  return rows.map((row, i) => {
    const { fill, changed } = closed[i]!;
    const daily = byDate.get(row.symbol);
    let comparable = !changed;
    let first: number | undefined;
    for (const date of calendar) {
      if (date < row.openedAt || date > row.closedAt!) continue;
      const bar = daily?.get(date);
      if (!bar) continue;
      const ratio = (bar.signalClose ?? NaN) / bar.close;
      if (
        !Number.isFinite(ratio) ||
        ratio <= 0 ||
        (first !== undefined && Math.abs(ratio / first - 1) > 1e-8)
      ) {
        comparable = false;
        break;
      }
      first ??= ratio;
    }
    const reason = "归档未能核实持仓期间一致的股价基准";
    return {
      ...row,
      strategyId: fill.strategyId,
      sleeve: fill.sleeve,
      ...(!comparable && {
        entryAverage: null,
        entryAverageReason: reason,
        mae: null,
        mfe: null,
        reason,
      }),
      realizedNetReturn: null,
      realizedNetReturnReason: "归档缺少逐笔公司行动现金记录",
    };
  });
}

export function groupedScenarioEvidence(
  request: PortfolioRequest,
  result: Result,
  performance: PerformanceEvaluation,
): DiagnoseScenarioEvidence {
  const market = new Map(
    request.instruments.map((i) => [
      i.symbol,
      {
        actions: i.actions,
        execution: i.execution,
        daily: new Map(i.bars.map((b) => [b.date, b])),
      },
    ]),
  );
  const orders = new Map(result.orders.map((o) => [o.id, o]));
  const fullFills = result.fills.map((fill) => {
    const instrument = market.get(fill.symbol);
    const execution = instrument?.execution;
    const fact =
      !execution || typeof execution === "function"
        ? undefined
        : typeof execution.evidence === "string"
          ? (execution as PortfolioExecution)
          : (execution as Readonly<Record<string, PortfolioExecution>>)[
              fill.date
            ];
    const trigger = orders.get(fill.orderId)?.trigger;
    const opening = trigger === "signal" || trigger === "time";
    const changedBasis = instrument?.actions?.some(
      (a) => a.date > fill.signalAt && a.date <= fill.date,
    );
    return {
      ...fill,
      trigger,
      decisionClose:
        opening && !changedBasis && fill.signalAt < fill.date
          ? (instrument?.daily.get(fill.signalAt)?.close ?? null)
          : null,
      arrivalOpen: opening
        ? (instrument?.daily.get(fill.date)?.open ?? null)
        : null,
      limitUp: fact?.limitUp ?? null,
      limitDown: fact?.limitDown ?? null,
      limitEvidence: fact?.evidence ?? null,
    };
  });
  const equity = result.equity.map(({ date, equity: value }) => ({
    date,
    value,
  }));
  const bars = Object.fromEntries(
    request.instruments.map((i) => [i.symbol, i.bars]),
  );
  const evidenceNotes = [
    dailyRangeDisclosure,
    "涨跌停价格沿用冻结撮合情景，历史排队成交能力未核实。",
  ];
  let tradeExcursions: DiagnoseScenarioEvidence["tradeExcursions"];
  try {
    tradeExcursions = ledgerExcursions(
      fullFills,
      result.corporateActions,
      request.calendar,
      bars,
    ).map((row) => ({ ...row, sleeve: row.sleeve! }));
  } catch (error) {
    evidenceNotes.push(
      error instanceof Error ? error.message : "成交顺序无法还原完整持仓回合",
    );
  }
  return {
    fullFills,
    equity,
    performance,
    topDrawdowns: topDrawdownEpisodes(request.initial, equity),
    tradeExcursions,
    evidenceNotes,
  };
}
