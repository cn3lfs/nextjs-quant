import type { Bar } from "~/lib/domain";
import { boll, kdj, ma, macd, rsi, candlePatterns } from "~/lib/indicators";
import method from "~/lib/breakout-method.json";
import { vcpFacts } from "../canslim/vcp";

/** swing-trader Phase 3–4 / trading-system §1–4. All thresholds below are
 * deterministic local interpretations (docs/decisions.md), not learned rules.
 * Pure calculation: no clock, IO, external data, model, or order execution.
 */
export type Check = "是" | "否" | "未知";
export type Direction = "long" | "short";
export type Swing = {
  index: number;
  date: string;
  confirmedAt: string;
  kind: "high" | "low";
  price: number;
};
export type TrendLine = {
  direction: Direction;
  anchors: [Swing, Swing];
  slope: number;
  touches: number;
  confirmedAt: string;
  value: number;
};
export type Level = {
  price: number;
  source:
    | "swing-high"
    | "swing-low"
    | "platform-high"
    | "platform-low"
    | "volume-bull-close"
    | "volume-bear-close"
    | "ma20"
    | "ma60"
    | "round";
  index: number;
  confirmedAt: string;
};
export type BreakoutSide = {
  direction: Direction;
  status: Check;
  checks: {
    trend: Check;
    level: Check;
    volume: Check;
    indicators: Check;
    candle: Check;
  };
  score: number | null;
  quality: string;
  line: TrendLine | null;
  keyLevel: Level | null;
  indicatorVotes: Record<"MACD" | "KDJ" | "RSI" | "BOLL", Check>;
  patterns: string[];
  risk: {
    stop: Level | null;
    target1: Level | null;
    target2: Level | null;
    rewardMultiple: number | null;
    ratio: string;
  };
};
export type BreakoutPoint = {
  index: number;
  date: string;
  close: number;
  volume20: number | null;
  volumeRatio: number | null;
  swings: Swing[];
  ambiguousDates: string[];
  levels: Level[];
  long: BreakoutSide;
  short: BreakoutSide;
  missing: string[];
};
export type BreakoutResult = {
  version: string;
  method: typeof method;
  points: BreakoutPoint[];
  latest: BreakoutPoint | null;
};
const check = (v: boolean): Check => (v ? "是" : "否");
const body = (b: Bar) => Math.abs(b.close - b.open);
const average = (v: number[]) => v.reduce((s, x) => s + x, 0) / v.length;
const priceOn = (line: TrendLine, index: number) =>
  line.anchors[0].price + line.slope * (index - line.anchors[0].index);

// Connect the latest two same-kind pivots; do not cherry-pick older favorable
// pairs. Earlier body closes through the line invalidate it. Touch tolerance
// 0.5% is for reliability counts only, never for passing a breakout threshold.
function trend(
  points: Swing[],
  bars: readonly Bar[],
  index: number,
  direction: Direction,
): TrendLine | null {
  const pivots = points.filter(
    (p) => p.kind === (direction === "long" ? "high" : "low"),
  );
  const a = pivots.at(-2),
    b = pivots.at(-1);
  if (!a || !b) return null;
  const slope = (b.price - a.price) / (b.index - a.index);
  const sign = direction === "long" ? 1 : -1;
  if (slope * sign >= 0) return null;
  const line: TrendLine = {
    direction,
    anchors: [a, b],
    slope,
    touches: 2,
    confirmedAt: b.confirmedAt,
    value: 0,
  };
  line.value = priceOn(line, index);
  if (line.value <= 0) return null;
  for (let j = a.index + 1; j < index; j++) {
    if ((bars[j]!.close - priceOn(line, j)) * sign > 1e-10) return null;
  }
  line.touches = pivots.filter((p) => {
    if (Math.abs(p.price / priceOn(line, p.index) - 1) > 0.005) return false;
    // Older touches count only if their extension also has no intervening
    // body-close violation; a coincidental extrapolated price is not a touch.
    for (let j = p.index; j < a.index; j++)
      if ((bars[j]!.close - priceOn(line, j)) * sign > 1e-10) return false;
    return true;
  }).length;
  return line;
}

// Preserve the existing five-pattern diagnostic contract. Extended candle
// strategy patterns opt in through the same shared calculation.
export function breakoutPatterns(
  bars: readonly Bar[],
  i: number,
  direction: Direction,
): string[] {
  return candlePatterns(bars, i, direction);
}

