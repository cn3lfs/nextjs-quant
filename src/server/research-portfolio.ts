import type { Bar } from "~/lib/domain";
import {
  researchNavStatistics,
  researchTradeStatistics,
  type ResearchEvent,
  type ResearchSpec,
} from "~/lib/strategy-research";
import {
  researchBuyQuantity,
  researchCommission,
  researchFill,
  type ResearchExecutionRules,
} from "~/lib/research-execution";

export type ResearchTrade = {
  event: ResearchEvent;
  entryDate: string;
  entryIndex: number;
  entryPrice: number;
  quantity: number;
  entryCost: number;
  exitDate: string | null;
  exitPrice: number | null;
  netReturn: number | null;
  profit: number | null;
  lastPrice: number;
  holdingTradingDays?: number;
};

/** Equal initial-capital allocation, stable chronological/code tie breaking.
 * Rules and company-action eligibility are supplied by the frozen experiment.
 */
export function researchPortfolio(
  spec: ResearchSpec,
  events: readonly ResearchEvent[],
  calendar: readonly string[],
  series: ReadonlyMap<string, readonly Bar[]>,
  rules: (symbol: string, date: string) => ResearchExecutionRules | null,
) {
  const days = calendar.filter(
    (date) => date >= spec.start && date <= spec.end,
  );
  if (days.some((date, i) => i > 0 && date <= days[i - 1]!))
    throw new Error("组合交易日历无效");
  const indexed = new Map(
    [...series].map(([symbol, bars]) => [
      symbol,
      new Map(bars.map((bar) => [bar.date, bar])),
    ]),
  );
  const pending = [...events].sort(
    (a, b) =>
      a.observedDate.localeCompare(b.observedDate) ||
      a.symbol.localeCompare(b.symbol) ||
      a.key.localeCompare(b.key),
  );
  const trades: ResearchTrade[] = [],
    positions = new Map<string, ResearchTrade>();
  const attempts: {
    symbol: string;
    date: string;
    side: "buy" | "sell";
    reason: string;
  }[] = [];
  const excluded: { event: ResearchEvent; reason: string }[] = [];
  const finished = new Set<ResearchEvent>();
  const nav: { date: string; value: number; cash: number; stale: string[] }[] =
    [];
  let cash = spec.initialCapital;
  for (let index = 0; index < days.length; index++) {
    const date = days[index]!;
    for (const [symbol, trade] of positions) {
      if (
        index - trade.entryIndex < spec.holdingDays ||
        date <= trade.entryDate
      )
        continue;
      const bar = indexed.get(symbol)?.get(date);
      const fill = researchFill(bar, "sell", rules(symbol, date), spec.costs);
      if (fill.price === null) {
        attempts.push({ symbol, date, side: "sell", reason: fill.reason });
        continue;
      }
      const amount = trade.quantity * fill.price;
      const proceeds =
        amount -
        researchCommission(amount, spec.costs) -
        (amount * spec.costs.sellTaxBps) / 10000;
      cash += proceeds;
      trade.exitDate = date;
      trade.holdingTradingDays = index - trade.entryIndex;
      trade.exitPrice = fill.price;
      trade.profit = proceeds - trade.entryCost;
      trade.netReturn = trade.profit / trade.entryCost;
      positions.delete(symbol);
    }
    for (const event of pending) {
      if (finished.has(event) || event.observedDate >= date) continue;
      const signalIndex = days.indexOf(event.observedDate);
      if (signalIndex < 0) {
        excluded.push({ event, reason: "信号不在模拟区间交易日历" });
        finished.add(event);
        continue;
      }
      if (index - signalIndex > spec.entryMaxWait) {
        excluded.push({ event, reason: "入场等待期结束仍未成交" });
        finished.add(event);
        continue;
      }
      if (positions.has(event.symbol)) {
        excluded.push({ event, reason: "同股已有持仓，不重复加仓" });
        finished.add(event);
        continue;
      }
      if (positions.size >= spec.maxPositions) {
        attempts.push({
          symbol: event.symbol,
          date,
          side: "buy",
          reason: "持仓数量已满",
        });
        continue;
      }
      const dailyRules = rules(event.symbol, date);
      const fill = researchFill(
        indexed.get(event.symbol)?.get(date),
        "buy",
        dailyRules,
        spec.costs,
      );
      if (fill.price === null || !dailyRules) {
        attempts.push({
          symbol: event.symbol,
          date,
          side: "buy",
          reason: fill.reason ?? "缺少规则",
        });
        continue;
      }
      const quantity = researchBuyQuantity(
        Math.min(cash, spec.initialCapital / spec.maxPositions),
        fill.price,
        dailyRules,
        spec.costs,
      );
      if (!quantity) {
        attempts.push({
          symbol: event.symbol,
          date,
          side: "buy",
          reason: "资金不足最小申报数量及费用",
        });
        continue;
      }
      const amount = quantity * fill.price,
        entryCost = amount + researchCommission(amount, spec.costs);
      cash -= entryCost;
      const trade: ResearchTrade = {
        event,
        entryDate: date,
        entryIndex: index,
        entryPrice: fill.price,
        quantity,
        entryCost,
        exitDate: null,
        exitPrice: null,
        profit: null,
        netReturn: null,
        lastPrice: fill.price,
      };
      positions.set(event.symbol, trade);
      trades.push(trade);
      finished.add(event);
    }
    const stale: string[] = [];
    let value = cash;
    for (const [symbol, position] of positions) {
      const bar = indexed.get(symbol)?.get(date);
      if (bar && Number.isFinite(bar.close) && bar.close > 0)
        position.lastPrice = bar.close;
      else stale.push(symbol);
      value += position.quantity * position.lastPrice;
    }
    nav.push({ date, value, cash, stale });
  }
  const unfilled = pending.filter((event) => !finished.has(event));
  const statistics = researchTradeStatistics(
    trades.flatMap((trade) =>
      trade.netReturn === null ? [] : [trade.netReturn],
    ),
  );
  const navStatistics = researchNavStatistics(
    spec.initialCapital,
    nav.map((point) => point.value),
    spec.annualRiskFreeRate,
  );
  const staleValuation = nav.some((point) => point.stale.length > 0);
  return {
    trades,
    attempts,
    excluded,
    unfilled,
    nav,
    statistics,
    navStatistics: {
      ...navStatistics,
      sharpe: staleValuation ? null : navStatistics.sharpe,
    },
    staleValuation,
    openPositions: trades.filter((trade) => !trade.exitDate).length,
  };
}
