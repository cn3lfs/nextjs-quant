import type { Bar } from "trading-strategy-core/bars";
import {
  atr,
  confirmedExtrema,
  rollingHigh,
} from "trading-strategy-core/indicators";
import { analyzeBreakout } from "../breakout/breakout.js";
import { researchSepaSeries } from "../canslim/research-sepa.js";
import {
  growthIntradayTemplate,
  type GrowthIntradayId,
} from "../factors/research-growth-intraday.js";

type PriceRange = { min: number; max: number };
type EntryIntent = {
  key: string;
  strategyVersion: string;
  evidence: string;
  historyStart: string;
  entryPriceRange?: PriceRange;
};

/** Only the caller's completed five-minute prefix contributes to partialDay. */
export function growthIntradayEntryDecision(input: {
  id?: GrowthIntradayId;
  symbol: string;
  priorDaily: readonly Bar[];
  partialDay: Bar;
  observedAt: string;
  completedBars: number;
  calendar: readonly string[];
}): { usable: boolean; intent: EntryIntent | null } {
  const {
    id,
    symbol,
    priorDaily,
    partialDay,
    observedAt,
    completedBars,
    calendar,
  } = input;
  // A close observed at 15:00 cannot create a same-close first leg.
  if (completedBars >= 48) return { usable: false, intent: null };
  const prefix = [...priorDaily, partialDay];
  if (id === "SW02-last30") {
    if (completedBars < 42) return { usable: false, intent: null };
    const point = analyzeBreakout(prefix).latest;
    return {
      usable: point?.long.status !== "未知",
      intent:
        point?.long.status === "是"
          ? {
              key: `sw-last30-1:${symbol}:${observedAt}`,
              strategyVersion: "sw-last30-1",
              evidence: JSON.stringify({
                point,
                completedBars,
                volume: partialDay.volume,
              }),
              historyStart: prefix[0]!.date,
            }
          : null,
    };
  }
  const point = researchSepaSeries(
    "sepa-vcp-close",
    prefix,
    calendar,
    priorDaily.length,
  ).at(-1)!;
  return {
    usable: point.reason === null,
    intent:
      point.entry && point.candidate
        ? {
            key: `growth-intraday-1:${symbol}:${observedAt}`,
            strategyVersion: "growth-intraday-1",
            evidence: JSON.stringify(point),
            historyStart: point.historyStart!,
            entryPriceRange: {
              min: point.candidate.high,
              max: point.maxEntryPrice!,
            },
          }
        : null,
  };
}

export function growthIntradayGapDecision(
  id: GrowthIntradayId,
  previousClose: number,
  open: number,
  entry: number,
  stop: number,
) {
  return {
    stop:
      id.endsWith("gapup3") && open > previousClose * 1.03 + 1e-10
        ? Math.max(stop, entry)
        : null,
    reduceFraction:
      id.endsWith("gapdown3") && open < previousClose * 0.97 - 1e-10
        ? 0.5
        : null,
  };
}

export function growthIntradayLifeLineLost(
  completed: readonly Bar[],
  stop: number,
) {
  return (
    completed.length >= 2 &&
    completed.slice(-2).every((bar) => bar.close < stop)
  );
}

export function growthIntradayAuctionQueueDecision(
  prior: Bar | undefined,
  limitDown: number | null | undefined,
) {
  return (
    !!prior &&
    limitDown != null &&
    prior.high === prior.low &&
    prior.close <= limitDown
  );
}

/** Closing review also applies the ordinary close stop in the swing composite. */
export function growthIntradayStopDecision(input: {
  id: GrowthIntradayId;
  completed: Bar;
  entry: number;
  initialStop: number;
  stop: number;
  afterEntryDay: boolean;
  closing: boolean;
}) {
  const { id, completed, entry, initialStop, stop, afterEntryDay, closing } =
    input;
  const swing = id === "RK-C-swing-system";
  const triggered = swing
    ? completed.low <= entry - 2 * (entry - initialStop) ||
      (closing && completed.close < stop)
    : id.startsWith("RK-")
      ? completed.low <= stop
      : completed.close < stop && (closing || afterEntryDay);
  if (!triggered) return null;
  if (closing)
    return id.startsWith("RK-")
      ? "15:00完成五分钟触碰，下一交易日开盘"
      : "15:00收盘跌破止损";
  return id.startsWith("RK-")
    ? "完成五分钟最低价触碰止损，下一根开盘"
    : "五分钟收盘跌破止损";
}

export function growthIntradayTimeDecision(input: {
  completedMinutes: number;
  close: number;
  entry: number;
  initialStop: number;
}) {
  const completedMinutes = input.completedMinutes + 5;
  const checked = completedMinutes >= 30;
  return {
    completedMinutes,
    checked,
    exitReason:
      checked &&
      input.close < input.entry + 0.5 * (input.entry - input.initialStop)
        ? "30交易分钟收盘未达0.5R，时间止损"
        : null,
  };
}

