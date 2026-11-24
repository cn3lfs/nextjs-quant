import type { TradeCycle } from "./trades.js";
/** Host-independent daily performance. No trading, IO or archive mutation. */
export type PerformanceMetric = { value: number | null; reason: string | null };
export type PerformancePoint = {
  date: string;
  value: number;
  benchmarkReturn?: number;
};
export type DrawdownEpisode = {
  peakDate: string;
  valleyDate: string;
  recoveryDate: string | null;
  depth: number;
  /** Durations are elapsed calendar days between the recorded dates. */
  recoveryDays: number | null;
  observedRecoveryDays: number;
  underwaterDays: number;
};
export type PerformanceEvaluation = {
  version: "daily-performance-v1";
  start: string | null;
  end: string | null;
  initial: number;
  days: number;
  shortSample: boolean;
  totalReturn: PerformanceMetric;
  annualReturn: PerformanceMetric;
  benchmarkReturn: PerformanceMetric;
  excessReturn: PerformanceMetric;
  sharpe: PerformanceMetric;
  sortino: PerformanceMetric;
  informationRatio: PerformanceMetric;
  annualVolatility: PerformanceMetric;
  trackingError: PerformanceMetric;
  maxDrawdown: PerformanceMetric;
  calmar: PerformanceMetric;
  recoveryDays: PerformanceMetric;
  longestUnderwaterDays: PerformanceMetric;
  maxDrawdownEpisode: DrawdownEpisode | null;
};
export type PerformanceFrequency = "year" | "quarter" | "month";
export type PerformancePeriod = {
  key: string;
  year: number;
  boundary: boolean;
  evaluation: PerformanceEvaluation;
};
const defaultAnnualizationDays = 252;
const metric = (value: number | null, reason = "计算结果非有限") =>
  value !== null && Number.isFinite(value)
    ? { value, reason: null }
    : {
        value: null,
        reason: value === null ? reason : "计算结果非有限（数值溢出）",
      };
const mean = (values: readonly number[]) =>
  values.reduce((sum, value) => sum + value / values.length, 0);
const sampleStd = (values: readonly number[]) => {
  const offsets = values.map((value) => value - values[0]!);
  const center = mean(offsets);
  return Math.sqrt(
    offsets.reduce((sum, value) => sum + (value - center) ** 2, 0) /
      (values.length - 1),
  );
};
const daysBetween = (start: string, end: string) =>
  Math.round((Date.parse(end) - Date.parse(start)) / 86400000);

function validatePerformancePoints(
  initial: number,
  points: readonly PerformancePoint[],
) {
  if (!Number.isFinite(initial) || initial <= 0)
    throw new Error("评价期初权益必须为正有限数");
  let previousDate = "";
  for (const point of points) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(point.date) ||
      !Number.isFinite(Date.parse(point.date)) ||
      new Date(point.date).toISOString().slice(0, 10) !== point.date ||
      point.date <= previousDate ||
      !Number.isFinite(point.value) ||
      point.value < 0 ||
      (point.benchmarkReturn !== undefined &&
        (!Number.isFinite(point.benchmarkReturn) ||
          point.benchmarkReturn <= -1))
    )
      throw new Error(
        "评价数据日期、权益或对照收益无效；不得缺失补零或交集拼接",
      );
    previousDate = point.date;
  }
}

function* scanDrawdownEpisodes(
  points: readonly PerformancePoint[],
  indexes: Iterable<number>,
  initial: number,
  initialDate: string,
) {
  let peak = initial;
  let peakDate = initialDate;
  let peakIndex = -1;
  let lastIndex = -1;
  let current: DrawdownEpisode | null = null;
  for (const i of indexes) {
    const point = points[i]!;
    lastIndex = i;
    if (point.value >= peak) {
      if (current) {
        current.recoveryDate = point.date;
        current.recoveryDays = daysBetween(current.valleyDate, point.date);
        current.observedRecoveryDays = current.recoveryDays;
        current.underwaterDays = daysBetween(current.peakDate, point.date);
        yield { episode: current, start: peakIndex, end: i };
        current = null;
      }
      peak = point.value;
      peakDate = point.date;
      peakIndex = i;
      continue;
    }
    const depth = 1 - point.value / peak;
    if (!current)
      current = {
        peakDate,
        valleyDate: point.date,
        recoveryDate: null,
        depth,
        recoveryDays: null,
        observedRecoveryDays: 0,
        underwaterDays: 0,
      };
    if (depth > current.depth) {
      current.depth = depth;
      current.valleyDate = point.date;
    }
    current.observedRecoveryDays = daysBetween(current.valleyDate, point.date);
    current.underwaterDays = daysBetween(current.peakDate, point.date);
  }
  if (current) yield { episode: current, start: peakIndex, end: lastIndex };
}

