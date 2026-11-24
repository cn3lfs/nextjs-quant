import {
  adjacentSessions,
  isWeekday,
  readTemperatureSessions,
  shiftDate,
  withMarketReadContext,
  type MarketIndicatorQuery,
  type TemperatureSession,
} from "./market-temperature-inputs";

export const temperaturePolicy = {
  version: "market-temperature-1",
  window: 252,
  minimumSamples: 120,
  minimumWeight: 70,
  weights: { breadth: 25, trend: 25, limits: 20, turnover: 20, etf: 10 },
  percentile:
    "100 × (小于当前值的样本数 + (同值样本数−1)/2) / (有效样本数−1)；含当日在内最近252个观测交易日，至少120个有效值。",
  composite:
    "Σ(分位分 × 原权重) / 有效原权重之和；有效原权重不足70或交易日尚未收盘时断线。",
  regime:
    "≤35 防守，≥65 进攻；开区间内连续两个有效收盘日回归中性。缺数或未经证实的工作日中断确认，缺数当日不显示状态。",
  dimensions: {
    breadth:
      "冻结面板 A 股当日原始收盘高于上一笔成交收盘的家数 / 有成交且两价有效的家数，含平盘。原价可能受除权影响。",
    trend:
      "冻结面板 A 股当日因果复权收盘>SMA20>SMA60 家数 / 有连续60个交易日有效复权收盘的家数。",
    limits:
      "gpsh999999.dat，SC24 第一列涨停家数与 SC30 第一列最高连板（均剔除 ST 与未开板新股）；同日成对有效，各取历史分位后等权。",
    turnover:
      "冻结面板 A 股有成交日线 amount 合计（元），不含基金、指数；已成交但金额缺失则当日未知。范围为面板实际覆盖证券。",
    etf: "国家队指标 state_history.csv 的合计_f1_yi（12只宽基 ETF，亿元），最近5个观测交易日逐日齐全才求和。",
  },
} as const;
export type TemperatureRegime = "defensive" | "neutral" | "offensive";
type Component =
  | "breadth"
  | "trend"
  | "limitUp"
  | "highestStreak"
  | "turnoverCny"
  | "etfNet5Yi";

function rank(window: TemperatureSession[], key: Component) {
  const latest = window.at(-1)!;
  const eligible = (session: TemperatureSession) =>
    session.complete &&
    Number.isFinite(session[key]) &&
    (!(key === "limitUp" || key === "highestStreak") ||
      (Number.isFinite(session.limitUp) &&
        Number.isFinite(session.highestStreak)));
  const raw =
    latest.complete && Number.isFinite(latest[key]) ? latest[key] : null;
  let samples = 0,
    less = 0,
    equal = 0;
  for (const row of window) {
    if (!eligible(row)) continue;
    samples++;
    if (raw !== null) {
      if (row[key]! < raw) less++;
      else if (row[key] === raw) equal++;
    }
  }
  return {
    raw,
    samples,
    score:
      eligible(latest) && samples >= temperaturePolicy.minimumSamples
        ? (100 * (less + (equal - 1) / 2)) / (samples - 1)
        : null,
  };
}

export function scoreTemperature(sessions: TemperatureSession[]) {
  let regime: TemperatureRegime | null = null;
  let middle = 0;
  return sessions.map((day, i) => {
    if (i > 0 && sessions[i - 1]!.date >= day.date)
      throw new Error("温度交易日重复或倒序");
    const gapBefore =
      i > 0 && !adjacentSessions(sessions[i - 1]!.date, day.date);
    if (gapBefore) middle = 0;
    const window = sessions.slice(
      Math.max(0, i + 1 - temperaturePolicy.window),
      i + 1,
    );
    const count = rank(window, "limitUp"),
      height = rank(window, "highestStreak");
    const dimensions = {
      breadth: rank(window, "breadth"),
      trend: rank(window, "trend"),
      limits: {
        count,
        height,
        score:
          count.score !== null && height.score !== null
            ? (count.score + height.score) / 2
            : null,
      },
      turnover: rank(window, "turnoverCny"),
      etf: rank(window, "etfNet5Yi"),
    };
    let coverageWeight = 0,
      weighted = 0;
    for (const key of Object.keys(dimensions) as (keyof typeof dimensions)[]) {
      const score = dimensions[key].score;
      if (score === null) continue;
      const weight = temperaturePolicy.weights[key];
      weighted += weight * score;
      coverageWeight += weight;
    }
    const score =
      day.complete && coverageWeight >= temperaturePolicy.minimumWeight
        ? weighted / coverageWeight
        : null;
    if (score === null) middle = 0;
    else if (score <= 35 || score >= 65) {
      regime = score <= 35 ? "defensive" : "offensive";
      middle = 0;
    } else {
      middle = Math.min(2, middle + 1);
      if (middle === 2) regime = "neutral";
    }
    return {
      date: day.date,
      complete: day.complete,
      gapBefore,
      score,
      regime: score === null ? null : (regime as TemperatureRegime | null),
      middleStreak: middle,
      coverageWeight,
      dimensions,
      sample: {
        advancing: day.breadthSample ? day.advancing : null,
        breadth: day.breadthSample,
        aboveTrend: day.trendSample ? day.aboveTrend : null,
        trend: day.trendSample,
        turnover: day.turnoverSample,
      },
    };
  });
}

export async function marketTemperature(query: MarketIndicatorQuery = {}) {
  return withMarketReadContext(query, async (ctx) => {
    const { sessions, sentimentSha256, etfSha256 } =
      await readTemperatureSessions(ctx);
    const history = scoreTemperature(sessions).slice(-252);
    const last = history.at(-1);
    let expected = ctx.asOf;
    while (!isWeekday(expected)) expected = shiftDate(expected, -1);
    return {
      asOf: ctx.asOf,
      advisoryOnly: true as const,
      history,
      latest: last?.date === expected ? last : null,
      policy: temperaturePolicy,
      provenance: {
        root: ctx.root,
        snapshotId: ctx.panel?.snapshotId ?? null,
        calendar: ctx.calendarSource,
        sentimentSha256,
        etfSha256,
        panelStockCount:
          ctx.panel?.manifest.symbols.filter((s) => s.kind === "stock")
            .length ?? null,
        lastObservedSession: last?.date ?? null,
        warnings: ctx.warnings,
      },
    };
  });
}
export type MarketTemperaturePoint = ReturnType<
  typeof scoreTemperature
>[number];
export type MarketTemperatureResult = Awaited<
  ReturnType<typeof marketTemperature>
>;
