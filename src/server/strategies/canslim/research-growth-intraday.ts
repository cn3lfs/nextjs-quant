import { analyzeBreakout } from "../breakout/breakout";
import { big, bpsOf, moneyMul, toNumber } from "trading-strategy-core/money";
import {
  isIntradayExecution,
  intradayExecutionEvidence,
  intradayEntryPolicy,
  intradayExitPolicy,
  intradaySessionActive,
} from "~/lib/research-intraday-execution";
import {
  isMarketAdmission,
  marketAdmissionDecision,
} from "~/lib/research-market-admission";
import {
  isOpening,
  openingDecision,
  type OpeningId,
} from "~/lib/research-opening";
import { atr, rollingHigh } from "trading-strategy-core/indicators";
import { researchAccountRisk } from "~/lib/research-account-risk";
import { researchInitialStop } from "~/lib/research-management";
import { researchLiquidity } from "~/lib/research-liquidity";
import { contextRiskPoint } from "~/lib/research-context-risk";
import { swingCalibration } from "~/lib/research-risk-scenarios";
import { confirmedExtrema } from "trading-strategy-core/indicators";
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
import { researchRiskQuantity, plannedStopRisk } from "~/lib/research-risk";
import {
  researchPositionBook,
  researchBookBuy,
  researchBookSell,
  researchBookSellable,
} from "~/lib/research-position-book";
import type {
  researchPortfolio,
  ResearchTrade,
} from "../../backtest/research-portfolio";
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
  assertGrowthIntradayWindow(spec.start, spec.end);
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
      if (spec.management?.growthIntraday === "SW02-last30") {
        if (j < 41) continue;
        const point = analyzeBreakout([...daily.slice(0, i), partial]).latest;
        if (point?.long.status !== "未知") usable = true;
        if (point?.long.status === "是") {
          result.push({
            symbol,
            observedDate: date,
            endpointDate: date,
            intradayAt: b.date,
            key: `sw-last30-1:${symbol}:${b.date}`,
            strategyVersion: "sw-last30-1",
            partition:
              date >= spec.validationStart ? "validation" : "development",
            evidence: JSON.stringify({
              point,
              completedBars: j + 1,
              volume: partial.volume,
            }),
            historyStart: daily[0]!.date,
          });
          break;
        }
        continue;
      }
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

