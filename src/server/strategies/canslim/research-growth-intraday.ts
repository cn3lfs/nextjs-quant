import {
  researchCostQuote,
  researchExecutor,
} from "~/lib/backtest/research-executor";
import { big, bpsOf, moneyMul, toNumber } from "trading-strategy-core/money";
import {
  isIntradayExecution,
  intradayExecutionEvidence,
  intradayEntryPolicy,
  intradayExitPolicy,
  intradaySessionActive,
} from "trading-strategies/research/technical/research-intraday-execution";
import {
  isMarketAdmission,
  marketAdmissionDecision,
} from "trading-strategies/research/risk/research-market-admission";
import {
  isOpening,
  openingDecision,
  type OpeningId,
} from "trading-strategies/research/technical/research-opening";
import { researchAccountRisk } from "trading-strategies/research/risk/research-account-risk";
import { researchInitialStop } from "trading-strategies/research/risk/research-initial-stop";
import { researchLiquidity } from "trading-strategies/research/factors/research-liquidity";
import { contextRiskPoint } from "trading-strategies/research/risk/research-context-risk";
import { swingCalibration } from "trading-strategies/research/risk/research-risk-scenarios";
import type { Bar } from "~/lib/domain";
import type {
  ResearchEvent,
  ResearchSpec,
} from "~/lib/research/strategy-research";
import {
  researchNavStatistics,
  researchTradeStatistics,
} from "~/lib/research/strategy-research";
import { assertGrowthIntradayWindow } from "trading-strategies/research/factors/research-growth-intraday";
import {
  fillMarketOrder as researchFill,
  affordableQuantity as researchBuyQuantity,
  commissionFor as researchCommission,
  sellQuantity as researchSellQuantity,
  type ExecutionRules as ResearchExecutionRules,
} from "quant-backtest/execution";
import {
  researchRiskQuantity,
  plannedStopRisk,
} from "trading-strategies/research/risk/research-risk";
import {
  researchPositionBook,
  researchBookBuy,
  researchBookSell,
  researchBookSellable,
} from "~/lib/research/analysis/research-position-book";
import type {
  researchPortfolio,
  ResearchTrade,
} from "../../backtest/research-portfolio";
import {
  growthIntradayEntryDecision,
  growthIntradayGapDecision,
  growthIntradayLifeLineLost,
  growthIntradayAuctionQueueDecision,
  growthIntradayStopDecision,
  growthIntradayTimeDecision,
  growthIntradayInitialStop,
  growthIntradayStopAdmissible,
  growthIntradayOpeningSpace,
  growthIntradayPriceInRange,
  growthIntradayRiskMultiplier,
  growthIntradayEntryQuantity,
  growthIntradayAdditionSlot,
  growthIntradayOpeningAdditionEligible,
  growthIntradaySwingCloseDecision,
  growthIntradayReviewDecision,
  growthIntradayAdditionDecision,
  growthIntradayScheduledEventReduction,
  growthIntradaySwingRiskBudget,
} from "trading-strategies/research/growth/growth-intraday-policy";

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
      const decision = growthIntradayEntryDecision({
        id: spec.management?.growthIntraday,
        symbol,
        priorDaily: daily.slice(0, i),
        partialDay: partial,
        observedAt: b.date,
        completedBars: j + 1,
        calendar,
      });
      if (decision.usable) usable = true;
      if (decision.intent) {
        result.push({
          symbol,
          observedDate: date,
          endpointDate: date,
          intradayAt: b.date,
          partition:
            date >= spec.validationStart ? "validation" : "development",
          ...decision.intent,
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
            const decision = growthIntradayGapDecision(
              id,
              prior.close,
              open,
              t.entryPrice,
              state.stop,
            );
            if (decision.stop != null) {
              state.stop = decision.stop;
              t.stopHistory!.push({
                date: at,
                stop: state.stop,
                reason: "次日9:30日线开盘高开严格超过3%，9:35起保本",
              });
            }
            if (decision.reduceFraction != null && !state.pending)
              state.pending = {
                quantity: remaining * decision.reduceFraction,
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
            growthIntradayLifeLineLost(recent, state.stop) &&
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
            if (growthIntradayAuctionQueueDecision(prior, priorRule?.limitDown))
              state.pending = {
                quantity: remaining,
                reason: "一字跌停后次日竞价排队意图，等待成交证明",
                at: `${priorDate}T15:00:00+08:00`,
                auction: true,
              };
          }
        }
        const previous = slot > 0 ? rows[slot - 1] : null;
        const stopReason =
          previous && !opening && !execution
            ? growthIntradayStopDecision({
                id,
                completed: previous,
                entry: t.entryPrice,
                initialStop: t.initialStop!,
                stop: state.stop,
                afterEntryDay: date > t.entryDate,
                closing: false,
              })
            : null;
        if (stopReason)
          state.pending = {
            quantity: remaining,
            reason: stopReason,
            at: previous!.date,
          };
        if (id.startsWith("RK-A-intraday") && previous && !state.timeChecked) {
          const decision = growthIntradayTimeDecision({
            completedMinutes: state.completedMinutes,
            close: previous.close,
            entry: t.entryPrice,
            initialStop: t.initialStop!,
          });
          state.completedMinutes = decision.completedMinutes;
          state.timeChecked = decision.checked;
          if (decision.exitReason && !state.pending)
            state.pending = {
              quantity: remaining,
              reason: decision.exitReason,
              at: previous.date,
            };
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
              researchCostQuote(spec.costs),
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
      if (growthIntradayAdditionSlot(id, slot))
        for (const [symbol, state] of positions) {
          const openingAdd =
            growthIntradayOpeningAdditionEligible(
              id,
              date,
              state.trade.entryDate,
              state.trade.entries!.length,
            ) && !!decideOpening(symbol, slot)?.buy;
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
                !growthIntradayPriceInRange(
                  fill.price,
                  t.event.entryPriceRange,
                )))
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
            fraction:
              spec.risk!.fraction * growthIntradayRiskMultiplier(openingAdd),
            maxWeight:
              spec.risk!.maxWeight * growthIntradayRiskMultiplier(openingAdd),
            execution: researchExecutor(rule, spec.costs),
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
        if (!growthIntradayPriceInRange(fill.price, event.entryPriceRange)) {
          finished.add(event);
          result.excluded.push({ event, reason: "越过冻结枢纽区间" });
          continue;
        }
        if (opening && id !== "OP04" && id !== "OP05") {
          const plan = spec.management?.openingPlans?.find(
            (p) => p.symbol === event.symbol && p.date === date,
          );
          if (!growthIntradayOpeningSpace(fill.price, plan)) {
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
          stop = growthIntradayInitialStop({
            id,
            price: fill.price,
            opening,
            openingStop: openingCheck?.stop,
            swingStop: swing
              ? researchInitialStop(spec.management!, fill.price, event)
              : undefined,
            priorMinutes:
              id === "RK-A-intraday-structure30"
                ? (() => {
                    const previousDate = calendar
                      .filter((d) => d < date)
                      .at(-1);
                    return previousDate
                      ? growthMinuteDay(
                          minutes.get(event.symbol) ?? [],
                          previousDate,
                        )
                      : null;
                  })()
                : null,
          });
        if (
          !growthIntradayStopAdmissible(id, fill.price, stop, event.stopAtr)
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
            growthIntradayRiskMultiplier(opening) *
            (streak?.multiplier() ?? 1),
          maxWeight: Math.min(
            executionPolicy?.maxWeight ?? 1,
            spec.risk!.maxWeight *
              (admissionCheck?.multiplier ?? 1) *
              growthIntradayRiskMultiplier(opening) *
              (streak?.multiplier() ?? 1),
            liquidity?.maxPositionValue != null
              ? liquidity.maxPositionValue / equity
              : 1,
          ),
          execution: researchExecutor(rule, spec.costs),
        });
        const desired = growthIntradayEntryQuantity(
          id,
          planned,
          rotationCaps.get(event.key) ?? Infinity,
        );
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
            ? {
                riskBudget: growthIntradaySwingRiskBudget(
                  equity,
                  streak!.multiplier(),
                ),
              }
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
                ? plannedStopRisk(
                    qty,
                    fill.price,
                    stop,
                    researchCostQuote(spec.costs),
                  )
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
          growthIntradayLifeLineLost(rows, state.stop) &&
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
      const stopReason =
        !opening && !execution
          ? growthIntradayStopDecision({
              id,
              completed: rows[47]!,
              entry: t.entryPrice,
              initialStop: t.initialStop!,
              stop: state.stop,
              afterEntryDay: date > t.entryDate,
              closing: true,
            })
          : null;
      if (stopReason)
        state.pending = {
          quantity: t.book!.remainingQuantity,
          reason: stopReason,
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
        const oldStop = state.stop;
        const decision = growthIntradaySwingCloseDecision({
          entry: t.entryPrice,
          initialStop: t.initialStop!,
          close: t.lastPrice,
          stop: state.stop,
          heldDays: index - t.entryIndex + 1,
          maxR: state.maxR,
          scaled: state.scaled,
          pending: state.pending != null,
          tailReady: state.tailReady,
          dailyPrefix: (daily.get(symbol) ?? []).filter((b) => b.date <= date),
        });
        state.maxR = decision.maxR;
        state.stop = decision.stop;
        state.scaled = decision.scaled;
        if (decision.sale)
          state.pending = {
            quantity:
              (decision.sale.originalQuantity
                ? t.quantity
                : t.book!.remainingQuantity) * decision.sale.fraction,
            reason: decision.sale.reason,
            at: rows[47]!.date,
          };
        if (decision.warning)
          t.managementWarnings!.push({ date, reason: decision.warning });
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
        const reduction = growthIntradayScheduledEventReduction({
          available: check.status === "available",
          allow: check.allow,
          eventId: check.evidence?.scheduledEvent?.id,
          reducedEventIds: state.eventIds,
          pending: state.pending != null,
        });
        if (reduction) {
          state.eventIds.add(reduction.eventId);
          state.pending = {
            quantity: t.book!.remainingQuantity * reduction.fraction,
            reason: reduction.reason,
            at: rows[47]!.date,
          };
        }
      }
      if (id === "CA-D-review1430" && !state.pending) {
        const prior = indexed
          .get(symbol)
          ?.get(calendar[calendar.indexOf(date) - 1]!);
        const review = rows[41]!;
        const decision =
          prior && valid(prior)
            ? growthIntradayReviewDecision(id, review.close, prior.close)
            : null;
        if (decision)
          state.pending = {
            quantity: t.book!.remainingQuantity * decision.fraction,
            reason: decision.reason,
            at: review.date,
          };
      }
      if (
        id === "SE-E-intraday50" &&
        eventIsHalf(t.event) &&
        t.entryDate === date &&
        !state.pending
      ) {
        state.add = growthIntradayAdditionDecision({
          id,
          intradayEntry: eventIsHalf(t.event),
          range: t.event.entryPriceRange,
          close: t.lastPrice,
          completedDay: rows,
          priorDaily: (daily.get(symbol) ?? []).filter((b) => b.date < date),
        });
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
