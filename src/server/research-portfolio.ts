import {
  riskDisasterTriggered,
  riskPresetEvolution,
} from "~/lib/research-risk-presets";
import { contextRiskPoint } from "~/lib/research-context-risk";
import {
  externalVolatilityPoint,
  isExternalVolatility,
} from "~/lib/research-volatility-input";
import { researchRiskAdmission } from "~/lib/research-risk-admission";
import { researchAccountRisk } from "~/lib/research-account-risk";
import { volatilityStopSeries } from "~/lib/research-volatility-stops";
import {
  riskPresetBudget,
  riskPresetAccount,
  riskPresetAdmission,
} from "~/lib/research-risk-presets";
import { swingRewardAdmission } from "~/lib/research-swing-discipline";
import {
  growthVolumeReduction,
  growthDistributionReduction,
  growthAddConfirmation,
} from "~/lib/research-growth-daily";
import { researchKellySwitch } from "~/lib/research-kelly-switch";
import { researchProgressCheck } from "~/lib/research-progress-exit";
import { researchSepaElite } from "~/lib/research-sepa-elite";
import { researchKellyQuality } from "~/lib/research-kelly-quality";
import { researchKellyNetPayoff } from "~/lib/research-kelly-payoff";
import type { ResearchKellyTraining } from "~/lib/research-kelly-training";
import { researchKellyLimit } from "~/lib/research-kelly";
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
  researchSellQuantity,
  type ResearchExecutionRules,
} from "~/lib/research-execution";
import { researchRiskQuantity, plannedStopRisk } from "~/lib/research-risk";
import {
  researchInitialStop,
  researchStopComparison,
  researchStopOverride,
} from "~/lib/research-management";
import { researchMarketEnvironment } from "~/lib/research-market-regime";
import { researchLossPause } from "~/lib/research-loss-pause";
import { researchLiquidity } from "~/lib/research-liquidity";
import { researchRetracementStop } from "~/lib/research-retracement";
import { researchMarketChop } from "~/lib/research-market-chop";
import { atr, rollingHigh } from "~/lib/indicators";
import { researchHigherLow } from "./research-protection";
import { researchPullbackConfirmation } from "~/lib/research-pullback";
import {
  isResearchRule,
  researchRuleSeries,
  type ResearchRulePoint,
} from "./research-rule-series";
import type { RuleStop } from "~/lib/research-volume";
import {
  researchBookBuy,
  researchBookSell,
  researchBookSellable,
  researchPositionBook,
  type ResearchPositionBook,
} from "~/lib/research-position-book";
import {
  researchPyramidOrder,
  researchRoundedBuy,
  researchPlannedProceeds,
} from "~/lib/research-pyramid";

type WeeklyReductionSignal = NonNullable<
  Extract<ResearchRulePoint, { weeklyReduction: unknown }>["weeklyReduction"]