/** Named minute experiments share the authoritative fill, sizing and lot rules. */
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
  const opening = isOpening(id);
  const admission = isMarketAdmission(id);
  const execution = isIntradayExecution(id);
  const swing = id === "RK-C-swing-system";
  const days = calendar.filter((d) => d >= spec.start && d <= spec.end);
  const week = swing
    ? researchAccountRisk("week3r", days, spec.initialCapital)
    : null;
  const streak = swing
    ? researchAccountRisk("streak5-half", days, spec.initialCapital)
    : null;
  if (days.some((d, i) => i > 0 && d <= days[i - 1]!))
    throw new Error("研究日历未严格递增");
  const fraction =
    id === "SW02-last30" || admission || id.startsWith("RK-")
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
      pending: {
        quantity: number;
        reason: string;
        at: string;
        limit?: number | null;
        rotation?: boolean;
        auction?: boolean;
        soldQuantity?: number;
      } | null;
      add: boolean;
      reduced: boolean;
      scaled: boolean;
      tailReady: boolean;
      maxR: number;
      eventIds: Set<string>;
      openingReduced: string | null;
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
  const rotationCaps = new Map<string, number>();
  const auctionConsumed = new Map<string, number>();
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
    week?.begin(index);
    streak?.begin(index);
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
    const decideOpening = (symbol: string, slot: number) => {
      const dayIndex = calendar.indexOf(date);
      const previousDate = calendar[dayIndex - 1];
      const yesterday = previousDate
        ? indexed.get(symbol)?.get(previousDate)
        : undefined;
      const today = indexed.get(symbol)?.get(date);
      if (!yesterday || !today) return null;
      const priorDates = calendar.slice(Math.max(0, dayIndex - 5), dayIndex);
      return openingDecision({
        id: id as OpeningId,
        symbol,
        date,
        previousDate: previousDate!,
        open: today.open,
        yesterday,
        completed: (available.get(symbol) ?? []).slice(0, slot),
        priorMinutes: priorDates.map(
          (d) => growthMinuteDay(grouped.get(symbol)?.get(d) ?? [], d) ?? [],
        ),
        plans: spec.management?.openingPlans ?? [],
      });
    };
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
        if (opening && slot > 0) {
          const decision = decideOpening(symbol, slot);
          const recent = rows.slice(Math.max(0, slot - 2), slot);
          if (
            recent.length === 2 &&
            recent.every((b) => b.close < state.stop) &&
            (!state.pending || state.pending.quantity < remaining)
          )
            state.pending = {
              quantity: remaining,
              reason: "冻结生命线两根收盘失守",
              at: rows[slot - 1]!.date,
            };
          if (
            decision?.status === "available" &&
            decision.stop != null &&
            decision.stop > state.stop
          ) {
            state.stop = decision.stop;
            t.stopHistory!.push({
              date: at,
              stop: state.stop,
              reason: "前日冻结计划生命线仅抬高",
            });
          }
          if (!decision || decision.status === "missing") {
            if (!t.managementWarnings!.some((w) => w.date === date))
              t.managementWarnings!.push({
                date,
                reason: decision?.reason ?? "待数据：前日行情/开盘计划",
              });
          } else if (
            decision.sell &&
            (!state.pending ||
              (decision.sell === 1 && state.pending.quantity < remaining))
          ) {
            if (decision.sell === 1 || state.openingReduced !== date) {
              if (decision.sell < 1) state.openingReduced = date;
              state.pending = {
                quantity:
                  decision.sell === 1
                    ? remaining
                    : Math.min(remaining, t.quantity * decision.sell),
                reason: decision.reason,
                at: rows[slot - 1]!.date,
              };
            }
          }
        }
        const executionRow = execution
          ? intradayExecutionEvidence(
              spec.management?.intradayExecutionInputs ?? [],
              symbol,
              date,
              at,
            )
          : null;
        if (execution) {
          const policy = intradayExitPolicy(id, {
            row: executionRow,
            date,
            calendar,
            at,
            previous: rows[slot - 1],
            entry: t.entryPrice,
            stop: state.stop,
            rule: rules(symbol, date),
          });
          if (
            policy.missing &&
            !t.managementWarnings!.some(
              (w) => w.date === date && w.reason.includes(policy.missing!),
            )
          )
            t.managementWarnings!.push({
              date,
              reason: `待数据：${policy.missing}`,
            });
          if (
            policy.fraction &&
            (!state.pending ||
              (policy.fraction === 1 && state.pending.quantity < remaining)) &&
            (policy.fraction === 1 || state.openingReduced !== date)
          ) {
            state.openingReduced = date;
            state.pending = {
              quantity: policy.rotation
                ? researchBookSellable(t.book!, date)
                : policy.fraction === 1
                  ? remaining
                  : Math.min(remaining, t.quantity * policy.fraction),
              reason: policy.reason,
              at: rows[slot - 1]?.date ?? at,
              limit: policy.limit,
              rotation: policy.rotation,
            };
            if (state.pending.quantity === 0) state.pending = null;
          }
          if (id === "RK-X-auction-queue" && slot === 0 && !state.pending) {
            const priorDate = calendar[calendar.indexOf(date) - 1]!,
              prior = indexed.get(symbol)?.get(priorDate),
              priorRule = rules(symbol, priorDate);
            if (
              prior &&
              priorRule?.limitDown != null &&
              prior.high === prior.low &&
              prior.close <= priorRule.limitDown
            )
              state.pending = {
                quantity: remaining,
                reason: "一字跌停后次日竞价排队意图，等待成交证明",
                at: `${priorDate}T15:00:00+08:00`,
                auction: true,
              };
          }
        }
        const previous = slot > 0 ? rows[slot - 1] : null;
        if (
          previous &&
          !opening &&
          !execution &&
          (swing
            ? previous.low <= t.entryPrice - 2 * (t.entryPrice - t.initialStop!)
            : id.startsWith("RK-")
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
        if (swing && previous)
          t.swingMae = Math.max(t.swingMae ?? 0, t.entryPrice - previous.low);
        const request = state.pending;
        if (!request || request.at > at || date <= t.entryDate) continue;
        const rule = rules(symbol, date);
        if (
          id === "RK-X-conditional" &&
          !intradaySessionActive(executionRow, at)
        )
          continue;
        let fill = researchFill(rows[slot], "sell", rule, spec.costs);
        let auctionQuantity = Infinity;
        if (request.auction) {
          const proof = executionRow?.auction;
          if (
            slot !== 0 ||
            !proof ||
            !rule ||
            rule.limitDown == null ||
            proof.limitPrice !== rule.limitDown ||
            proof.submittedAt.slice(0, 10) !== date ||
            proof.submittedAt.slice(11, 16) < "09:15" ||
            proof.submittedAt.slice(11, 16) > "09:25" ||
            !proof.filledAt ||
            proof.filledAt !== `${date}T09:25:00+08:00` ||
            Date.parse(proof.submittedAt) > Date.parse(proof.filledAt) ||
            Date.parse(proof.filledAt) >
              Date.parse(executionRow!.availableAt) ||
            proof.fillPrice == null ||
            proof.fillPrice < proof.limitPrice ||
            (rule.limitUp != null && proof.fillPrice > rule.limitUp) ||
            !rule.tradable
          ) {
            if (slot === 0)
              result.attempts.push({
                symbol,
                date: at,
                side: "sell",
                reason: "待数据：竞价队列及可知成交证明，连续交易open不替代",
              });
            continue;
          }
          auctionQuantity =
            proof.filledQuantity - (auctionConsumed.get(proof.queueId) ?? 0);
          if (auctionQuantity <= 0) continue;
          fill = { price: proof.fillPrice, reason: null };
        }
        if (
          request.limit != null &&
          fill.price != null &&
          fill.price < request.limit
        ) {
          result.attempts.push({
            symbol,
            date: at,
            side: "sell",
            reason: "下一根开盘低于冻结限价，保留未成交",
          });
          continue;
        }
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
          Math.min(
            request.quantity,
            researchBookSellable(t.book!, date),
            auctionQuantity,
          ),
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
        if (swing)
          t.swingMae = Math.max(t.swingMae ?? 0, t.entryPrice - fill.price);
        const sellAmount = moneyMul(qty, fill.price);
        const commission = researchCommission(sellAmount, spec.costs),
          tax = bpsOf(sellAmount, spec.costs.sellTaxBps);
        const sold = researchBookSell(t.book!, {
          date,
          quantity: qty,
          price: fill.price,
          commission,
          tax,
        });
        t.book = sold.book;
        cash = toNumber(big(cash).plus(sold.netProceeds));
        t.remainingQuantity = t.book.remainingQuantity;
        t.realizedProceeds = t.book.realizedProceeds;
        t.realizedProfit = t.book.realizedProfit;
        t.sales!.push({
          date: request.auction ? executionRow!.auction!.filledAt! : at,
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
        if (request.auction && executionRow?.auction)
          auctionConsumed.set(
            executionRow.auction.queueId,
            (auctionConsumed.get(executionRow.auction.queueId) ?? 0) + qty,
          );
        request.soldQuantity = (request.soldQuantity ?? 0) + qty;
        if (
          request.rotation &&
          request.quantity - qty < 1e-8 &&
          t.remainingQuantity === 0
        ) {
          const key = `${t.event.key}:rotate:${at}`;
          rotationCaps.set(key, request.soldQuantity);
          ordered.push({
            ...t.event,
            observedDate: date,
            endpointDate: date,
            intradayAt: rows[slot]!.date,
            key,
            evidence: JSON.stringify({
              soldAt: at,
              soldQuantity: request.soldQuantity,
              source: executionRow,
            }),
            historyStart: t.event.historyStart,
          });
        }
        request.quantity -= qty;
        if (request.quantity < 1e-8) {
          if (swing && request.reason.startsWith("2R")) state.tailReady = true;
          state.pending = null;
        }
        if (t.remainingQuantity === 0) {
          t.exitDate = date;
          t.exitReason = request.reason;
          t.exitPrice =
            t.sales!.reduce((s, r) => s + r.quantity * r.price, 0) /
            t.book.totalQuantity;
          t.profit = t.book.realizedProfit;
          t.netReturn = t.profit / t.entryCost;
          t.holdingTradingDays = index - t.entryIndex;
          if (swing) {
            const risk = plannedStopRisk(
              t.quantity,
              t.entryPrice,
              t.initialStop!,
              spec.costs,
            );
            week!.settle(index, t.profit, risk);
            streak!.settle(index, t.profit, risk);
            const closed = result.trades
              .filter((x) => x.profit != null)
              .sort(
                (a, b) =>
                  a.sales!.at(-1)!.date.localeCompare(b.sales!.at(-1)!.date) ||
                  a.event.symbol.localeCompare(b.event.symbol) ||
                  a.event.key.localeCompare(b.event.key),
              );
            if (closed.length % 100 === 0)
              t.swingReview = swingCalibration(
                closed.slice(-100).map((x) => ({
                  version: x.event.strategyVersion,
                  complete: x.swingHistoryComplete !== false,
                  mae: x.swingMae ?? NaN,
                  profit: x.profit!,
                  atr: x.event.stopAtr ?? NaN,
                  entry: x.entryPrice,
                })),
              );
          }
          positions.delete(symbol);
        }
      }
      if (slot === 0 || (id === "OP08" && slot >= 6))
        for (const [symbol, state] of positions) {
          const openingAdd =
            id === "OP08" &&
            date > state.trade.entryDate &&
            state.trade.entries!.length === 1 &&
            !!decideOpening(symbol, slot)?.buy;
          if ((!state.add && !openingAdd) || state.pending || state.reduced)
            continue;
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
            fill = researchFill(rows[slot], "buy", rule, spec.costs);
          if (
            fill.price === null ||
            !rule ||
            (!openingAdd &&
              (!t.event.entryPriceRange ||
                fill.price < t.event.entryPriceRange.min ||
                fill.price > t.event.entryPriceRange.max))
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
            fraction: spec.risk!.fraction * (openingAdd ? 0.5 : 1),
            maxWeight: spec.risk!.maxWeight * (openingAdd ? 0.5 : 1),
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
          const buyAmount = moneyMul(qty, fill.price);
          const commission = researchCommission(buyAmount, spec.costs);
          t.book = researchBookBuy(t.book!, {
            date,
            quantity: qty,
            price: fill.price,
            commission,
          });
          cash = toNumber(big(cash).minus(buyAmount).minus(commission));
          t.entryCost = t.book.totalCost;
          t.remainingQuantity = t.book.remainingQuantity;
          t.entries!.push({
            date: at,
            triggerDate: openingAdd
              ? rows![slot - 1]!.date
              : `${days[index - 1]}T15:00:00+08:00`,
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
          ? (event.observedDate === date &&
              slot > 0 &&
              event.intradayAt ===
                available.get(event.symbol)?.[slot - 1]?.date) ||
            (event.intradayAt.slice(11, 16) === "15:00" &&
              index === signalIndex + 1 &&
              slot === 0)
          : (opening || admission ? slot >= 0 : slot === 0) &&
            signalIndex >= 0 &&
            index > signalIndex;
        if (!due) continue;
        if (!event.intradayAt && index - signalIndex > spec.entryMaxWait) {
          finished.add(event);
          result.excluded.push({ event, reason: "入场等待期结束" });
          continue;
        }
        const admissionCheck = admission
          ? marketAdmissionDecision(id, {
              symbol: event.symbol,
              date,
              at,
              previousClose:
                indexed
                  .get(event.symbol)
                  ?.get(calendar[calendar.indexOf(date) - 1]!)?.close ?? NaN,
              observedPrice:
                slot > 0
                  ? (available.get(event.symbol)?.[slot - 1]?.close ?? null)
                  : null,
              calendar,
              rows: spec.management?.marketAdmissionInputs ?? [],
            })
          : null;
        if (admissionCheck && !admissionCheck.allow) {
          if (
            admissionCheck.status === "missing" &&
            !result.signalGaps.some(
              (g) => g.symbol === event.symbol && g.date === date,
            )
          )
            result.signalGaps.push({
              symbol: event.symbol,
              date,
              reason: admissionCheck.reason,
            });
          continue;
        }
        const openingCheck = opening ? decideOpening(event.symbol, slot) : null;
        if (opening) {
          if (!openingCheck || openingCheck.status === "missing") {
            if (
              !result.signalGaps.some(
                (g) => g.symbol === event.symbol && g.date === date,
              )
            )
              result.signalGaps.push({
                symbol: event.symbol,
                date,
                reason: openingCheck?.reason ?? "待数据：前日行情/开盘计划",
              });
            continue;
          }
          // Exit-only components use the same next-open baseline, with a frozen risk line.
          if (id === "OP04" || id === "OP05") {
            if (slot !== 0) continue;
          } else if (!openingCheck.buy) continue;
        }
        if (positions.has(event.symbol)) {
          finished.add(event);
          result.excluded.push({ event, reason: "已有持仓不重复入场" });
          continue;
        }
        if (positions.size >= spec.maxPositions) continue;
        if (swing) {
          const prior = calendar[calendar.indexOf(date) - 1];
          const check = prior
            ? contextRiskPoint(
                "rk-event-reduce",
                spec.management?.contextRiskInputs ?? [],
                event.symbol,
                prior,
                calendar,
              )
            : null;
          if (
            week!.blocked(index) ||
            !check?.allow ||
            check.status === "missing"
          ) {
            finished.add(event);
            result.excluded.push({
              event,
              reason: check?.reason ?? "周-3R暂停或事件日历不可用",
            });
            continue;
          }
        }
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
        if (opening && id !== "OP04" && id !== "OP05") {
          const plan = spec.management?.openingPlans?.find(
            (p) => p.symbol === event.symbol && p.date === date,
          );
          if (
            !plan ||
            fill.price <= plan.life ||
            plan.resistance - fill.price < 2 * (fill.price - plan.life)
          ) {
            finished.add(event);
            result.excluded.push({
              event,
              reason: "实际下一根开盘价不满足冻结生命线/至少2R空间",
            });
            continue;
          }
        }
        if (researchSellQuantity(1, 1, rule) === null) {
          finished.add(event);
          result.excluded.push({ event, reason: "缺少完整卖出数量依据" });
          continue;
        }
        const executionRow = execution
          ? intradayExecutionEvidence(
              spec.management?.intradayExecutionInputs ?? [],
              event.symbol,
              date,
              at,
            )
          : null;
        const executionPolicy = execution
          ? intradayEntryPolicy(
              id,
              executionRow,
              date,
              calendar,
              at,
              fill.price,
              rule,
            )
          : null;
        if (executionPolicy && !executionPolicy.allow) {
          if (
            executionPolicy.missing &&
            !result.signalGaps.some(
              (g) => g.symbol === event.symbol && g.date === date,
            )
          )
            result.signalGaps.push({
              symbol: event.symbol,
              date,
              reason: `待数据：${executionPolicy.missing}`,
            });
          finished.add(event);
          result.excluded.push({
            event,
            reason: executionPolicy.missing ?? "已知事件窗口禁入",
          });
          continue;
        }
        const equity =
            cash +
            [...positions.values()].reduce(
              (s, p) => s + p.trade.book!.remainingQuantity * p.trade.lastPrice,
              0,
            ),
          stop = opening
            ? (openingCheck?.stop ?? NaN)
            : swing
              ? (researchInitialStop(spec.management!, fill.price, event) ??
                NaN)
              : id === "RK-A-intraday-points30"
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
        if (
          !Number.isFinite(stop) ||
          stop <= 0 ||
          stop >= fill.price ||
          (swing &&
            (event.stopAtr == null ||
              fill.price - stop > 2 * event.stopAtr + 1e-10))
        ) {
          finished.add(event);
          result.excluded.push({
            event,
            reason: "missing: 五分钟结构缺失或开盘失守",
          });
          continue;
        }
        const liquidity = swing
          ? researchLiquidity(daily.get(event.symbol) ?? [], calendar, date)
          : null;
        if (swing && liquidity?.maxPositionValue == null) {
          finished.add(event);
          result.excluded.push({
            event,
            reason: liquidity?.reason ?? "缺容量",
          });
          continue;
        }
        const planned = researchRiskQuantity({
          cash,
          equity,
          price: fill.price,
          stop: executionPolicy?.riskStop ?? stop,
          fraction:
            spec.risk!.fraction *
            (admissionCheck?.multiplier ?? 1) *
            (opening ? 0.5 : 1) *
            (streak?.multiplier() ?? 1),
          maxWeight: Math.min(
            executionPolicy?.maxWeight ?? 1,
            spec.risk!.maxWeight *
              (admissionCheck?.multiplier ?? 1) *
              (opening ? 0.5 : 1) *
              (streak?.multiplier() ?? 1),
            liquidity?.maxPositionValue != null
              ? liquidity.maxPositionValue / equity
              : 1,
          ),
          rules: rule,
          costs: spec.costs,
        });
        const desired =
          id === "SE-E-intraday50" || id === "OP08"
            ? planned / 2
            : Math.min(planned, rotationCaps.get(event.key) ?? Infinity);
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
        const commission = researchCommission(
            moneyMul(qty, fill.price),
            spec.costs,
          ),
          book = researchBookBuy(researchPositionBook(), {
            date,
            quantity: qty,
            price: fill.price,
            commission,
          });
        cash = toNumber(big(cash).minus(book.totalCost));
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
          ...(swing
            ? { riskBudget: equity * 0.01 * streak!.multiplier() }
            : {}),
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
              plannedRisk: swing
                ? plannedStopRisk(qty, fill.price, stop, spec.costs)
                : null,
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
          scaled: false,
          tailReady: false,
          maxR: 0,
          eventIds: new Set(),
          openingReduced: null,
        });
      }
    }
    const stale: string[] = [];
    for (const [symbol, state] of positions) {
      const rows = available.get(symbol),
        t = state.trade;
      if (!rows) {
        stale.push(symbol);
        if (swing) t.swingHistoryComplete = false;
        state.add = false;
        continue;
      }
      t.lastPrice = rows[47]!.close;
      if (opening) {
        if (
          rows.slice(-2).every((b) => b.close < state.stop) &&
          (!state.pending || state.pending.quantity < t.book!.remainingQuantity)
        )
          state.pending = {
            quantity: t.book!.remainingQuantity,
            reason: "冻结生命线两根收盘失守",
            at: rows[47]!.date,
          };
        const decision = decideOpening(symbol, 48);
        if (
          decision?.status === "available" &&
          decision.sell &&
          (!state.pending || decision.sell === 1) &&
          (decision.sell === 1 || state.openingReduced !== date)
        ) {
          state.openingReduced = date;
          state.pending = {
            quantity:
              decision.sell === 1
                ? t.book!.remainingQuantity
                : Math.min(
                    t.book!.remainingQuantity,
                    t.quantity * decision.sell,
                  ),
            reason: decision.reason,
            at: rows[47]!.date,
          };
        }
      }
      if (
        !opening &&
        !execution &&
        (swing
          ? t.lastPrice < state.stop ||
            rows[47]!.low <= t.entryPrice - 2 * (t.entryPrice - t.initialStop!)
          : id.startsWith("RK-")
            ? rows[47]!.low <= state.stop
            : t.lastPrice < state.stop)
      )
        state.pending = {
          quantity: t.book!.remainingQuantity,
          reason: id.startsWith("RK-")
            ? "15:00完成五分钟触碰，下一交易日开盘"
            : "15:00收盘跌破止损",
          at: rows[47]!.date,
        };
      if (execution) {
        const at = rows[47]!.date;
        const policy = intradayExitPolicy(id, {
          row: intradayExecutionEvidence(
            spec.management?.intradayExecutionInputs ?? [],
            symbol,
            date,
            at,
          ),
          date,
          calendar,
          at,
          previous: rows[47],
          entry: t.entryPrice,
          stop: state.stop,
          rule: rules(symbol, date),
        });
        if (
          policy.fraction &&
          (!state.pending ||
            (policy.fraction === 1 &&
              state.pending.quantity < t.book!.remainingQuantity)) &&
          (policy.fraction === 1 || state.openingReduced !== date)
        ) {
          state.openingReduced = date;
          state.pending = {
            quantity: policy.rotation
              ? researchBookSellable(t.book!, date)
              : policy.fraction === 1
                ? t.book!.remainingQuantity
                : Math.min(
                    t.book!.remainingQuantity,
                    t.quantity * policy.fraction,
                  ),
            reason: policy.reason,
            at,
            limit: policy.limit,
            rotation: policy.rotation,
          };
        }
      }
      if (swing) {
        t.swingMae = Math.max(t.swingMae ?? 0, t.entryPrice - rows[47]!.low);
        const distance = t.entryPrice - t.initialStop!,
          r = (t.lastPrice - t.entryPrice) / distance;
        state.maxR = Math.max(state.maxR, r);
        if (
          index - t.entryIndex + 1 >= 10 &&
          state.maxR < 0.5 &&
          !state.pending
        )
          state.pending = {
            quantity: t.book!.remainingQuantity,
            reason: "10日未达0.5R时间止损",
            at: rows[47]!.date,
          };
        const oldStop = state.stop;
        if (r >= 1) state.stop = Math.max(state.stop, t.entryPrice);
        if (r >= 2 && !state.scaled && !state.pending) {
          state.scaled = true;
          state.stop = Math.max(state.stop, t.entryPrice + distance);
          state.pending = {
            quantity: t.quantity * 0.5,
            reason: "2R减原始半仓并抬1R",
            at: rows[47]!.date,
          };
        }
        if (state.tailReady) {
          const prefix = (daily.get(symbol) ?? []).filter(
            (b) => b.date <= date,
          );
          const a = atr(prefix, 22).at(-1),
            h = rollingHigh(prefix, 22).at(-1);
          if (a != null && h != null)
            state.stop = Math.max(state.stop, h - 3 * a);
          else
            t.managementWarnings!.push({
              date,
              reason: "尾仓22日ATR/最高价缺失",
            });
        }
        if (state.stop > oldStop)
          t.stopHistory!.push({
            date: rows[47]!.date,
            stop: state.stop,
            reason: "波段组合收盘抬线，下一根生效",
          });
        const check = contextRiskPoint(
          "rk-event-reduce",
          spec.management?.contextRiskInputs ?? [],
          symbol,
          date,
          calendar,
        );
        if (check.status === "missing")
          t.managementWarnings!.push({
            date,
            reason: check.reason ?? "缺事件日历",
          });
        const e = check.evidence?.scheduledEvent;
        if (
          check.status === "available" &&
          !check.allow &&
          e &&
          !state.eventIds.has(e.id) &&
          !state.pending
        ) {
          state.eventIds.add(e.id);
          state.pending = {
            quantity: t.book!.remainingQuantity * 0.5,
            reason: "已知事件前三交易日减半",
            at: rows[47]!.date,
          };
        }
      }
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
      if (
        id === "SE-E-intraday50" &&
        eventIsHalf(t.event) &&
        t.entryDate === date &&
        !state.pending
      ) {
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
    const closingValue =
      cash +
      [...positions.values()].reduce(
        (sum, p) => sum + p.trade.book!.remainingQuantity * p.trade.lastPrice,
        0,
      );
    week?.close(index, closingValue, stale.length > 0);
    streak?.close(index, closingValue, stale.length > 0);
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
  if (swing) {
    const closed = result.trades.filter((t) => t.profit != null).length;
    result.swingAccount = {
      week: week!.snapshot(),
      streak: streak!.snapshot(),
      closedTrades: closed,
      nextReviewAt: (Math.floor(closed / 100) + 1) * 100,
    };
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