export function growthIntradayInitialStop(input: {
  id: GrowthIntradayId;
  price: number;
  opening: boolean;
  openingStop?: number | null;
  swingStop?: number | null;
  priorMinutes: readonly Bar[] | null;
}) {
  if (input.opening) return input.openingStop ?? NaN;
  if (input.id === "RK-C-swing-system") return input.swingStop ?? NaN;
  if (input.id === "RK-A-intraday-points30") return input.price - 0.5;
  if (input.id === "RK-A-intraday-structure30")
    return input.priorMinutes
      ? (confirmedExtrema(input.priorMinutes)
          .extrema.filter((point) => point.kind === "low")
          .at(-1)?.price ?? NaN)
      : NaN;
  const policy = growthIntradayTemplate(input.id).stop;
  return policy.kind === "percent" ? input.price * (1 - policy.fraction) : NaN;
}

export function growthIntradayStopAdmissible(
  id: GrowthIntradayId,
  price: number,
  stop: number,
  stopAtr?: number | null,
) {
  return (
    Number.isFinite(stop) &&
    stop > 0 &&
    stop < price &&
    !(
      id === "RK-C-swing-system" &&
      (stopAtr == null || price - stop > 2 * stopAtr + 1e-10)
    )
  );
}

export function growthIntradayOpeningSpace(
  price: number,
  plan: { life: number; resistance: number } | undefined,
) {
  return (
    !!plan &&
    !(price <= plan.life || plan.resistance - price < 2 * (price - plan.life))
  );
}

export function growthIntradayPriceInRange(
  price: number,
  range: PriceRange | undefined,
) {
  return !range || !(price < range.min || price > range.max);
}

export function growthIntradayRiskMultiplier(opening: boolean) {
  return opening ? 0.5 : 1;
}

export function growthIntradayEntryQuantity(
  id: GrowthIntradayId,
  planned: number,
  rotationCap: number,
) {
  return id === "SE-E-intraday50" || id === "OP08"
    ? planned / 2
    : Math.min(planned, rotationCap);
}

/** Completed five-minute bars, so OP08 begins after thirty trading minutes. */
export function growthIntradayAdditionSlot(
  id: GrowthIntradayId,
  completedBars: number,
) {
  return completedBars === 0 || (id === "OP08" && completedBars >= 6);
}

export function growthIntradayOpeningAdditionEligible(
  id: GrowthIntradayId,
  date: string,
  entryDate: string,
  entryCount: number,
) {
  return id === "OP08" && date > entryDate && entryCount === 1;
}

export function growthIntradaySwingCloseDecision(input: {
  entry: number;
  initialStop: number;
  close: number;
  stop: number;
  heldDays: number;
  maxR: number;
  scaled: boolean;
  pending: boolean;
  tailReady: boolean;
  dailyPrefix: readonly Bar[];
}) {
  const distance = input.entry - input.initialStop;
  const r = (input.close - input.entry) / distance;
  const maxR = Math.max(input.maxR, r);
  const timeExit = input.heldDays >= 10 && maxR < 0.5 && !input.pending;
  let stop = input.stop;
  if (r >= 1) stop = Math.max(stop, input.entry);
  const scale = r >= 2 && !input.scaled && !input.pending && !timeExit;
  if (scale) stop = Math.max(stop, input.entry + distance);
  let warning: string | null = null;
  if (input.tailReady) {
    const volatility = atr(input.dailyPrefix, 22).at(-1);
    const high = rollingHigh(input.dailyPrefix, 22).at(-1);
    if (volatility != null && high != null)
      stop = Math.max(stop, high - 3 * volatility);
    else warning = "尾仓22日ATR/最高价缺失";
  }
  return {
    maxR,
    stop,
    scaled: input.scaled || scale,
    warning,
    sale: timeExit
      ? { fraction: 1, originalQuantity: false, reason: "10日未达0.5R时间止损" }
      : scale
        ? {
            fraction: 0.5,
            originalQuantity: true,
            reason: "2R减原始半仓并抬1R",
          }
        : null,
  };
}

export function growthIntradayReviewDecision(
  id: GrowthIntradayId,
  reviewClose: number,
  previousClose: number,
) {
  return id === "CA-D-review1430" && reviewClose < previousClose * 0.98 - 1e-10
    ? { fraction: 0.5, reason: "14:30较昨收跌超2%异常减半" }
    : null;
}

export function growthIntradayAdditionDecision(input: {
  id: GrowthIntradayId;
  intradayEntry: boolean;
  range?: PriceRange;
  close: number;
  completedDay: readonly Bar[];
  priorDaily: readonly Bar[];
}) {
  if (input.id !== "SE-E-intraday50" || !input.intradayEntry || !input.range)
    return false;
  const average = input.priorDaily
    .slice(-20)
    .reduce((sum, bar) => sum + bar.volume / 20, 0);
  return (
    input.close > input.range.min * 1.01 &&
    input.close <= input.range.max &&
    input.completedDay.reduce((sum, bar) => sum + bar.volume, 0) >=
      average * 1.5
  );
}

export function growthIntradayScheduledEventReduction(input: {
  available: boolean;
  allow: boolean;
  eventId?: string;
  reducedEventIds: ReadonlySet<string>;
  pending: boolean;
}) {
  return input.available &&
    !input.allow &&
    input.eventId &&
    !input.reducedEventIds.has(input.eventId) &&
    !input.pending
    ? {
        eventId: input.eventId,
        fraction: 0.5,
        reason: "已知事件前三交易日减半",
      }
    : null;
}

export function growthIntradaySwingRiskBudget(
  equity: number,
  streakMultiplier: number,
) {
  return equity * 0.01 * streakMultiplier;
}