/** Rank by depth, removing each peak-through-recovery interval inclusively
 * and rescanning the joined sequence at its original observation positions.
 * An unrecovered episode extends to the last remaining observation.
 */
export function topDrawdownEpisodes(
  initial: number,
  points: readonly PerformancePoint[],
  limit = 5,
): DrawdownEpisode[] {
  validatePerformancePoints(initial, points);
  if (!Number.isSafeInteger(limit) || limit < 0)
    throw new Error("回撤段数上限必须为非负安全整数");
  let remaining = Array.from(points.keys());
  const episodes: DrawdownEpisode[] = [];
  while (episodes.length < limit && remaining.length) {
    let worst: { episode: DrawdownEpisode; start: number; end: number } | null =
      null;
    for (const candidate of scanDrawdownEpisodes(
      points,
      remaining,
      initial,
      points[remaining[0]!]!.date,
    )) {
      if (candidate.episode.depth > (worst?.episode.depth ?? 0))
        worst = candidate;
    }
    if (!worst) break;
    episodes.push(worst.episode);
    remaining = remaining.filter((i) => i < worst.start || i > worst.end);
  }
  return episodes;
}

export function evaluatePerformance(
  initial: number,
  points: readonly PerformancePoint[],
  initialDate = points[0]?.date,
  annualizationDays = defaultAnnualizationDays,
): PerformanceEvaluation {
  validatePerformancePoints(initial, points);
  if (!Number.isInteger(annualizationDays) || annualizationDays <= 0)
    throw new Error("年化交易日数必须为正整数");
  const dailyRiskFree = 1.02 ** (1 / annualizationDays) - 1;
  let previous = initial;
  const returns = points.map((point) => {
    const value = previous > 0 ? point.value / previous - 1 : 0;
    previous = point.value;
    return value;
  });
  const n = points.length;
  const empty = metric(null, "没有日收盘净值");
  const annualMissing = `不足${annualizationDays}个交易日，不展示年化收益与Calmar`;
  const missingBenchmark = "缺少完整同窗持有对照";
  const differential = returns.map((r) => r - dailyRiskFree);
  const deviation = n >= 2 ? sampleStd(returns) : 0;
  const downside = Math.sqrt(
    mean(differential.map((r) => Math.min(r, 0) ** 2)),
  );
  const hasBenchmark =
    n > 0 && points.every((p) => p.benchmarkReturn !== undefined);
  const active = hasBenchmark
    ? returns.map((r, i) => r - points[i]!.benchmarkReturn!)
    : [];
  const activeStd = n >= 2 && hasBenchmark ? sampleStd(active) : 0;
  const total = n ? points.at(-1)!.value / initial - 1 : null;
  const annual =
    n >= annualizationDays ? (1 + total!) ** (annualizationDays / n) - 1 : null;
  const benchmark = hasBenchmark
    ? points.reduce((value, p) => value * (1 + p.benchmarkReturn!), 1) - 1
    : null;

  let worst: DrawdownEpisode | null = null;
  let longestUnderwaterDays = 0;
  for (const { episode } of scanDrawdownEpisodes(
    points,
    points.keys(),
    initial,
    initialDate ?? "",
  )) {
    if (!worst || episode.depth > worst.depth) worst = episode;
    longestUnderwaterDays = Math.max(
      longestUnderwaterDays,
      episode.underwaterDays,
    );
  }
  const maxDrawdown = worst?.depth ?? 0;
  const recovery = worst
    ? metric(
        worst.recoveryDays,
        `未修复，已观察${worst.observedRecoveryDays}自然日（谷底起）`,
      )
    : metric(null, "无回撤，不适用");
  return {
    version: "daily-performance-v1",
    start: points[0]?.date ?? null,
    end: points.at(-1)?.date ?? null,
    initial,
    days: n,
    shortSample: n < annualizationDays,
    totalReturn: n ? metric(total) : empty,
    annualReturn: n ? metric(annual, annualMissing) : empty,
    benchmarkReturn: metric(benchmark, missingBenchmark),
    excessReturn: metric(
      total !== null && benchmark !== null ? total - benchmark : null,
      missingBenchmark,
    ),
    sharpe: metric(
      n >= 2 && deviation > 0
        ? (mean(differential) / deviation) * Math.sqrt(annualizationDays)
        : null,
      n < 2 ? "至少需要2个交易日" : "日收益零波动，夏普不可计算",
    ),
    sortino: metric(
      n && downside > 0
        ? (mean(differential) / downside) * Math.sqrt(annualizationDays)
        : null,
      "无下行偏差或没有样本，索提诺不可计算",
    ),
    informationRatio: metric(
      activeStd > 0
        ? (mean(active) / activeStd) * Math.sqrt(annualizationDays)
        : null,
      !hasBenchmark
        ? missingBenchmark
        : n < 2
          ? "至少需要2个交易日"
          : "跟踪误差为零，信息比率不可计算",
    ),
    annualVolatility: metric(
      n >= 2 ? deviation * Math.sqrt(annualizationDays) : null,
      "至少需要2个交易日",
    ),
    trackingError: metric(
      hasBenchmark && n >= 2 ? activeStd * Math.sqrt(annualizationDays) : null,
      hasBenchmark ? "至少需要2个交易日" : missingBenchmark,
    ),
    maxDrawdown: n ? metric(maxDrawdown) : empty,
    calmar: metric(
      annual !== null && maxDrawdown > 0 ? annual / maxDrawdown : null,
      n < annualizationDays ? annualMissing : "无回撤，Calmar不可计算",
    ),
    recoveryDays: n ? recovery : empty,
    longestUnderwaterDays: n ? metric(longestUnderwaterDays) : empty,
    maxDrawdownEpisode: worst,
  };
}

