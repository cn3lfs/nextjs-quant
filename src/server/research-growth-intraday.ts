import { confirmedExtrema } from "~/lib/indicators";
import type { Bar } from "~/lib/domain";
import type { ResearchEvent, ResearchSpec } from "~/lib/strategy-research";
import {
  researchNavStatistics,
  researchTradeStatistics,
} from "~/lib/strategy-research";
import { assertGrowthIntradayWindow } from "~/lib/research-growth-intraday";
import {
  researchFill,
  researchBuyQuantity,
  researchCommission,
  researchSellQuantity,
  type ResearchExecutionRules,
} from "~/lib/research-execution";
import { researchRiskQuantity } from "~/lib/research-risk";
import {
  researchPositionBook,
  researchBookBuy,
  researchBookSell,
  researchBookSellable,
} from "~/lib/research-position-book";
import type { researchPortfolio, ResearchTrade } from "./research-portfolio";
import { researchSepaSeries } from "./research-sepa";

export const growthMinuteTimes = Array.from({ length: 48 }, (_, i) => {
  const n = i < 24 ? 575 + i * 5 : 785 + (i - 24) * 5;
  return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`;
});
const valid = (b: Bar) =>
  [b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) &&
  Math.min(b.open, b.low, b.close) > 0 &&
  b.volume > 0 &&
  b.high >= Math.max(b.open, b.close, b.low) &&
  b.low <= Math.min(b.open, b.close);
export function growthMinuteDay(bars: readonly Bar[], date: string) {
  const rows = bars.filter((b) => b.date.slice(0, 10) === date);
  return rows.length === 48 &&
    rows.every(
      (b, i) =>
        b.date === `${date}T${growthMinuteTimes[i]}:00+08:00` && valid(b),
    )
    ? rows
    : null;
}
/** The current partial daily candle contains only completed five-minute bars. */
export function growthIntradayEntries(
  symbol: string,
  daily: readonly Bar[],
  minutes: readonly Bar[],
  calendar: readonly string[],
  spec: ResearchSpec,
): ResearchEvent[] {
  const result: ResearchEvent[] = [];
  let usable = false;
  for (let i = 0; i < daily.length; i++) {
    const date = daily[i]!.date;
    if (date < spec.start || date > spec.end) continue;
    const rows = growthMinuteDay(minutes, date);
    if (!rows) continue;
    let partial: Bar = { ...rows[0]!, date, volume: 0, amount: 0 };
    for (const [j, b] of rows.entries()) {
      partial = {
        ...partial,
        high: Math.max(partial.high, b.high),
        low: Math.min(partial.low, b.low),
        close: b.close,
        volume: partial.volume + b.volume,
        amount: partial.amount + b.amount,
      };
      // 15:00 cannot create the first intraday leg at a same-close fill.
      if (j === 47) break;
      const point = researchSepaSeries(
        "sepa-vcp-close",
        [...daily.slice(0, i), partial],
        calendar,
        i,
      ).at(-1)!;
      if (point.reason === null) usable = true;
      if (point.entry && point.candidate) {
        result.push({
          symbol,
          observedDate: date,
          endpointDate: date,
          intradayAt: b.date,
          key: `growth-intraday-1:${symbol}:${b.date}`,
          strategyVersion: "growth-intraday-1",
          partition:
            date >= spec.validationStart ? "validation" : "development",
          evidence: JSON.stringify(point),
          historyStart: point.historyStart!,
          entryPriceRange: {
            min: point.candidate.high,
            max: point.maxEntryPrice!,
          },
        });
        break;
      }
    }
  }
  if (!usable)
    throw new Error(
      "研究区间没有完整五分钟日及可用SEPA形态输入，不能将缺失视为零信号",
    );
  return result;
}

/** Six explicit growth-method experiments. Shared fill, sizing and lot rules stay authoritative. */
export function researchGrowthIntraday(
  spec: ResearchSpec,
  events: readonly ResearchEvent[],
  calendar: readonly string[],
  daily: ReadonlyMap<string, readonly Bar[]>,
  minutes: ReadonlyMap<string, readonly Bar[]>,
  rules: (symbol: string, date: string) => ResearchExecutionRules | null,
  result: ReturnType<typeof researchPortfolio>,
): ReturnType<typeof researchPortfolio> {
  assertGrowthIntradayWindow(spec.start, spec.end);
  const id = spec.management!.growthIntraday!;
  const days = calendar.filter((d) => d >= spec.start && d <= spec.end);
  if (days.some((d, i) => i > 0 && d <= days[i - 1]!))
    throw new Error("研究日历未严格递增");
  const fraction = id.startsWith("RK-")
    ? 0.05
    : id.startsWith("SE-")
      ? 0.1
      : 0.08;
  const positions = new Map<
    string,
    {
      trade: ResearchTrade;
      stop: number;
      planned: number;
      completedMinutes: number;
      timeChecked: boolean;
      pending: { quantity: number; reason: string; at: string } | null;
      add: boolean;
      reduced: boolean;
    }
  >();
  const finished = new Set<ResearchEvent>();
  const ordered = [...events].sort(
    (a, b) =>
      (a.intradayAt ?? a.observedDate).localeCompare(
        b.intradayAt ?? b.observedDate,
      ) ||
      a.symbol.localeCompare(b.symbol) ||
      a.key.localeCompare(b.key),
  );
  let cash = spec.initialCapital;
  result.trades = [];
  result.nav = [];
  result.attempts = [];
  result.excluded = [];
  result.signalGaps = [];
  const indexed = new Map(
    [...daily].map(([s, b]) => [s, new Map(b.map((x) => [x.date, x]))]),
  );
  const grouped = new Map(
    [...minutes].map(([s, b]) => {
      const m = new Map<string, Bar[]>();
      for (const row of b) {
        const d = row.date.slice(0, 10);
        if (!m.has(d)) m.set(d, []);
        m.get(d)!.push(row);
      }
      return [s, m] as const;
    }),
  );
  for (const [index, date] of days.entries()) {
    const available = new Map<string, Bar[]>();
    for (const [symbol] of daily) {
      const rows = growthMinuteDay(grouped.get(symbol)?.get(date) ?? [], date);
      const bar = indexed.get(symbol)?.get(date);
      if (rows && bar && valid(bar)) available.set(symbol, rows);
      else
        result.signalGaps.push({
          symbol,
          date,
          reason: "该证券该研究日五分钟48根或日线不完整；不可用，不顺延预案",
        });
    }
    // At each boundary, orders consume only earlier observations; all sells precede buys.
    for (let slot = 0; slot < 48; slot++) {
      const at = `${date}T${slot === 0 ? "09:30" : slot === 24 ? "13:00" : growthMinuteTimes[slot - 1]}:00+08:00`;
      for (const [symbol, state] of positions) {
        const rows = available.get(symbol);
        if (!rows) continue;
        const t = state.trade,
          remaining = t.book!.remainingQuantity;
        if (slot === 0 && index - t.entryIndex >= spec.holdingDays)
          state.pending = {
            quantity: remaining,
            reason: "达到最长持有交易日",
            at,
          };
        const nextDay = index === t.entryIndex + 1;
        if (
          slot === 1 &&
          nextDay &&
          (id.endsWith("gapup3") || id.endsWith("gapdown3"))
        ) {
          const prior = indexed.get(symbol)?.get(days[index - 1]!);
          const open = indexed.get(symbol)!.get(date)!.open;
          if (prior && valid(prior)) {
            if (id.endsWith("gapup3") && open > prior.close * 1.03 + 1e-10) {
              state.stop = Math.max(state.stop, t.entryPrice);
              t.stopHistory!.push({
                date: at,
                stop: state.stop,
                reason: "次日9:30日线开盘高开严格超过3%，9:35起保本",
              });
            }
            if (
              id.endsWith("gapdown3") &&
              open < prior.close * 0.97 - 1e-10 &&
              !state.pending
            )
              state.pending = {
                quantity: remaining * 0.5,
                reason: "次日低开严格超过3%减半",
                at,
              };
          } else
            t.managementWarnings!.push({
              date,
              reason: "缺少前日收盘，次日跳空预案不可用",
            });
        }
        const previous = slot > 0 ? rows[slot - 1] : null;
        if (
          previous &&
          (id.startsWith("RK-")
            ? previous.low <= state.stop
            : previous.close < state.stop && date > t.entryDate)
        )
          state.pending = {
            quantity: remaining,
            reason: id.startsWith("RK-")
              ? "完成五分钟最低价触碰止损，下一根开盘"
              : "五分钟收盘跌破止损",
            at: previous.date,
          };
        if (id.startsWith("RK-A-intraday") && previous && !state.timeChecked) {
          state.completedMinutes += 5;
          if (state.completedMinutes >= 30) {
            state.timeChecked = true;
            if (
              previous.close <
                t.entryPrice + 0.5 * (t.entryPrice - t.initialStop!) &&
              !state.pending
            )
              state.pending = {
                quantity: remaining,
                reason: "30交易分钟收盘未达0.5R，时间止损",
                at: previous.date,
              };
          }
        }
        const request = state.pending;
        if (!request || request.at > at || date <= t.entryDate) continue;
        const rule = rules(symbol, date),
          fill = researchFill(rows[slot], "sell", rule, spec.costs);
        if (fill.price === null || !rule) {
          result.attempts.push({
            symbol,
            date: at,
            side: "sell",
            reason: fill.reason ?? "规则缺失",
          });
          continue;
        }
        const qty = researchSellQuantity(
          Math.min(request.quantity, researchBookSellable(t.book!, date)),
          remaining,
          rule,
        );
        if (!qty) {
          result.attempts.push({
            symbol,
            date: at,
            side: "sell",
            reason:
              qty === null ? "缺少卖出数量依据" : "目标不足申报量或T+1不可卖",
          });
          continue;
        }
        const commission = researchCommission(qty * fill.price, spec.costs),
          tax = (qty * fill.price * spec.costs.sellTaxBps) / 10000;
        const sold = researchBookSell(t.book!, {
          date,
          quantity: qty,
          price: fill.price,
          commission,
          tax,
        });
        t.book = sold.book;
        cash += sold.netProceeds;
        t.remainingQuantity = t.book.remainingQuantity;
        t.realizedProceeds = t.book.realizedProceeds;
        t.realizedProfit = t.book.realizedProfit;
        t.sales!.push({
          date: at,
          triggerDate: request.at,
          quantity: qty,
          price: fill.price,
          commission,
          tax,
          netProceeds: sold.netProceeds,
          reason: request.reason,
        });
        state.add = false;
        state.reduced = true;
        request.quantity -= qty;
        if (request.quantity < 1e-8) state.pending = null;
        if (t.remainingQuantity === 0) {
          t.exitDate = date;
          t.exitReason = request.reason;
          t.exitPrice =
            t.sales!.reduce((s, r) => s + r.quantity * r.price, 0) /
            t.book.totalQuantity;
          t.profit = t.book.realizedProfit;
          t.netReturn = t.profit / t.entryCost;
          t.holdingTradingDays = index - t.entryIndex;
          positions.delete(symbol);
        }
      }
      if (slot === 0)
        for (const [symbol, state] of positions) {
          if (!state.add || state.pending || state.reduced) continue;
          state.add = false; // A close-confirmed addition has one scheduled next-open attempt.
          const rows = available.get(symbol),
            t = state.trade;
          if (!rows) {
            t.managementWarnings!.push({
              date,
              reason: "补仓日缺失，取消补仓",
            });
            continue;
          }
          const rule = rules(symbol, date),
            fill = researchFill(rows[0], "buy", rule, spec.costs);
          if (
            fill.price === null ||
            !rule ||
            !t.event.entryPriceRange ||
            fill.price < t.event.entryPriceRange.min ||
            fill.price > t.event.entryPriceRange.max
          ) {
            t.managementWarnings!.push({
              date,
              reason: "补仓不可成交或越过冻结枢纽范围，取消",
            });
            continue;
          }
          const equity =
            cash +
            [...positions.values()].reduce(
              (s, p) => s + p.trade.book!.remainingQuantity * p.trade.lastPrice,
              0,
            );
          const capacity = researchRiskQuantity({
            cash: cash + t.book!.remainingQuantity * fill.price,
            equity,
            price: fill.price,
            stop: state.stop,
            fraction: spec.risk!.fraction,
            maxWeight: spec.risk!.maxWeight,
            rules: rule,
            costs: spec.costs,
          });
          const qty = researchBuyQuantity(
            Math.min(
              cash,
              Math.max(
                0,
                Math.min(state.planned, capacity) - t.book!.remainingQuantity,
              ) * fill.price,
            ),
            fill.price,
            rule,
            spec.costs,
          );
          if (!qty) continue;
          const commission = researchCommission(qty * fill.price, spec.costs);
          t.book = researchBookBuy(t.book!, {
            date,
            quantity: qty,
            price: fill.price,
            commission,
          });
          cash -= qty * fill.price + commission;
          t.entryCost = t.book.totalCost;
          t.remainingQuantity = t.book.remainingQuantity;
          t.entries!.push({
            date: at,
            triggerDate: `${days[index - 1]}T15:00:00+08:00`,
            quantity: qty,
            price: fill.price,
            commission,
            plannedRisk: null,
            stop: state.stop,
          });
        }
      for (const event of ordered) {
        if (finished.has(event)) continue;
        const signalIndex = days.indexOf(event.observedDate);
        const due = event.intradayAt
          ? event.observedDate === date &&
            slot > 0 &&
            event.intradayAt === available.get(event.symbol)?.[slot - 1]?.date
          : slot === 0 && signalIndex >= 0 && index > signalIndex;
        if (!due) continue;
        if (!event.intradayAt && index - signalIndex > spec.entryMaxWait) {
          finished.add(event);
          result.excluded.push({ event, reason: "入场等待期结束" });
          continue;
        }
        if (positions.has(event.symbol)) {
          finished.add(event);
          result.excluded.push({ event, reason: "已有持仓不重复入场" });
          continue;
        }
        if (positions.size >= spec.maxPositions) continue;
        if ([...positions.keys()].some((symbol) => !available.has(symbol))) {
          result.attempts.push({
            symbol: event.symbol,
            date: at,
            side: "buy",
            reason: "已有持仓本日行情不可用，暂停新增风险",
          });
          if (event.intradayAt) finished.add(event);
          continue;
        }
        const rows = available.get(event.symbol),
          rule = rules(event.symbol, date),
          fill = researchFill(rows?.[slot], "buy", rule, spec.costs);
        if (fill.price === null || !rule) {
          result.attempts.push({
            symbol: event.symbol,
            date: at,
            side: "buy",
            reason: fill.reason ?? "规则缺失",
          });
          if (event.intradayAt) finished.add(event);
          continue;
        }
        if (
          event.entryPriceRange &&
          (fill.price < event.entryPriceRange.min ||
            fill.price > event.entryPriceRange.max)
        ) {
          finished.add(event);
          result.excluded.push({ event, reason: "越过冻结枢纽区间" });
          continue;
        }
        if (researchSellQuantity(1, 1, rule) === null) {
          finished.add(event);
          result.excluded.push({ event, reason: "缺少完整卖出数量依据" });
          continue;
        }
        const equity =
            cash +
            [...positions.values()].reduce(
              (s, p) => s + p.trade.book!.remainingQuantity * p.trade.lastPrice,
              0,
            ),
          stop =
            id === "RK-A-intraday-points30"
              ? fill.price - 0.5
              : id === "RK-A-intraday-structure30"
                ? (() => {
                    const previousDate = calendar
                      .filter((d) => d < date)
                      .at(-1);
                    const prefix = previousDate
                      ? growthMinuteDay(
                          minutes.get(event.symbol) ?? [],
                          previousDate,
                        )
                      : null;
                    return prefix
                      ? (confirmedExtrema(prefix)
                          .extrema.filter((p) => p.kind === "low")
                          .at(-1)?.price ?? NaN)
                      : NaN;
                  })()
                : fill.price * (1 - fraction);
        if (!Number.isFinite(stop) || stop <= 0 || stop >= fill.price) {
          finished.add(event);
          result.excluded.push({
            event,
            reason: "missing: 五分钟结构缺失或开盘失守",
          });
          continue;
        }
        const planned = researchRiskQuantity({
          cash,
          equity,
          price: fill.price,
          stop,
          fraction: spec.risk!.fraction,
          maxWeight: spec.risk!.maxWeight,
          rules: rule,
          costs: spec.costs,
        });
        const desired = event.intradayAt ? planned / 2 : planned;
        const qty =
          desired < rule.minimumBuy
            ? 0
            : rule.minimumBuy +
              Math.floor((desired - rule.minimumBuy) / rule.buyStep) *
                rule.buyStep;
        finished.add(event);
        if (!qty) {
          result.excluded.push({
            event,
            reason: "风险预算或半仓不足最小买入量",
          });
          continue;
        }
        const commission = researchCommission(qty * fill.price, spec.costs),
          book = researchBookBuy(researchPositionBook(), {
            date,
            quantity: qty,
            price: fill.price,
            commission,
          });
        cash -= book.totalCost;
        const trade: ResearchTrade = {
          event,
          entryDate: date,
          entryIndex: index,
          entryPrice: fill.price,
          quantity: qty,
          entryCost: book.totalCost,
          exitDate: null,
          exitPrice: null,
          netReturn: null,
          profit: null,
          lastPrice: fill.price,
          initialStop: stop,
          book,
          remainingQuantity: qty,
          plannedQuantity: planned,
          realizedProceeds: 0,
          realizedProfit: 0,
          entries: [
            {
              date: at,
              triggerDate: event.intradayAt ?? event.observedDate,
              quantity: qty,
              price: fill.price,
              commission,
              plannedRisk: null,
              stop,
            },
          ],
          sales: [],
          stopHistory: [{ date: at, stop, reason: "固定初始止损" }],
          managementWarnings: [],
        };
        result.trades.push(trade);
        positions.set(event.symbol, {
          trade,
          stop,
          completedMinutes: 0,
          timeChecked: false,
          planned,
          pending: null,
          add: false,
          reduced: false,
        });
      }
    }
    const stale: string[] = [];
    for (const [symbol, state] of positions) {
      const rows = available.get(symbol),
        t = state.trade;
      if (!rows) {
        stale.push(symbol);
        state.add = false;
        continue;
      }
      t.lastPrice = rows[47]!.close;
      if (
        id.startsWith("RK-")
          ? rows[47]!.low <= state.stop
          : t.lastPrice < state.stop
      )
        state.pending = {
          quantity: t.book!.remainingQuantity,
          reason: id.startsWith("RK-")
            ? "15:00完成五分钟触碰，下一交易日开盘"
            : "15:00收盘跌破止损",
          at: rows[47]!.date,
        };
      if (id === "CA-D-review1430" && !state.pending) {
        const prior = indexed
          .get(symbol)
          ?.get(calendar[calendar.indexOf(date) - 1]!);
        const review = rows[41]!;
        if (prior && valid(prior) && review.close < prior.close * 0.98 - 1e-10)
          state.pending = {
            quantity: t.book!.remainingQuantity * 0.5,
            reason: "14:30较昨收跌超2%异常减半",
            at: review.date,
          };
      }
      if (eventIsHalf(t.event) && t.entryDate === date && !state.pending) {
        const prefix = (daily.get(symbol) ?? []).filter((b) => b.date < date);
        const average = prefix
          .slice(-20)
          .reduce((s, b) => s + b.volume / 20, 0);
        state.add =
          !!t.event.entryPriceRange &&
          t.lastPrice > t.event.entryPriceRange.min * 1.01 &&
          t.lastPrice <= t.event.entryPriceRange.max &&
          rows.reduce((s, b) => s + b.volume, 0) >= average * 1.5;
      }
    }
    result.nav.push({
      date,
      cash,
      value:
        cash +
        [...positions.values()].reduce(
          (s, p) => s + p.trade.book!.remainingQuantity * p.trade.lastPrice,
          0,
        ),
      stale,
    });
  }
  result.unfilled = ordered.filter((e) => !finished.has(e));
  result.openPositions = positions.size;
  result.staleValuation = result.nav.some((n) => n.stale.length > 0);
  result.statistics = researchTradeStatistics(
    result.trades.flatMap((t) => (t.netReturn === null ? [] : [t.netReturn])),
  );
  result.navStatistics = researchNavStatistics(
    spec.initialCapital,
    result.nav.map((n) => n.value),
    spec.annualRiskFreeRate,
  );
  if (result.staleValuation) result.navStatistics.sharpe = null;
  result.pendingSales = [...positions].flatMap(([symbol, s]) =>
    s.pending
      ? [
          {
            symbol,
            remainingQuantity: s.trade.book!.remainingQuantity,
            targetQuantity: s.pending.quantity,
            triggerDate: s.pending.at,
            reason: s.pending.reason,
          },
        ]
      : [],
  );
  result.pendingAdditions = [...positions].flatMap(([symbol, s]) =>
    s.add
      ? [
          {
            symbol,
            stage: 0,
            triggerDate: days.at(-1)!,
            triggerIndex: days.length - 1,
          },
        ]
      : [],
  );
  return result;
}
const eventIsHalf = (event: ResearchEvent) => !!event.intradayAt;