>;
export type ResearchTrade = {
  growthReviews?: {
    date: string;
    days: number;
    gain: number | null;
    pivot: number | null;
    invalid: boolean | null;
  }[];
  sepaElite?: NonNullable<ReturnType<typeof researchSepaElite>>;
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
  initialStop?: number;
  initialStopOverride?: NonNullable<ReturnType<typeof researchStopOverride>>;
  initialStopCandidates?: NonNullable<
    ReturnType<typeof researchStopComparison>
  >["candidates"];
  signalExit?: ResearchRulePoint;
  weeklyReductionChecks?: WeeklyReductionSignal[];
  weeklyReductionEvidence?: {
    signal: WeeklyReductionSignal;
    remainingQuantity: number;
    targetQuantity: number;
    disposition: "queued" | "existing-full-exit" | "existing-partial";
  }[];
  progressExitCheck?: NonNullable<ReturnType<typeof researchProgressCheck>>;
  ruleStop?: RuleStop;
  ruleStopTriggeredAt?: string;
  exitReason?: string;
  plannedRiskStop?: number;
  managementWarnings?: { date: string; reason: string }[];
  protectionEvidence?: {
    date: string;
    structure: ReturnType<typeof researchHigherLow>;
  }[];
  stopHistory?: { date: string; stop: number; reason: string }[];
  remainingQuantity?: number;
  realizedProceeds?: number;
  realizedProfit?: number;
  book?: ResearchPositionBook;
  plannedQuantity?: number;
  riskBudget?: number;
  pullbackEvidence?: ReturnType<typeof researchPullbackConfirmation>[];
  entries?: {
    date: string;
    triggerDate: string | null;
    quantity: number;
    price: number;
    commission: number;
    plannedRisk: number | null;
    stop: number;
  }[];
  sales?: {
    date: string;
    triggerDate: string | null;
    quantity: number;
    price: number;
    commission: number;
    tax: number;
    netProceeds: number;
    reason: string;
  }[];
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
  benchmark?: { symbol: string; bars: readonly Bar[] },
  kellyTraining?: ResearchKellyTraining | null,
  growthMarket?: { symbol: string; bars: readonly Bar[] },
) {
  const growthDaily = spec.management?.growthDaily;
  const growthAdd = growthDaily === "CA-P-add23";
  const entryRangeReason = (event: ResearchEvent, price: number) => {
    const range = event.entryPriceRange;
    if (!range) return null;
    if (
      ![range.min, range.max].every(Number.isFinite) ||
      range.min <= 0 ||
      range.max < range.min
    )
      return "冻结入场价格区间无效，取消买入";
    return price < range.min || price > range.max
      ? "成交价格越过冻结枢纽买入区间，取消买入"
      : null;
  };
  const days = calendar.filter(
    (date) => date >= spec.start && date <= spec.end,
  );
  if (days.some((date, i) => i > 0 && date <= days[i - 1]!))
    throw new Error("组合交易日历无效");
  const admissionRule = spec.management?.riskPreset
    ? riskPresetAdmission(spec.management.riskPreset)
    : undefined;
  const riskAdmissionChecks: {
    date: string;
    symbol: string;
    eventKey: string;
    sizing?: {
      riskQuantity: number;
      kellyQuantity: number;
      singleStockQuantity: number;
      finalQuantity: number;
      binding: string[];
    };
    check: ReturnType<typeof researchRiskAdmission>;
  }[] = [];
  const accountRule = spec.management?.riskPreset
    ? riskPresetAccount(spec.management.riskPreset)
    : undefined;
  const accountRisk = accountRule
    ? researchAccountRisk(accountRule, days, spec.initialCapital)
    : null;
  const lossPause = spec.management?.lossPauseDays
    ? researchLossPause(days, spec.management.lossPauseDays)
    : null;
  const marketEnvironment = spec.management?.marketRegime
    ? researchMarketEnvironment(
        benchmark,
        calendar,
        spec.management.marketRegime,
      ).filter((row) => row.date >= spec.start && row.date <= spec.end)
    : null;
  const environmentByDate = new Map(
    marketEnvironment?.map((row) => [row.date, row]) ?? [],
  );
  const marketChop = spec.management?.marketChop
    ? researchMarketChop(
        benchmark,
        calendar,
        spec.management.marketChop,
      ).filter((row) => row.date >= spec.start && row.date <= spec.end)
    : null;
  const chopByDate = new Map(marketChop?.map((row) => [row.date, row]) ?? []);
  const indexed = new Map(
    [...series].map(([symbol, bars]) => [
      symbol,
      new Map(bars.map((bar) => [bar.date, bar])),
    ]),
  );
  const staticKelly = spec.management?.kelly
    ? researchKellyLimit(
        spec.management.kelly,
        kellyTraining &&
          kellyTraining.cutoff <= spec.start &&
          kellyTraining.samples.length >= 30 &&
          !kellyTraining.reason
          ? kellyTraining.winRate
          : null,
        spec.management.kelly.provenance === "development-net-payoff"
          ? researchKellyNetPayoff(kellyTraining).payoff
          : undefined,
      )
    : null;
  const qualityKelly =
    spec.management?.kelly?.provenance === "breakout-quality";
  const rollingKelly =
    spec.management?.kelly?.provenance === "rolling-switch30";
  const kellyFor = (event: ResearchEvent, date: string) => {
    if (spec.management?.kelly?.provenance === "rolling-switch30")
      return researchKellySwitch(
        trades,
        spec.start,
        date,
        event.partition,
        event.evidence,
        spec.management.kelly.payoff,
      );
    if (!qualityKelly) return staticKelly;
    const quality = researchKellyQuality(event.evidence);
    return quality.reason
      ? { fullKelly: null, weight: null, reason: quality.reason }
      : researchKellyLimit(spec.management!.kelly!, quality.winRate);
  };
  const kellyChecks: Array<{
    symbol: string;
    date: string;
    phase: "entry" | "add";
    equity: number;
    price: number;
    riskBudget: number;
    kellyValue: number | null;
    singleStockValue: number;
    heldQuantity: number;
    filledQuantity: number;
    quality?: ReturnType<typeof researchKellyQuality>;
    signalDate?: string;
    parameterSwitch?: ReturnType<typeof researchKellySwitch>;
  }> = [];
  const checkKelly = (
    event: ResearchEvent,
    symbol: string,
    date: string,
    phase: "entry" | "add",
    equity: number,
    price: number,
    riskBudget: number,
    heldQuantity = 0,
  ) => {
    const kelly = kellyFor(event, date);
    if (!kelly) return null;
    const row = {
      ...(rollingKelly
        ? { parameterSwitch: kelly as ReturnType<typeof researchKellySwitch> }
        : {}),
      ...(qualityKelly || rollingKelly
        ? {
            quality: researchKellyQuality(event.evidence),
            signalDate: event.observedDate,
          }
        : {}),
      symbol,
      date,
      phase,
      equity,
      price,
      riskBudget,
      kellyValue: kelly.weight == null ? null : equity * kelly.weight,
      singleStockValue: equity * spec.risk!.maxWeight,
      heldQuantity,
      filledQuantity: 0,
    };
    kellyChecks.push(row);
    return row;
  };
  const liquidityChecks = new Map<
    string,
    ReturnType<typeof researchLiquidity> & { symbol: string }
  >();
  const capacity = (symbol: string, date: string) => {
    if (!spec.management?.liquidityCap) return null;
    const key = `${symbol}/${date}`;
    let row = liquidityChecks.get(key);
    if (!row) {
      row = {
        symbol,
        ...researchLiquidity(series.get(symbol) ?? [], calendar, date),
      };
      liquidityChecks.set(key, row);
    }
    return row;
  };
  const technicalId = isResearchRule(spec.strategy) ? spec.strategy : null;
  const technical = new Map(
    technicalId
      ? [...series].map(
          ([symbol, bars]) =>
            [
              symbol,
              new Map(
                researchRuleSeries(technicalId, bars, calendar)
                  .filter(
                    (point) =>
                      point.date >= spec.start && point.date <= spec.end,
                  )
                  .map((point) => [point.date, point]),
              ),
            ] as const,
        )
      : [],
  );
  const lastSignalExit = new Map<string, string>();
  const failedBreakouts = new Map<string, Set<string>>();
  const signalGaps: { symbol: string; date: string; reason: string }[] = [];
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
  const managed =
    spec.strategy === "dual-breakout-structure" || !!spec.management;
  const states = new Map<
    string,
    {
      stop: number;
      high: number;
      breaches: number;
      stage: number;
      completedStages: number;
      tailWarning: boolean;
    }
  >();
  const trail = spec.management?.trail;
  const volatilityLines = new Map(
    trail?.kind === "volatility"
      ? [...series].map(([symbol, bars]) => {
          const values = volatilityStopSeries(bars, trail.profile, calendar, {
            symbol,
            inputs: spec.management?.volatilityInputs ?? [],
          });
          return [
            symbol,
            new Map(bars.map((bar, i) => [bar.date, values[i] ?? null])),
          ] as const;
        })
      : [],
  );
  const trailHigh = new Map(
    trail?.kind === "rolling-chandelier"
      ? [...series].map(([symbol, bars]) => {
          const values = rollingHigh(bars, trail.period);
          return [
            symbol,
            new Map(bars.map((bar, i) => [bar.date, values[i] ?? null])),
          ] as const;
        })
      : [],
  );
  const trailAtr = new Map(
    trail?.kind === "chandelier" ||
      trail?.kind === "close-atr" ||
      trail?.kind === "rolling-chandelier"
      ? [...series].map(([symbol, bars]) => {
          const values = atr(bars, trail.period);
          return [
            symbol,
            new Map(bars.map((bar, i) => [bar.date, values[i] ?? null])),
          ] as const;
        })
      : [],
  );
  const kaseTargets = new Map<string, { fractions: number[]; level: number }>();
  const cap3Entries = new Map<
    string,
    { equity: number; budget: number; plannedRisk: number }
  >();
  const contextChecks: {
    symbol: string;
    date: string;
    phase: "entry" | "holding";
    check: ReturnType<typeof contextRiskPoint>;
  }[] = [];
  const exits = new Map<string, string>();
  const partials = new Map<
    string,
    | { stage: number; desired: number; triggerDate: string }
    | {
        kind: "weekly" | "signal";
        desired: number;
        triggerDate: string;
        reason: string;
      }
  >();
  const scaleOut = spec.management?.scaleOut;
  const partialReason = (
    request: NonNullable<ReturnType<typeof partials.get>>,
  ) =>
    "stage" in request
      ? `第${request.stage + 1}档${scaleOut![request.stage]!.atR}R分批止盈`
      : request.reason;
  const pyramid = spec.management?.pyramid;
  const pullback = pyramid?.kind === "pullback-50-50" ? pyramid : null;
  const batched = !!(
    scaleOut ||
    pyramid ||
    technicalId ||
    spec.management?.volatilityStop === "rk-kase-stages"
  );
  const additions = new Map<
    string,
    { stage: number; triggerDate: string; triggerIndex: number }
  >();
  const addStates = new Map<string, { stage: number; stopped: boolean }>();
  const holdingDue = (trade: ResearchTrade, index: number, date: string) =>
    trade.sepaElite
      ? date >= trade.sepaElite.holdUntil
      : index - trade.entryIndex >= spec.holdingDays;
  let previousStale: string[] = [];
  for (let index = 0; index < days.length; index++) {
    accountRisk?.begin(index);
    const date = days[index]!;
    const environment = environmentByDate.get(date);
    const chop = chopByDate.get(date);
    if (chop?.state === "choppy")
      for (const symbol of positions.keys()) exits.set(symbol, chop.reason!);
    const environmentLimit = environment?.maxWeight ?? 1;
    const environmentBlocked =
      (!!marketChop && chop?.state !== "clear") ||
      (marketEnvironment &&
        (!environment ||
          environment.maxWeight == null ||
          environment.maxWeight === 0));
    const environmentReason =
      chop?.reason ?? environment?.reason ?? "大盘环境总仓上限为0，暂停买入";
    for (const [symbol, trade] of positions) {
      const fullExit = holdingDue(trade, index, date) || exits.has(symbol);
      const partial = partials.get(symbol);
      if ((!fullExit && !partial) || date <= trade.entryDate) continue;
      const bar = indexed.get(symbol)?.get(date);
      const dailyRules = rules(symbol, date);
      const fill = researchFill(bar, "sell", dailyRules, spec.costs);
      if (fill.price === null) {
        attempts.push({ symbol, date, side: "sell", reason: fill.reason });
        continue;
      }
      const remaining = trade.remainingQuantity ?? trade.quantity;
      const sellable = trade.book
        ? researchBookSellable(trade.book, date)
        : remaining;
      const quantity = batched
        ? researchSellQuantity(
            Math.min(fullExit ? remaining : partial!.desired, sellable),
            remaining,
            dailyRules!,
          )
        : remaining;
      if (quantity == null || quantity === 0) {
        attempts.push({
          symbol,
          date,
          side: "sell",
          reason:
            quantity == null
              ? "缺少有效卖出数量规则"
              : "待卖数量不足有效申报量",
        });
        if (quantity === 0 && !fullExit && partial) {
          (trade.managementWarnings ??= []).push({
            date,
            reason:
              "stage" in partial
                ? `第${partial.stage + 1}档数量不足，跳过该档且不抬升止损`
                : "周线减半目标不足最小卖出量，保留尾仓且不扩大目标",
          });
          if ("stage" in partial) states.get(symbol)!.stage++;
          partials.delete(symbol);
        }
        continue;
      }
      const amount = quantity * fill.price;
      const commission = researchCommission(amount, spec.costs);
      const tax = (amount * spec.costs.sellTaxBps) / 10000;
      const proceeds = amount - commission - tax;
      cash += proceeds;
      const reason = fullExit
        ? (exits.get(symbol) ?? "达到最长持有交易日")
        : partialReason(partial!);
      if (batched) {
        trade.remainingQuantity = remaining - quantity;
        if (trade.book) {
          trade.book = researchBookSell(trade.book, {
            date,
            quantity,
            price: fill.price,
            commission,
            tax,
          }).book;
          trade.realizedProceeds = trade.book.realizedProceeds;
          trade.realizedProfit = trade.book.realizedProfit;
          addStates.get(symbol)!.stopped = true;
          additions.delete(symbol);
        } else {
          trade.realizedProceeds! += proceeds;
          trade.realizedProfit =
            trade.realizedProceeds! -
            (trade.entryCost * (trade.quantity - trade.remainingQuantity)) /
              trade.quantity;
        }
        trade.sales!.push({
          date,
          triggerDate: fullExit ? null : partial!.triggerDate,
          quantity,
          price: fill.price,
          commission,
          tax,
          netProceeds: proceeds,
          reason,
        });
        if (fullExit) {
          partials.delete(symbol);
          exits.set(symbol, reason);
        } else {
          partial!.desired -= quantity;
          if (
            partial!.desired < 1e-8 ||
            researchSellQuantity(
              partial!.desired,
              trade.remainingQuantity,
              dailyRules!,
            ) === 0
          ) {
            if (partial!.desired >= 1e-8)
              (trade.managementWarnings ??= []).push({
                date,
                reason:
                  "stage" in partial!
                    ? `第${partial!.stage + 1}档按卖出数量规则向下取整，剩余目标不足申报量`
                    : "周线减半按卖出数量规则向下取整，剩余目标不足申报量",
              });
            if ("stage" in partial!) {
              const state = states.get(symbol)!;
              const target = scaleOut![partial!.stage]!;
              if (target.raiseStopR != null && trade.remainingQuantity > 0) {
                const next =
                  trade.entryPrice +
                  target.raiseStopR * (trade.entryPrice - trade.initialStop!);
                if (next > state.stop) {
                  state.stop = next;
                  trade.stopHistory!.push({
                    date,
                    stop: next,
                    reason: `第${partial!.stage + 1}档实际成交后抬升`,
                  });
                }
              }
              state.stage++;
              state.completedStages++;
            }
            partials.delete(symbol);
          }
        }
        if (trade.remainingQuantity > 0) continue;
      }
      trade.exitDate = date;
      if (managed || technicalId) trade.exitReason = reason;
      exits.delete(symbol);
      trade.holdingTradingDays = index - trade.entryIndex;
      trade.exitPrice = batched
        ? trade.sales!.reduce(
            (sum, sale) => sum + sale.quantity * sale.price,
            0,
          ) / (trade.book?.totalQuantity ?? trade.quantity)
        : fill.price;
      trade.profit = (trade.realizedProceeds ?? proceeds) - trade.entryCost;
      trade.netReturn = trade.profit / trade.entryCost;
      accountRisk?.settle(
        index,
        trade.profit,
        trade.initialStop != null
          ? plannedStopRisk(
              trade.quantity,
              trade.entryPrice,
              trade.initialStop,
              spec.costs,
            )
          : null,
      );
      lossPause?.settle(index, {
        symbol,
        eventKey: trade.event.key,
        entryDate: trade.entryDate,
        profit: trade.profit,
      });
      positions.delete(symbol);
      states.delete(symbol);
      partials.delete(symbol);
      additions.delete(symbol);
      addStates.delete(symbol);
    }
    // Exits above have priority. A reduction ends all future additions.
    if (pyramid)
      for (const [symbol, request] of additions) {
        const trade = positions.get(symbol);
        const addState = addStates.get(symbol);
        if (
          !trade ||
          !addState ||
          addState.stopped ||
          exits.has(symbol) ||
          partials.has(symbol) ||
          holdingDue(trade, index, date)
        ) {
          additions.delete(symbol);
          if (addState) addState.stopped = true;
          continue;
        }
        if (date <= request.triggerDate) continue;
        if (index - request.triggerIndex > spec.entryMaxWait) {
          trade.managementWarnings!.push({
            date,
            reason: "加仓等待期结束，停止后续加仓",
          });
          additions.delete(symbol);
          addState.stopped = true;
          continue;
        }
        if (lossPause?.blocked(index)) {
          attempts.push({
            symbol,
            date,
            side: "buy",
            reason: "连续三笔完整交易亏损，冷静期暂停买入",
          });
          continue;
        }
        if (environmentBlocked) {
          attempts.push({
            symbol,
            date,
            side: "buy",
            reason: environmentReason,
          });
          continue;
        }
        const dailyRules = rules(symbol, date);
        const fill = researchFill(
          indexed.get(symbol)?.get(date),
          "buy",
          dailyRules,
          spec.costs,
        );
        if (fill.price == null || !dailyRules) {
          attempts.push({
            symbol,
            date,
            side: "buy",
            reason: fill.reason ?? "缺少加仓规则",
          });
          continue;
        }
        if (previousStale.some((held) => positions.has(held))) {
          attempts.push({
            symbol,
            date,
            side: "buy",
            reason: "持仓前收估值缺失，暂停加仓",
          });
          continue;
        }
        const otherValue = [...positions].reduce(
          (sum, [code, position]) =>
            sum +
            (code === symbol
              ? 0
              : (position.remainingQuantity ?? position.quantity) *
                position.lastPrice),
          0,
        );
        const state = states.get(symbol)!;
        if (
          pullback &&
          indexed.get(symbol)!.get(date)!.open < trade.event.pullbackLevel!
        ) {
          trade.managementWarnings!.push({
            date,
            reason: "第二笔开盘失守冻结突破位，取消剩余计划",
          });
          additions.delete(symbol);
          addState.stopped = true;
          continue;
        }
        if (
          growthAdd &&
          (fill.price < trade.entryPrice * 1.02 - 1e-10 ||
            fill.price > trade.entryPrice * 1.03 + 1e-10 ||
            entryRangeReason(trade.event, fill.price))
        ) {
          additions.delete(symbol);
          addState.stopped = true;
          trade.managementWarnings!.push({
            date,
            reason: "补仓开盘越过2%至3%或冻结枢纽范围，取消补仓",
          });
          continue;
        }
        const desired = growthAdd
          ? trade.plannedQuantity! - trade.book!.totalQuantity
          : pullback
            ? trade.entries![0]!.quantity
            : Math.min(
                trade.plannedQuantity! * (request.stage === 0 ? 0.3 : 0.2),
                trade.entries!.at(-1)!.quantity - 1,
              );
        if (!researchRoundedBuy(desired, dailyRules)) {
          trade.managementWarnings!.push({
            date,
            reason: "递减加仓数量不足最小申报量，停止后续加仓",
          });
          addState.stopped = true;
          additions.delete(symbol);
          continue;
        }
        const rangeReason = entryRangeReason(trade.event, fill.price);
        if (rangeReason) {
          attempts.push({ symbol, date, side: "buy", reason: rangeReason });
          addState.stopped = true;
          additions.delete(symbol);
          continue;
        }
        const liquidity = capacity(symbol, date);
        if (liquidity && liquidity.maxPositionValue == null) {
          attempts.push({
            symbol,
            date,
            side: "buy",
            reason: liquidity.reason ?? "成交额容量数据不可用",
          });
          continue;
        }
        const addEquity =
          cash + otherValue + trade.remainingQuantity! * fill.price;
        const kelly = kellyFor(trade.event, date);
        const kellyCheck = checkKelly(
          trade.event,
          symbol,
          date,
          "add",
          addEquity,
          fill.price,
          trade.riskBudget!,
          trade.remainingQuantity!,
        );
        if (kelly && (kelly.weight == null || kelly.weight <= 0)) {
          attempts.push({
            symbol,
            date,
            side: "buy",
            reason: kelly.reason ?? "凯利禁止加仓",
          });
          continue;
        }
        const result = researchPyramidOrder({
          book: trade.book!,
          date,
          price: fill.price,
          desired,
          stage: request.stage,
          stop: state.stop,
          firstPrice: trade.entryPrice,
          stressBuffer: spec.management!.stressBuffer,
          cash,
          equity: cash + otherValue + trade.remainingQuantity! * fill.price,
          otherValue,
          riskBudget: trade.riskBudget!,
          maxWeight: Math.min(
            spec.risk!.maxWeight,
            kelly?.weight ?? 1,
            liquidity?.maxPositionValue == null
              ? 1
              : liquidity.maxPositionValue / addEquity,
          ),
          maxTotalWeight: Math.min(
            pyramid.maxTotalWeight,
            spec.management?.maxTotalWeight ?? 1,
            environmentLimit,
          ),
          rules: dailyRules,
          costs: spec.costs,
          ...(pullback
            ? {
                pullback: {
                  level: trade.event.pullbackLevel!,
                  requireProfit: pullback.requireProfit,
                },
              }
            : {}),
        });
        if (!result.order) {
          attempts.push({
            symbol,
            date,
            side: "buy",
            reason: result.reason ?? "加仓条件不足",
          });
          continue;
        }
        const order = result.order;
        if (kellyCheck) kellyCheck.filledQuantity = order.quantity;
        cash -= order.quantity * fill.price + order.commission;
        trade.book = order.book;
        trade.lastPrice = fill.price;
        trade.remainingQuantity = order.book.remainingQuantity;
        trade.entryCost = order.book.totalCost;
        trade.entries!.push({
          date,
          triggerDate: request.triggerDate,
          quantity: order.quantity,
          price: fill.price,
          commission: order.commission,
          plannedRisk: order.plannedRisk,
          stop: order.stop,
        });
        if (order.stop > state.stop) {
          state.stop = order.stop;
          trade.stopHistory!.push({
            date,
            stop: state.stop,
            reason: "加仓成交后重算整体风险，只抬升止损",
          });
        }
        addState.stage++;
        additions.delete(symbol);
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
      if (
        technicalId &&
        ((lastSignalExit.get(event.symbol) ?? "") >= event.observedDate ||
          failedBreakouts.get(event.symbol)?.has(event.observedDate))
      ) {
        excluded.push({
          event,
          reason: failedBreakouts.get(event.symbol)?.has(event.observedDate)
            ? "原突破三日内枢纽失守已确认，取消未成交买入意图"
            : "入场等待期间反向指标信号已确认，取消旧买入意图",
        });
        finished.add(event);
        continue;
      }
      if (positions.has(event.symbol)) {
        excluded.push({ event, reason: "同股已有持仓，不重复加仓" });
        finished.add(event);
        continue;
      }
      if (
        growthDaily === "CA-E-cooldown" &&
        trades.some(
          (t) =>
            t.event.symbol === event.symbol &&
            t.exitDate &&
            t.exitReason?.includes("止损") &&
            index - days.indexOf(t.exitDate) <= 3,
        )
      ) {
        excluded.push({
          event,
          reason: "同股止损成交后3研究交易日冷静期，取消旧信号",
        });
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
      if (accountRisk?.blocked(index)) {
        attempts.push({
          symbol: event.symbol,
          date,
          side: "buy",
          reason: "账户风控暂停新仓，恢复条件见accountRisk",
        });
        continue;
      }
      if (lossPause?.blocked(index)) {
        attempts.push({
          symbol: event.symbol,
          date,
          side: "buy",
          reason: "连续三笔完整交易亏损，冷静期暂停买入",
        });
        continue;
      }
      if (environmentBlocked) {
        attempts.push({
          symbol: event.symbol,
          date,
          side: "buy",
          reason: environmentReason,
        });
        continue;
      }
      if (spec.management?.contextRisk) {
        const priorDate =
          calendar.filter((d) => d < date).at(-1) ?? event.observedDate;
        const frozenThesis = spec.management.contextRiskInputs?.find(
          (r) => r.symbol === event.symbol && r.date === event.observedDate,
        )?.thesis;
        if (spec.management.contextRisk === "rk-thesis") {
          const original = contextRiskPoint(
            "rk-thesis",
            spec.management.contextRiskInputs ?? [],
            event.symbol,
            event.observedDate,
            calendar,
          );
          if (original.status === "missing" || !frozenThesis) {
            excluded.push({
              event,
              reason: "missing: 缺入场信号时已冻结的有效命题",
            });
            finished.add(event);
            continue;
          }
        }
        const check = contextRiskPoint(
          spec.management.contextRisk,
          spec.management.contextRiskInputs ?? [],
          event.symbol,
          priorDate,
          calendar,
          frozenThesis,
        );
        contextChecks.push({
          symbol: event.symbol,
          date: event.observedDate,
          phase: "entry",
          check,
        });
        if (!check.allow) {
          excluded.push({
            event,
            reason:
              check.status === "missing"
                ? `missing: ${check.reason}`
                : (check.reason ?? "人工事件准入拒绝"),
          });
          finished.add(event);
          continue;
        }
      }
      const admission = admissionRule
        ? researchRiskAdmission(
            admissionRule,
            spec.start,
            event.evidence,
            kellyTraining,
          )
        : null;
      const admissionCheck: (typeof riskAdmissionChecks)[number] | null =
        admission
          ? {
              date,
              symbol: event.symbol,
              eventKey: event.key,
              check: admission,
            }
          : null;
      if (admissionCheck) riskAdmissionChecks.push(admissionCheck);
      if (admission && !admission.allow) {
        excluded.push({ event, reason: admission.reason ?? "风控准入未满足" });
        finished.add(event);
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
      const rangeReason = entryRangeReason(event, fill.price);
      if (rangeReason) {
        excluded.push({ event, reason: rangeReason });
        finished.add(event);
        continue;
      }
      if (batched && researchSellQuantity(1, 1, dailyRules) == null) {
        excluded.push({
          event,
          reason: "分批策略缺少完整卖出数量规则，不能用买入步长替代",
        });
        finished.add(event);
        continue;
      }
      if (event.ruleStop && fill.price < event.ruleStop.price) {
        excluded.push({
          event,
          reason: "开盘已失守冻结的规则确认位，取消入场",
        });
        finished.add(event);
        continue;
      }
      if (
        pullback &&
        (event.pullbackLevel == null ||
          !Number.isFinite(event.pullbackLevel) ||
          event.pullbackLevel <= 0 ||
          fill.price < event.pullbackLevel ||
          indexed.get(event.symbol)!.get(date)!.open < event.pullbackLevel)
      ) {
        excluded.push({
          event,
          reason: "缺少有效冻结突破位或首仓开盘已失守，不启动50/50分批",
        });
        finished.add(event);
        continue;
      }
      const externalId = spec.management?.volatilityStop;
      const externalEntry =
        externalId && isExternalVolatility(externalId)
          ? externalVolatilityPoint(
              externalId,
              series.get(event.symbol) ?? [],
              event.symbol,
              event.observedDate,
              spec.management?.volatilityInputs,
              calendar,
            )
          : null;
      if (externalEntry?.status === "missing") {
        excluded.push({ event, reason: `missing: ${externalEntry.reason}` });
        finished.add(event);
        continue;
      }
      const stopOverride = researchStopOverride(spec.management, event);
      const initialStop =
        externalEntry?.status === "available"
          ? externalEntry.stop
          : spec.management
            ? researchInitialStop(spec.management, fill.price, event)
            : event.initialStop;
      if (
        externalEntry?.status === "available" &&
        externalId === "rk-kase-stages"
      )
        kaseTargets.set(`${event.symbol}:${event.key}`, {
          fractions: externalEntry.cumulativeFractions,
          level: -1,
        });
      const plannedRiskStop =
        initialStop == null
          ? null
          : initialStop * (1 - (spec.management?.stressBuffer ?? 0));
      if (
        managed &&
        (initialStop == null ||
          !Number.isFinite(initialStop) ||
          initialStop <= 0 ||
          initialStop >= fill.price ||
          !plannedRiskStop ||
          plannedRiskStop <= 0 ||
          ((!spec.management ||
            (spec.management.stop.kind === "structure" && !stopOverride)) &&
            initialStop >= indexed.get(event.symbol)!.get(date)!.open))
      ) {
        excluded.push({
          event,
          reason: spec.management
            ? "止损输入缺失或无效，或开盘已失守信号结构"
            : "缺少有效结构止损，或开盘已失守信号结构",
        });
        finished.add(event);
        continue;
      }
      if (
        spec.management?.maxInitialStopDistance != null &&
        initialStop != null &&
        (fill.price - initialStop) / fill.price >
          spec.management.maxInitialStopDistance + 1e-12
      ) {
        excluded.push({
          event,
          reason: "实际入场价至初始止损距离超过准入上限，取消入场",
        });
        finished.add(event);
        continue;
      }
      if (
        spec.management?.stop.kind === "structure-atr" &&
        spec.management.stop.maxDistanceAtr != null &&
        initialStop != null &&
        (event.stopAtr == null ||
          !Number.isFinite(event.stopAtr) ||
          event.stopAtr <= 0 ||
          (fill.price - initialStop) / event.stopAtr >
            spec.management.stop.maxDistanceAtr + 1e-12)
      ) {
        excluded.push({
          event,
          reason:
            event.stopAtr == null ||
            !Number.isFinite(event.stopAtr) ||
            event.stopAtr <= 0
              ? "2ATR准入缺少有效信号日ATR，取消入场"
              : stopOverride
                ? "实际入场价至显式止损超过2倍信号日ATR，取消入场"
                : "实际入场价至缓冲后结构止损超过2倍信号日ATR，取消入场",
        });
        finished.add(event);
        continue;
      }
      if (managed && previousStale.some((symbol) => positions.has(symbol))) {
        attempts.push({
          symbol: event.symbol,
          date,
          side: "buy",
          reason: "持仓前收估值缺失，无法确定风险预算",
        });
        continue;
      }
      const knownValue = [...positions.values()].reduce(
        (sum, position) =>
          sum +
          (position.remainingQuantity ?? position.quantity) *
            position.lastPrice,
        0,
      );
      const entryEquity = cash + knownValue;
      const riskFraction = spec.management?.riskPreset
        ? riskPresetBudget(
            spec.management.riskPreset,
            spec.initialCapital,
            entryEquity,
            [...positions].map(([symbol, position]) => ({
              quantity: position.remainingQuantity ?? position.quantity,
              entry: position.entryPrice,
              stop: states.get(symbol)?.stop ?? null,
            })),
            spec.costs,
          )
        : spec.risk?.fraction;
      if (managed && (riskFraction == null || riskFraction <= 0)) {
        attempts.push({
          symbol: event.symbol,
          date,
          side: "buy",
          reason: "组合在险预算不足或持仓止损缺失，暂停新仓",
        });
        continue;
      }
      const totalWeight = Math.min(
        spec.management?.maxTotalWeight ?? 1,
        pyramid?.maxTotalWeight ?? 1,
        environmentLimit,
      );
      const liquidity = capacity(event.symbol, date);
      if (liquidity && liquidity.maxPositionValue == null) {
        attempts.push({
          symbol: event.symbol,
          date,
          side: "buy",
          reason: liquidity.reason ?? "成交额容量数据不可用",
        });
        continue;
      }
      const kelly = kellyFor(event, date);
      const kellyCheck = checkKelly(
        event,
        event.symbol,
        date,
        "entry",
        entryEquity,
        fill.price,
        entryEquity * (spec.risk?.fraction ?? 0),
      );
      if (kelly && (kelly.weight == null || kelly.weight <= 0)) {
        attempts.push({
          symbol: event.symbol,
          date,
          side: "buy",
          reason: kelly.reason ?? "凯利禁止入场",
        });
        continue;
      }
      const plannedQuantity = managed
        ? researchRiskQuantity({
            cash:
              pyramid ||
              spec.management?.maxTotalWeight != null ||
              marketEnvironment
                ? Math.min(
                    cash,
                    Math.max(0, entryEquity * totalWeight - knownValue),
                  )
                : cash,
            equity:
              cash +
              [...positions.values()].reduce(
                (sum, position) =>
                  sum +
                  (position.remainingQuantity ?? position.quantity) *
                    position.lastPrice,
                0,
              ),
            price: fill.price,
            stop: plannedRiskStop!,
            fraction:
              riskFraction! *
              (accountRisk?.multiplier() ?? 1) *
              (admission?.scale ?? 1),
            maxWeight: Math.min(
              spec.risk!.maxWeight *
                (accountRisk?.multiplier() ?? 1) *
                (admission?.scale ?? 1),
              admission?.maxWeight ?? 1,
              kelly?.weight ?? 1,
              liquidity?.maxPositionValue == null
                ? 1
                : liquidity.maxPositionValue / entryEquity,
            ),
            rules: dailyRules,
            costs: spec.costs,
          })
        : researchBuyQuantity(
            Math.min(cash, spec.initialCapital / spec.maxPositions),
            fill.price,
            dailyRules,
            spec.costs,
          );
      const confirmedPoint = technical
        .get(event.symbol)
        ?.get(event.observedDate);
      const entryFraction =
        confirmedPoint && "entryFraction" in confirmedPoint
          ? confirmedPoint.entryFraction
          : 1;
      let quantity = researchRoundedBuy(
        plannedQuantity * entryFraction * (pyramid ? 0.5 : 1),
        dailyRules,
      );
      if (
        spec.management?.contextRisk === "sw-preflight" ||
        spec.management?.swingDiscipline === "sw-min-rr2" ||
        admissionRule === "rr2"
      ) {
        const gate = swingRewardAdmission({
          entry: fill.price,
          stop: initialStop,
          target: event.entryTarget,
          quantity,
          rules: dailyRules,
          costs: spec.costs,
        });
        if (!gate.allow) {
          excluded.push({ event, reason: gate.reason ?? "2R准入拒绝" });
          finished.add(event);
          continue;
        }
      }
      let initialBatchRisk: number | null = null;
      if (pyramid) {
        for (
          ;
          quantity >= dailyRules.minimumBuy;
          quantity -= dailyRules.buyStep
        ) {
          const proceeds = researchPlannedProceeds(
            quantity,
            plannedRiskStop!,
            dailyRules,
            spec.costs,
          );
          if (proceeds == null) continue;
          const cost =
            quantity * fill.price +
            researchCommission(quantity * fill.price, spec.costs);
          const risk = Math.max(0, cost - proceeds);
          if (risk <= entryEquity * spec.risk!.fraction + 1e-8) {
            initialBatchRisk = risk;
            break;
          }
        }
        if (initialBatchRisk == null) quantity = 0;
      }
      if (!quantity) {
        attempts.push({
          symbol: event.symbol,
          date,
          side: "buy",
          reason: pyramid
            ? "首仓数量、分单退出费用或风险预算不足，不能证明按当前规则退出"
            : managed
              ? "风险或市值预算不足最小申报数量及费用"
              : "资金不足最小申报数量及费用",
        });
        continue;
      }
      if (spec.management?.riskPreset === "sw-riskcap3")
        cap3Entries.set(`${event.symbol}:${event.key}`, {
          equity: entryEquity,
          budget: entryEquity * 0.03,
          plannedRisk: plannedStopRisk(
            quantity,
            fill.price,
            plannedRiskStop!,
            spec.costs,
          ),
        });
      if (admissionCheck && admission) {
        const riskQuantity = researchRiskQuantity({
          cash: entryEquity,
          equity: entryEquity,
          price: fill.price,
          stop: plannedRiskStop!,
          fraction: riskFraction! * admission.scale,
          maxWeight: 1,
          rules: dailyRules,
          costs: spec.costs,
        });
        const kellyQuantity = researchBuyQuantity(
          entryEquity * admission.maxWeight,
          fill.price,
          dailyRules,
          spec.costs,
        );
        const singleStockQuantity = researchBuyQuantity(
          entryEquity * spec.risk!.maxWeight * admission.scale,
          fill.price,
          dailyRules,
          spec.costs,
        );
        const caps = [
          { name: "含费风险预算", quantity: riskQuantity },
          { name: "分数凯利", quantity: kellyQuantity },
          { name: "单股市值", quantity: singleStockQuantity },
        ];
        admissionCheck.sizing = {
          riskQuantity,
          kellyQuantity,
          singleStockQuantity,
          finalQuantity: quantity,
          binding:
            quantity < Math.min(...caps.map((c) => c.quantity))
              ? ["现金/总仓/申报约束"]
              : caps.filter((c) => c.quantity === quantity).map((c) => c.name),
        };
      }
      if (kellyCheck) kellyCheck.filledQuantity = quantity;
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
        ...(event.ruleStop ? { ruleStop: event.ruleStop } : {}),
        ...(pullback ? { pullbackEvidence: [] } : {}),
        exitDate: null,
        exitPrice: null,
        profit: null,
        netReturn: null,
        lastPrice: fill.price,
        ...(spec.management?.breakeven &&
        spec.management.breakeven.mode !== "r-only"
          ? { protectionEvidence: [] }
          : {}),
        ...(batched
          ? {
              remainingQuantity: quantity,
              realizedProceeds: 0,
              realizedProfit: 0,
              sales: [],
            }
          : {}),
        ...(pyramid
          ? {
              plannedQuantity,
              riskBudget: entryEquity * spec.risk!.fraction,
              book: researchBookBuy(researchPositionBook(), {
                date,
                quantity,
                price: fill.price,
                commission: researchCommission(amount, spec.costs),
              }),
              entries: [
                {
                  date,
                  triggerDate: event.observedDate,
                  quantity,
                  price: fill.price,
                  commission: researchCommission(amount, spec.costs),
                  plannedRisk: initialBatchRisk,
                  stop: initialStop!,
                },
              ],
            }
          : {}),
        ...(managed ? { initialStop: initialStop! } : {}),
        ...(stopOverride ? { initialStopOverride: stopOverride } : {}),
        ...((spec.management?.stop.kind === "max-distance" ||
          spec.management?.stop.kind === "nearest-stop") &&
        !stopOverride
          ? {
              initialStopCandidates: researchStopComparison(
                spec.management.stop,
                fill.price,
                event,
              )!.candidates,
            }
          : {}),
        ...(spec.management
          ? {
              plannedRiskStop: plannedRiskStop!,
              managementWarnings: [],
              stopHistory: [{ date, stop: initialStop!, reason: "入场冻结" }],
            }
          : {}),
      };
      if (spec.management)
        states.set(event.symbol, {
          stop: initialStop!,
          high: fill.price,
          breaches: 0,
          stage: 0,
          completedStages: 0,
          tailWarning: false,
        });
      positions.set(event.symbol, trade);
      if (pyramid) addStates.set(event.symbol, { stage: 0, stopped: false });
      trades.push(trade);
      finished.add(event);
    }
    // Completed-close indicator exits are known only after this day's fills.
    // Capture even for an unheld symbol so a blocked old buy cannot outlive
    // an intervening reverse signal. Earlier full-exit intents keep priority.
    for (const [symbol, points] of technical) {
      const point = points.get(date);
      if (!point || point.reason)
        signalGaps.push({
          symbol,
          date,
          reason: point?.reason ?? "缺少当日日线",
        });
      const held = positions.get(symbol);
      const current = indexed.get(symbol)?.get(date);
      if (
        held?.ruleStop &&
        current &&
        current.volume > 0 &&
        Number.isFinite(current.close) &&
        current.close > 0 &&
        index - held.entryIndex < held.ruleStop.days &&
        current.close < held.ruleStop.price &&
        !exits.has(symbol)
      ) {
        exits.set(
          symbol,
          `${held.ruleStop.reason}入场后${held.ruleStop.days}根内失守，下一可成交开盘退出`,
        );
        held.ruleStopTriggeredAt = date;
      }
      if (
        point &&
        "weeklyReduction" in point &&
        point.weeklyReduction &&
        held
      ) {
        (held.weeklyReductionChecks ??= []).push(point.weeklyReduction);
        if (point.weeklyReduction.triggered) {
          const remaining = held.remainingQuantity ?? held.quantity;
          const disposition = exits.has(symbol)
            ? "existing-full-exit"
            : partials.has(symbol)
              ? "existing-partial"
              : "queued";
          (held.weeklyReductionEvidence ??= []).push({
            signal: point.weeklyReduction,
            remainingQuantity: remaining,
            targetQuantity: remaining * point.weeklyReduction.fraction,
            disposition,
          });
          if (disposition === "queued")
            partials.set(symbol, {
              kind: "weekly",
              desired: remaining * point.weeklyReduction.fraction,
              triggerDate: date,
              reason: "已完成周线下破10周均线，减当时剩余持仓50%",
            });
        }
      }
      if (
        point &&
        "reduction" in point &&
        point.reduction &&
        held &&
        !exits.has(symbol) &&
        !partials.has(symbol)
      ) {
        partials.set(symbol, {
          kind: "signal",
          desired:
            (held.remainingQuantity ?? held.quantity) *
            point.reduction.fraction,
          triggerDate: date,
          reason: point.reduction.reason,
        });
      }
      if (!point?.exit) continue;
      if ("pivotFailures" in point) {
        const failed = failedBreakouts.get(symbol) ?? new Set<string>();
        for (const failure of point.pivotFailures)
          failed.add(failure.breakoutDate);
        failedBreakouts.set(symbol, failed);
        const position = positions.get(symbol);
        const failure = point.pivotFailures.find(
          (item) => item.breakoutDate === position?.event.observedDate,
        );
        if (position && failure && !exits.has(symbol)) {
          exits.set(
            symbol,
            `原突破后第${failure.day}日${failure.trigger === "low" ? "最低价" : "收盘价"}跌破枢纽，下一可成交开盘退出`,
          );
          position.signalExit = point;
        }
        continue;
      }
      lastSignalExit.set(symbol, date);
      const position = positions.get(symbol);
      if (position && !exits.has(symbol)) {
        exits.set(
          symbol,
          "bearExit" in point
            ? `收盘跌超4%且量${point.bearExit.basis === "previous" ? "大于前一日" : "至少前20日均量1.5倍"}，下一可成交开盘清仓`
            : "技术指标退出已收盘确认，下一可成交开盘退出",
        );
        position.signalExit = point;
      }
    }
    const stale: string[] = [];
    let value = cash;
    for (const [symbol, position] of positions) {
      const bar = indexed.get(symbol)?.get(date);
      if (bar && Number.isFinite(bar.close) && bar.close > 0)
        position.lastPrice = bar.close;
      else stale.push(symbol);
      value +=
        (position.remainingQuantity ?? position.quantity) * position.lastPrice;
      const validClose =
        !!bar && bar.volume > 0 && Number.isFinite(bar.close) && bar.close > 0;
      const state = states.get(symbol);
      if (spec.management && state) {
        const evolution = riskPresetEvolution(spec.management.riskPreset);
        if (evolution?.disaster) {
          const triggered = riskDisasterTriggered(
            bar,
            position.entryPrice,
            position.initialStop!,
            evolution.disaster,
          );
          if (triggered === null)
            position.managementWarnings!.push({
              date,
              reason: "灾难线缺有效OHLC/量，未补造触发",
            });
          if (triggered && !exits.has(symbol))
            exits.set(
              symbol,
              `日线最低价确认独立${evolution.disaster}灾难线，次日开盘退出`,
            );
        }

        if (spec.management.contextRisk) {
          const id = spec.management.contextRisk;
          const frozenThesis = spec.management.contextRiskInputs?.find(
            (r) =>
              r.symbol === symbol && r.date === position.event.observedDate,
          )?.thesis;
          const check = contextRiskPoint(
            id,
            spec.management.contextRiskInputs ?? [],
            symbol,
            date,
            calendar,
            frozenThesis,
          );
          contextChecks.push({ symbol, date, phase: "holding", check });
          if (check.status === "missing")
            position.managementWarnings!.push({
              date,
              reason: `missing: ${check.reason}`,
            });
          if (check.exit && !exits.has(symbol))
            exits.set(symbol, `${id}已确认，下一可成交开盘退出`);
          if (
            id === "rk-thesis" &&
            riskDisasterTriggered(
              bar,
              position.entryPrice,
              position.initialStop!,
              "2r",
            ) === true &&
            !exits.has(symbol)
          )
            exits.set(
              symbol,
              "日线最低价确认-2R灾难线，次日执行，不保证灾难价成交",
            );
        }
        if (growthDaily === "SE-D-review23") {
          const age =
            (Date.parse(date) - Date.parse(position.entryDate)) / 86400000;
          for (const due of [14, 21])
            if (
              age >= due &&
              !position.growthReviews?.some((r) => r.days === due)
            ) {
              const pivot = position.event.entryPriceRange?.min ?? null;
              const gain = validClose
                ? bar!.close / position.entryPrice - 1
                : null;
              const invalid =
                gain === null || pivot === null
                  ? null
                  : gain < 0.05 - 1e-12 && bar!.close < pivot;
              (position.growthReviews ??= []).push({
                date,
                days: due,
                gain,
                pivot,
                invalid,
              });
              if (invalid)
                exits.set(
                  symbol,
                  `自然${due}天复核涨幅不足5%且收盘失守冻结枢纽，次日退出`,
                );
              if (invalid === null)
                position.managementWarnings!.push({
                  date,
                  reason: `自然${due}天复核不可用：缺少当日收盘或冻结枢纽，不补造`,
                });
            }
        }
        if (
          growthDaily === "CA-D-volume-sell" ||
          growthDaily === "CA-D-distribution5"
        ) {
          const reduce =
            growthDaily === "CA-D-volume-sell"
              ? growthVolumeReduction(series.get(symbol) ?? [], calendar, date)
              : growthDistributionReduction(
                  growthMarket?.symbol === "sh000300" ? growthMarket.bars : [],
                  calendar,
                  date,
                );
          if (reduce === null)
            position.managementWarnings!.push({
              date,
              reason: "异常减仓输入或逐日日历不完整，本日不可用",
            });
          else if (reduce && !exits.has(symbol) && !partials.has(symbol))
            partials.set(symbol, {
              kind: "weekly",
              desired: position.remainingQuantity! * 0.5,
              triggerDate: date,
              reason:
                growthDaily === "CA-D-volume-sell"
                  ? "明显放量下跌减半"
                  : "沪深300连续第五分布日减半",
            });
        }
        if (
          spec.management.sepaElite &&
          !position.sepaElite &&
          !exits.has(symbol)
        ) {
          const elite = researchSepaElite(
            position,
            date,
            days,
            indexed.get(symbol)!,
          );
          if (elite) position.sepaElite = elite;
        }
        if (!validClose) {
          if (pullback) {
            addStates.get(symbol)!.stopped = true;
            additions.delete(symbol);
          }
          state.breaches = 0;
          position.managementWarnings!.push({
            date,
            reason: "缺少有效成交收盘，连续确认重置且本日不更新移动止损",
          });
          continue;
        }
        // Test the line known before this close; close-derived raises apply
        // from the next session. An already queued exit is never revoked.
        state.breaches = bar.close <= state.stop ? state.breaches + 1 : 0;
        if (
          state.breaches >= spec.management.confirmations &&
          !exits.has(symbol)
        )
          exits.set(
            symbol,
            `连续${spec.management.confirmations}根有效收盘失守止损，下一可成交开盘退出`,
          );
        const time = spec.management.timeExit;
        if (
          spec.management.progressExit &&
          !position.progressExitCheck &&
          !exits.has(symbol)
        ) {
          const check = researchProgressCheck(
            spec.management.progressExit,
            position,
            bar,
            index,
            days,
          );
          if (check) {
            position.progressExitCheck = check;
            if (check.triggered)
              exits.set(
                symbol,
                `${check.clock === "calendar-days" ? "自然" : "含入场日交易"}${check.days}天到期收盘涨幅不足${check.minimumGain * 100}%，下一可成交开盘退出`,
              );
          }
        }
        if (
          time &&
          index - position.entryIndex + 1 >= time.days &&
          (bar.close - position.entryPrice) /
            (position.entryPrice - position.initialStop!) <
            time.minR &&
          !exits.has(symbol)
        )
          exits.set(
            symbol,
            `持仓${time.days}个交易日后收盘进展不足${time.minR}R`,
          );
        if (Number.isFinite(bar.high) && bar.high >= bar.close)
          state.high = Math.max(state.high, bar.high);
        const breakeven = spec.management.breakeven;
        if (
          breakeven &&
          state.stop < position.entryPrice &&
          !exits.has(symbol) &&
          bar.close >=
            position.entryPrice +
              breakeven.atR * (position.entryPrice - position.initialStop!)
        ) {
          const structure =
            breakeven.mode === "r-only"
              ? null
              : researchHigherLow(
                  (series.get(symbol) ?? []).filter((row) => row.date <= date),
                  position.entryDate,
                  position.entryPrice,
                );
          if (structure) position.protectionEvidence!.push({ date, structure });
          if (
            breakeven.mode === "r-only" ||
            structure?.status === "confirmed"
          ) {
            state.stop = position.entryPrice;
            position.stopHistory!.push({
              date,
              stop: state.stop,
              reason:
                breakeven.mode === "r-only"
                  ? `收盘浮盈达到${breakeven.atR}R，下一交易日起移至首仓成交价`
                  : "浮盈及入场后更高低点已确认，下一交易日起移至成交价",
            });
          }
        }
        const trailActive =
          !spec.management.trailAfterScaleOut ||
          state.completedStages === scaleOut?.length;
        if (
          !trailActive &&
          scaleOut &&
          state.stage >= scaleOut.length &&
          !state.tailWarning
        ) {
          position.managementWarnings!.push({
            date,
            reason: "存在未实际完成的减仓档，末档后移动止损尚未激活",
          });
          state.tailWarning = true;
        }
        const currentAtr = trailAtr.get(symbol)?.get(date);
        const rawVolatilityLine = volatilityLines.get(symbol)?.get(date);
        const opposite =
          spec.management.volatilityStop === "rk-keltner-opposite";
        const volatilityLine = opposite ? null : rawVolatilityLine;
        if (
          opposite &&
          rawVolatilityLine != null &&
          bar.close >= rawVolatilityLine &&
          !exits.has(symbol)
        )
          exits.set(symbol, "收盘达到Keltner对侧上轨目标，下一可成交开盘退出");
        const externalId = spec.management.volatilityStop;
        if (externalId && isExternalVolatility(externalId)) {
          const check = externalVolatilityPoint(
            externalId,
            series.get(symbol) ?? [],
            symbol,
            date,
            spec.management.volatilityInputs,
            calendar,
          );
          if (check.status === "missing")
            position.managementWarnings!.push({
              date,
              reason: `missing: ${check.reason}`,
            });
          else if (externalId === "rk-kase-stages") {
            const targetState = kaseTargets.get(
              `${symbol}:${position.event.key}`,
            )!;
            if (check.warning != null && bar.close <= check.warning)
              position.managementWarnings!.push({
                date,
                reason: "Kase预警线触及；预警本身不卖出",
              });
            const deepest = check.levels.reduce(
              (level, line, i) => (bar.close <= line ? i : level),
              -1,
            );
            targetState.level = Math.max(targetState.level, deepest);
            if (targetState.level === 2 && !exits.has(symbol))
              exits.set(symbol, "Kase第三级确认全清，受阻保留退出");
            else if (
              targetState.level >= 0 &&
              !exits.has(symbol) &&
              !partials.has(symbol)
            ) {
              const remaining = position.remainingQuantity ?? position.quantity;
              const desired = Math.max(
                0,
                position.quantity * targetState.fractions[targetState.level]! -
                  (position.quantity - remaining),
              );
              if (desired > 1e-8)
                partials.set(symbol, {
                  kind: "signal",
                  desired,
                  triggerDate: date,
                  reason: `Kase第${targetState.level + 1}级累计原始仓位减仓`,
                });
            }
          }
        }
        if (
          trailActive &&
          trail?.kind === "volatility" &&
          rawVolatilityLine == null
        )
          position.managementWarnings!.push({
            date,
            reason: "波动止损窗口缺失或非法，保留上一有效止损线",
          });
        if (
          trailActive &&
          (trail?.kind === "chandelier" ||
            trail?.kind === "close-atr" ||
            trail?.kind === "rolling-chandelier") &&
          currentAtr == null
        )
          position.managementWarnings!.push({
            date,
            reason: "移动ATR缺失，保留上一有效止损线",
          });
        const windowHigh = trailHigh.get(symbol)?.get(date);
        if (
          trailActive &&
          trail?.kind === "rolling-chandelier" &&
          windowHigh == null
        )
          position.managementWarnings!.push({
            date,
            reason: "窗口最高价不足或含无效行情，保留上一有效止损线",
          });
        const retracement =
          trail?.kind === "retracement"
            ? researchRetracementStop(
                position.entryPrice,
                position.initialStop!,
                state.high,
              )
            : null;
        if (evolution?.structureTrail) {
          const prefix = (series.get(symbol) ?? []).filter(
            (b) => b.date <= date,
          );
          const window = prefix.slice(-60);
          const complete =
            window.length === 60 &&
            calendar
              .filter((d) => d >= window[0]!.date && d <= date)
              .every((d) => window.some((b) => b.date === d));
          const structure = complete
            ? researchHigherLow(prefix, position.entryDate, position.entryPrice)
            : { status: "unavailable" as const };
          if (
            structure.status === "confirmed" &&
            structure.latest &&
            structure.latest.price > state.stop &&
            !exits.has(symbol)
          ) {
            state.stop = structure.latest.price;
            position.stopHistory!.push({
              date,
              stop: state.stop,
              reason: "因果更高低点确认结构跟随，下一交易日起生效",
            });
          }
        }
        const nextStop = !trailActive
          ? state.stop
          : trail?.kind === "volatility"
            ? (volatilityLine ?? state.stop)
            : trail?.kind === "retracement"
              ? (retracement?.stop ?? state.stop)
              : trail?.kind === "percent"
                ? state.high * (1 - trail.fraction)
                : trail?.kind === "distance"
                  ? state.high - trail.distance
                  : trail?.kind === "rolling-chandelier" &&
                      currentAtr != null &&
                      windowHigh != null
                    ? windowHigh - trail.multiple * currentAtr
                    : trail?.kind === "chandelier" && currentAtr != null
                      ? state.high - trail.multiple * currentAtr
                      : trail?.kind === "close-atr" && currentAtr != null
                        ? bar.close - trail.multiple * currentAtr
                        : state.stop;
        if (
          Number.isFinite(nextStop) &&
          nextStop > state.stop &&
          !exits.has(symbol)
        ) {
          state.stop = nextStop;
          position.stopHistory!.push({
            date,
            stop: nextStop,
            reason: retracement
              ? `最高浮盈${retracement.peakR}R，允许回吐${retracement.giveback * 100}%，下一交易日起生效`
              : "收盘更新，下一交易日起生效",
          });
        }
        const target = scaleOut?.[state.stage];
        if (
          target &&
          !exits.has(symbol) &&
          !partials.has(symbol) &&
          bar.close >=
            position.entryPrice +
              target.atR * (position.entryPrice - position.initialStop!)
        ) {
          const cumulative = scaleOut!
            .slice(0, state.stage + 1)
            .reduce((sum, row) => sum + row.fraction, 0);
          partials.set(symbol, {
            stage: state.stage,
            desired:
              cumulative >= 1 - 1e-10
                ? position.remainingQuantity!
                : Math.min(
                    position.remainingQuantity!,
                    (position.book?.totalQuantity ?? position.quantity) *
                      target.fraction,
                  ),
            triggerDate: date,
          });
        }
        if (pyramid) {
          const addState = addStates.get(symbol)!;
          if (exits.has(symbol) || partials.has(symbol)) {
            addState.stopped = true;
            additions.delete(symbol);
          }
          if (pullback && !addState.stopped && addState.stage < 1) {
            const check = researchPullbackConfirmation({
              bar,
              level: position.event.pullbackLevel!,
              age: index - days.indexOf(position.event.observedDate),
              waitBars: pullback.waitBars,
              tolerance: pullback.tolerance,
              requireProfit: pullback.requireProfit,
              quantity: position.book!.remainingQuantity,
              cost: position.book!.remainingCost,
              alreadyConfirmed: additions.has(symbol),
            });
            position.pullbackEvidence!.push(check);
            if (check.status === "cancelled" || check.status === "expired") {
              addState.stopped = true;
              additions.delete(symbol);
              position.managementWarnings!.push({
                date,
                reason:
                  check.status === "expired"
                    ? "回踩确认期结束，保留首仓管理，取消第二笔"
                    : "回踩输入无效或盘中失守冻结位，取消第二笔",
              });
            } else if (
              check.status === "confirmed" &&
              !holdingDue(position, index, date)
            ) {
              additions.set(symbol, {
                stage: 0,
                triggerDate: date,
                triggerIndex: index,
              });
            }
          }
          if (
            !pullback &&
            !addState.stopped &&
            addState.stage < (growthAdd ? 1 : 2) &&
            !holdingDue(position, index, date) &&
            !additions.has(symbol) &&
            (growthAdd
              ? growthAddConfirmation(
                  series.get(symbol) ?? [],
                  growthMarket?.symbol === "sh000300" ? growthMarket.bars : [],
                  calendar,
                  date,
                  position.entryPrice,
                ) === true
              : bar.close >=
                position.entryPrice +
                  (addState.stage + 1) *
                    (position.entryPrice - position.initialStop!))
          )
            additions.set(symbol, {
              stage: addState.stage,
              triggerDate: date,
              triggerIndex: index,
            });
        }
      } else if (
        managed &&
        bar &&
        bar.volume > 0 &&
        Number.isFinite(bar.close) &&
        bar.close > 0 &&
        bar.close <= position.initialStop!
      )
        exits.set(symbol, "收盘失守信号日结构位，下一可成交开盘退出");
    }
    accountRisk?.close(index, value, stale.length > 0);
    nav.push({ date, value, cash, stale });
    previousStale = stale;
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
    ...(staticKelly
      ? {
          kelly: {
            ...spec.management!.kelly!,
            ...staticKelly,
            ...(qualityKelly || rollingKelly
              ? { reason: "逐信号质量代理，见kellyChecks", perSignal: true }
              : {}),
          },
          kellyChecks,
        }
      : {}),
    trades,
    ...(spec.management?.liquidityCap
      ? { liquidityChecks: [...liquidityChecks.values()] }
      : {}),
    ...(spec.management?.riskPreset === "sw-riskcap3"
      ? {
          riskCap3: trades.map((t) => {
            const plan = cap3Entries.get(`${t.event.symbol}:${t.event.key}`)!;
            const actualLoss =
              t.profit === null ? null : Math.max(0, -t.profit);
            return {
              symbol: t.event.symbol,
              eventKey: t.event.key,
              ...plan,
              actualLoss,
              excess:
                actualLoss === null
                  ? null
                  : Math.max(0, actualLoss - plan.budget),
              lossFraction:
                actualLoss === null ? null : actualLoss / plan.equity,
            };
          }),
        }
      : {}),
    ...(admissionRule ? { riskAdmissionChecks } : {}),
    ...(spec.management?.contextRisk ? { contextChecks } : {}),
    ...(accountRisk ? { accountRisk: accountRisk.snapshot() } : {}),
    ...(lossPause ? { lossPause: lossPause.snapshot(days.length - 1) } : {}),
    ...(marketEnvironment ? { marketEnvironment } : {}),
    ...(marketChop ? { marketChop } : {}),
    ...(technicalId ? { signalGaps } : {}),
    ...(pyramid
      ? {
          pendingAdditions: [...additions].map(([symbol, request]) => ({
            symbol,
            ...request,
          })),
        }
      : {}),
    ...(batched || technicalId
      ? {
          pendingSales: [...positions.values()].flatMap((trade) => {
            const symbol = trade.event.symbol;
            const full =
              exits.has(symbol) ||
              holdingDue(trade, days.length - 1, days.at(-1)!);
            const partial = partials.get(symbol);
            return full || partial
              ? [
                  {
                    symbol,
                    remainingQuantity:
                      trade.remainingQuantity ?? trade.quantity,
                    targetQuantity: full
                      ? (trade.remainingQuantity ?? trade.quantity)
                      : partial!.desired,
                    triggerDate: full ? null : partial!.triggerDate,
                    reason: full
                      ? (exits.get(symbol) ?? "达到最长持有交易日")
                      : "stage" in partial!
                        ? `第${partial!.stage + 1}档待卖`
                        : partial!.reason,
                  },
                ]
              : [];
          }),
        }
      : {}),
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