export function performancePeriods(
  initial: number,
  points: readonly PerformancePoint[],
  frequency: PerformanceFrequency,
  annualizationDays = defaultAnnualizationDays,
): PerformancePeriod[] {
  // Validate the full sequence once before splitting; periods cannot hide bad input.
  evaluatePerformance(initial, points, points[0]?.date, annualizationDays);
  const groups = new Map<
    string,
    { points: PerformancePoint[]; initial: number; initialDate: string }
  >();
  let previous = initial;
  let previousDate = points[0]?.date ?? "";
  for (const point of points) {
    const year = point.date.slice(0, 4);
    const key =
      frequency === "year"
        ? year
        : frequency === "month"
          ? point.date.slice(0, 7)
          : `${year}-Q${Math.ceil(Number(point.date.slice(5, 7)) / 3)}`;
    if (!groups.has(key))
      groups.set(key, {
        points: [],
        initial: previous,
        initialDate: previousDate,
      });
    groups.get(key)!.points.push(point);
    previous = point.value;
    previousDate = point.date;
  }
  return [...groups].map(([key, group], index) => ({
    key,
    year: Number(key.slice(0, 4)),
    boundary: index === 0 || index === groups.size - 1,
    evaluation: evaluatePerformance(
      group.initial,
      group.points,
      group.initialDate,
      annualizationDays,
    ),
  }));
}

function validTradeDate(date: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date
  );
}
export type TradeExcursionInput = Pick<
  TradeCycle,
  "id" | "symbol" | "openedAt" | "closedAt"
> & { entryAverage?: number | null; realizedNetReturn?: number | null } & {
  /** Independent market calendar, inclusive of entry and exit. Supply dates
   * in ascending order, including sessions with missing bars. */
  expectedHoldingSessions?: readonly string[] | null;
};

/** Date and full-session extrema on the same price basis as entryAverage. */
export type TradeExcursionBar = { date: string; high: number; low: number };
export type TradeExcursionBarsBySymbol = Readonly<
  Record<string, readonly TradeExcursionBar[] | undefined>
>;
export type TradeExcursion = Pick<
  TradeCycle,
  "id" | "symbol" | "openedAt" | "closedAt"
> & {
  entryAverage: number | null;
  entryAverageReason: string | null;
  realizedNetReturn: number | null;
  realizedNetReturnReason: string | null;
  /** Inclusive session count from the calendar, even when bars are missing. */
  days: number | null;
  daysReason: string | null;
  /** High / entryAverage − 1 and low / entryAverage − 1, in decimal units. */
  mfe: number | null;
  mae: number | null;
  reason: string | null;
};