function prepare(bars: readonly Bar[]) {
  // M1 owns every indicator formula. Full supplied history seeds recurrences.
  return {
    m: macd(bars),
    k: kdj(bars),
    r: rsi(bars),
    b: boll(bars),
    ma60: ma(bars, 60),
  };
}
function point(
  bars: readonly Bar[],
  i: number,
  values: ReturnType<typeof prepare>,
  chartBars = false,
): BreakoutPoint {
  const current = bars[i]!,
    previous = bars[i - 1];
  const start = Math.max(0, i - 60),
    prior = bars.slice(start, i);
  // Reuse diagnostic-2 as-is: its window is exactly the 60 completed bars
  // BEFORE the candidate. No second pivot detector and no confirmation backfill.
  const facts = vcpFacts(
    {
      id: "breakout",
      hash: "",
      createdAt: 0,
      symbol: "",
      source: "tdx-local",
      adjustment: "none",
      period: "day",
      bars: [...prior],
    },
    chartBars,
  );
  const ambiguousDates = facts.ambiguousDates ?? [];
  const barrier = ambiguousDates.at(-1);
  const swings: Swing[] = (facts.extrema ?? [])
    .filter((p) => !barrier || p.date > barrier)
    .map((p) => ({ ...p, index: p.index + start }));
  const missing: string[] = [];
  if (!facts.applicable) missing.push("突破日前不足60根日线");
  const invalid = bars
    .slice(0, i + 1)
    .some(
      (b, j) =>
        !(
          chartBars
            ? /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:00\+08:00)?$/
            : /^\d{4}-\d{2}-\d{2}$/
        ).test(b.date) ||
        !Number.isFinite(Date.parse(b.date)) ||
        (j > 0 && b.date <= bars[j - 1]!.date) ||
        ![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) ||
        b.low <= 0 ||
        b.high < Math.max(b.open, b.close) ||
        b.low > Math.min(b.open, b.close) ||
        b.volume < 0,
    );
  if (invalid) missing.push("日线价格/成交量/日期无效或未升序");
  const ready = facts.applicable && !invalid;
  // Previous 20 sessions exclude the breakout itself; zero-volume baselines
  // are unknown, rather than infinite relative volume.
  const volume20 =
    i >= 20 && !invalid ? average(prior.slice(-20).map((b) => b.volume)) : null;
  const volumeRatio =
    volume20 !== null && volume20 > 0 ? current.volume / volume20 : null;
  const levels: Level[] = ready
    ? swings.map((p) => ({
        price: p.price,
        source: p.kind === "high" ? "swing-high" : "swing-low",
        index: p.index,
        confirmedAt: p.confirmedAt,
      }))
    : [];
  const add = (
    price: number | null | undefined,
    source: Level["source"],
    index: number,
  ) => {
    if (price != null && price > 0 && Number.isFinite(price))
      levels.push({ price, source, index, confirmedAt: bars[index]!.date });
  };
  if (ready) {
    add(values.b[i - 1]?.mid, "ma20", i - 1);
    add(values.ma60[i - 1], "ma60", i - 1);
    // Integer ladder: 1 yuan below 10, 5 below 100, 10 below 1000,
    // 100 thereafter. Only adjacent historical-price rungs are candidates.
    const step =
      previous!.close < 10
        ? 1
        : previous!.close < 100
          ? 5
          : previous!.close < 1000
            ? 10
            : 100;
    const base = Math.floor(previous!.close / step) * step;
    for (const price of [base, base + step]) add(price, "round", i - 1);
    for (let j = start + 20; j < i; j++) {
      if (barrier && bars[j]!.date <= barrier) continue;
      const b = bars[j]!,
        v = average(bars.slice(j - 20, j).map((b) => b.volume));
      if (
        v > 0 &&
        b.volume >= v * 1.5 &&
        body(b) / b.open >= 0.03 &&
        body(b) >= (b.high - b.low) * 0.6
      )
        add(
          b.close,
          b.close > b.open ? "volume-bull-close" : "volume-bear-close",
          j,
        );
      // A full 10-bar platform, <=5% range, <=80% previous-20 volume,
      // and >=2 distinct touches of BOTH edges (within 0.5%).
      if (j < start + 29) continue;
      const window = bars.slice(j - 9, j + 1);
      if (barrier && window[0]!.date <= barrier) continue;
      const high = Math.max(...window.map((b) => b.high)),
        low = Math.min(...window.map((b) => b.low));
      const baseVolume = average(
        bars.slice(j - 29, j - 9).map((b) => b.volume),
      );
      if (
        high / low - 1 <= 0.05 &&
        baseVolume > 0 &&
        average(window.map((b) => b.volume)) <= baseVolume * 0.8 &&
        window.filter((b) => b.high >= high * 0.995).length >= 2 &&
        window.filter((b) => b.low <= low * 1.005).length >= 2
      ) {
        add(high, "platform-high", j);
        add(low, "platform-low", j);
      }
    }
  }
  const m = values.m[i]!,
    k = values.k[i]!,
    r = values.r[i]!,
    b = values.b[i]!;
  const side = (direction: Direction): BreakoutSide => {
    const sign = direction === "long" ? 1 : -1;
    const line = ready ? trend(swings, bars, i, direction) : null;
    const candidates = levels
      .filter((l) => (l.price - previous!.close) * sign >= 0)
      .sort((a, b) => (a.price - b.price) * sign || b.index - a.index);
    const keyLevel = candidates[0] ?? null;
    const vote = (a: number | null, b: number | null) =>
      !ready || a === null || b === null
        ? ("未知" as const)
        : check((a - b) * sign > 0);
    const indicatorVotes = {
      MACD: vote(m.dif, m.dea),
      KDJ: k.rsv === null ? ("未知" as const) : vote(k.k, k.d),
      RSI: vote(r.rsi6, 50),
      BOLL: vote(current.close, b.mid),
    };
    const indicators = Object.values(indicatorVotes);
    const patterns = ready ? breakoutPatterns(bars, i, direction) : [];
    const checks: BreakoutSide["checks"] = {
      trend: line
        ? check(
            (current.close - current.open) * sign > 0 &&
              (current.close - line.value) * sign > 1e-10 &&
              (previous!.close - priceOn(line, i - 1)) * sign <= 1e-10,
          )
        : "未知",
      level:
        ready && keyLevel
          ? check((current.close - keyLevel.price) * sign > 1e-10)
          : "未知",
      volume:
        ready && volumeRatio !== null ? check(volumeRatio >= 1.5) : "未知",
      indicators:
        !ready || indicators.includes("未知")
          ? "未知"
          : check(indicators.filter((v) => v === "是").length >= 2),
      candle: ready ? check(patterns.length > 0) : "未知",
    };
    const items = Object.values(checks);
    const score = items.includes("未知")
      ? null
      : items.filter((v) => v === "是").length;
    // Missing any required evidence cannot produce a confirmed signal, even
    // if other known checks pass. A failed known core check is not a fake trade.
    const status: Check = items.includes("未知")
      ? "未知"
      : check(
          checks.trend === "是" &&
            checks.level === "是" &&
            checks.volume === "是",
        );
    const stop =
      levels
        .filter(
          (l) =>
            [
              direction === "long" ? "swing-low" : "swing-high",
              direction === "long" ? "platform-low" : "platform-high",
            ].includes(l.source) && (current.close - l.price) * sign > 0,
        )
        .sort((a, b) => b.index - a.index)[0] ?? null;
    const targets = levels
      .filter((l) => (l.price - current.close) * sign > 0)
      .sort((a, b) => (a.price - b.price) * sign)
      .filter(
        (l, j, all) => j === 0 || Math.abs(l.price - all[j - 1]!.price) > 1e-8,
      );
    const target1 = targets[0] ?? null,
      target2 = targets[1] ?? null;
    const rewardMultiple =
      stop && target2
        ? Math.abs(target2.price - current.close) /
          Math.abs(current.close - stop.price)
        : null;
    return {
      direction,
      status,
      checks,
      score,
      quality: score === null ? "未知" : `${score}/5`,
      line,
      keyLevel,
      indicatorVotes,
      patterns,
      risk: {
        stop,
        target1,
        target2,
        rewardMultiple,
        ratio:
          rewardMultiple === null ? "未知" : `1:${rewardMultiple.toFixed(2)}`,
      },
    };
  };
  return {
    index: i,
    date: current.date,
    close: current.close,
    volume20,
    volumeRatio,
    swings,
    ambiguousDates,
    levels,
    long: side("long"),
    short: side("short"),
    missing,
  };
}

/** Evaluate only the last bar by default (monitor/batch). Chart asks for history.
 * `from` affects output only, never the indicator seed or a point's as-of inputs.
 */
export function analyzeBreakout(
  bars: readonly Bar[],
  from = Math.max(0, bars.length - 1),
  chartBars = false,
): BreakoutResult {
  const values = prepare(bars);
  const points = bars
    .slice(Math.max(0, from))
    .map((_, n) => point(bars, Math.max(0, from) + n, values, chartBars));
  return {
    version: method.ruleVersion,
    method,
    points,
    latest: points.at(-1) ?? null,
  };
}