function holdingDays(cycle: TradeExcursionInput): PerformanceMetric {
  const { openedAt, closedAt, expectedHoldingSessions: sessions } = cycle;
  if (
    !validTradeDate(openedAt) ||
    closedAt === null ||
    !validTradeDate(closedAt) ||
    closedAt < openedAt
  )
    return { value: null, reason: "交易轮次的开仓或平仓日期无效" };
  if (!sessions?.length) return { value: null, reason: "缺少持仓交易日历" };
  if (sessions[0] !== openedAt || sessions.at(-1) !== closedAt)
    return { value: null, reason: "持仓交易日历未覆盖交易轮次的起止日期" };
  let previous = "";
  for (const date of sessions) {
    if (!validTradeDate(date) || date <= previous)
      return {
        value: null,
        reason: `持仓交易日历日期无效或未严格递增：${date}`,
      };
    previous = date;
  }
  return { value: sessions.length, reason: null };
}

type BarIndex = ReadonlyMap<string, TradeExcursionBar | null>;

function measureExcursion(
  sessions: readonly string[],
  bars: BarIndex,
  entryAverage: number,
): Pick<TradeExcursion, "mfe" | "mae" | "reason"> {
  if (bars.size === 0) return { mfe: null, mae: null, reason: "缺少标的日线" };
  let highest = -Infinity;
  let lowest = Infinity;
  for (const date of sessions) {
    const bar = bars.get(date);
    if (bar === undefined)
      return { mfe: null, mae: null, reason: `缺少持仓日日线：${date}` };
    if (bar === null)
      return { mfe: null, mae: null, reason: `持仓日日线重复：${date}` };
    if (
      !Number.isFinite(bar.high) ||
      !Number.isFinite(bar.low) ||
      bar.low <= 0 ||
      bar.high < bar.low
    )
      return { mfe: null, mae: null, reason: `持仓日日线价格无效：${date}` };
    highest = Math.max(highest, bar.high);
    lowest = Math.min(lowest, bar.low);
  }
  const mfe = highest / entryAverage - 1;
  const mae = lowest / entryAverage - 1;
  if (!Number.isFinite(mfe) || !Number.isFinite(mae))
    return { mfe: null, mae: null, reason: "持仓日线波动计算结果非有限" };
  return { mfe: Math.max(0, mfe), mae: Math.min(0, mae), reason: null };
}

/** Evaluate long cycles in input order using their full-session price ranges.
 * Daily bars have no fill-time boundary, so entry/exit-day extrema can include
 * prices outside the actual exposure. Net return is supplied by the ledger.
 */
export function computeTradeExcursions(
  cycles: readonly TradeExcursionInput[],
  dailyBarsBySymbol: TradeExcursionBarsBySymbol,
): TradeExcursion[] {
  const indexes = new Map<string, BarIndex>();
  function barsFor(symbol: string): BarIndex {
    const cached = indexes.get(symbol);
    if (cached) return cached;
    const index = new Map<string, TradeExcursionBar | null>();
    if (Object.hasOwn(dailyBarsBySymbol, symbol)) {
      for (const bar of dailyBarsBySymbol[symbol] ?? []) {
        index.set(bar.date, index.has(bar.date) ? null : bar);
      }
    }
    indexes.set(symbol, index);
    return index;
  }

  return cycles
    .filter((cycle) => cycle.closedAt !== null)
    .map((cycle) => {
      const { id, symbol, openedAt, closedAt } = cycle;
      const calendar = holdingDays(cycle);
      let entryAverage = cycle.entryAverage ?? null;
      let entryAverageReason = null;
      if (entryAverage === null) entryAverageReason = "缺少可比入场均价";
      else if (!Number.isFinite(entryAverage) || entryAverage <= 0) {
        entryAverage = null;
        entryAverageReason = "入场均价必须为正有限数";
      }
      let realizedNetReturn = cycle.realizedNetReturn ?? null;
      let realizedNetReturnReason = null;
      if (realizedNetReturn === null) {
        realizedNetReturnReason = "缺少平仓净收益率";
      } else if (!Number.isFinite(realizedNetReturn)) {
        realizedNetReturn = null;
        realizedNetReturnReason = "平仓净收益率必须为有限数";
      }

      const excursion =
        calendar.value === null || entryAverage === null
          ? {
              mfe: null,
              mae: null,
              reason: calendar.reason ?? entryAverageReason,
            }
          : measureExcursion(
              cycle.expectedHoldingSessions!,
              barsFor(symbol),
              entryAverage,
            );
      return {
        id,
        symbol,
        openedAt,
        closedAt,
        entryAverage,
        entryAverageReason,
        realizedNetReturn,
        realizedNetReturnReason,
        days: calendar.value,
        daysReason: calendar.reason,
        ...excursion,
      };
    });
}
