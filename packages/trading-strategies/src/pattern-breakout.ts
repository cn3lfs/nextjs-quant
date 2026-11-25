import type { Bar } from "trading-strategy-core/bars";
import {
  confirmedExtrema,
  type ConfirmedExtremum,
} from "trading-strategy-core/indicators";

export const patternBreakoutKinds = [
  "head-shoulders-bottom",
  "head-shoulders-top",
  "box",
  "triangle",
  "wedge",
] as const;
export type PatternBreakoutKind = (typeof patternBreakoutKinds)[number];
type Direction = "long" | "short";
type SubKind =
  | "头肩底"
  | "头肩顶"
  | "水平箱体"
  | "对称三角形"
  | "上升三角形"
  | "下降三角形"
  | "下降楔形"
  | "上升楔形";
type GeometryPoint = { index: number; date: string; price: number };
type GeometryLine = {
  kind: "neckline" | "outline" | "upper" | "lower";
  label: string;
  style: "solid" | "dashed";
  points: GeometryPoint[];
};
export type PatternBreakoutMatch = {
  kind: PatternBreakoutKind;
  subKind: SubKind;
  label: string;
  direction: Direction;
  index: number;
  date: string;
  close: number;
  pivotPrice: number;
  stopPrice: number;
  targetPrice: number;
  rewardMultiple: number | null;
  volumeRatio: number | null;
  durationBars: number;
  depthPercent: number;
  score: number;
  summary: string;
  geometry: { lines: GeometryLine[] };
};
/** Confirmed pattern matches, newest scan last, as returned by the chart query. */
export type PatternBreakoutResult = readonly PatternBreakoutMatch[];
export type PatternBreakoutOptions = {
  from?: number;
  kinds?: readonly PatternBreakoutKind[];
  direction?: Direction | "both";
  minVolumeRatio?: number;
  minScore?: number;
  dedupPerBar?: boolean;
  cooldownBars?: number;
};

type Rail = {
  a: ConfirmedExtremum;
  b: ConfirmedExtremum;
  at: (index: number) => number;
  slope: number;
};
function through(a: ConfirmedExtremum, b: ConfirmedExtremum): Rail {
  const slope = (b.price - a.price) / (b.index - a.index);
  return { a, b, slope, at: (index) => a.price + (index - a.index) * slope };
}

type Setup = Pick<
  PatternBreakoutMatch,
  | "kind"
  | "subKind"
  | "pivotPrice"
  | "stopPrice"
  | "targetPrice"
  | "durationBars"
  | "depthPercent"
  | "geometry"
>;
type Context = {
  bars: readonly Bar[];
  i: number;
  long: boolean;
  pivots: ConfirmedExtremum[];
};
function line(
  ctx: Context,
  label: string,
  kind: GeometryLine["kind"],
  start: number,
  price: (i: number) => number,
): GeometryLine {
  return {
    label,
    kind,
    style: "dashed",
    points: [start, ctx.i].map((index) => ({
      index,
      date: ctx.bars[index]!.date,
      price: price(index),
    })),
  };
}

function shoulders(ctx: Context): Setup | null {
  const { bars, i, long, pivots } = ctx;
  const alternating: ConfirmedExtremum[] = [];
  for (const pivot of pivots) {
    const last = alternating.at(-1);
    if (last?.kind !== pivot.kind) alternating.push(pivot);
    else if (
      pivot.kind === "high"
        ? pivot.price > last.price
        : pivot.price < last.price
    )
      alternating[alternating.length - 1] = pivot;
  }
  const [left, a, head, b, right] = alternating.slice(-5);
  const outer = long ? "low" : "high";
  if (
    !left ||
    !a ||
    !head ||
    !b ||
    !right ||
    left.kind !== outer ||
    a.kind === outer ||
    head.kind !== outer ||
    b.kind === outer ||
    right.kind !== outer
  )
    return null;
  const span = right.index - left.index;
  if (span < 12 || span > 120) return null;
  const headDistinct = long
    ? head.price < 0.985 * Math.min(left.price, right.price)
    : head.price > 1.015 * Math.max(left.price, right.price);
  if (
    !headDistinct ||
    Math.abs(left.price - right.price) / Math.max(a.price, b.price) > 0.12
  )
    return null;
  const neck = through(a, b);
  const sign = long ? 1 : -1;
  if (
    Math.abs(neck.slope) > a.price * 0.01 ||
    sign * (bars[i]!.close - neck.at(i)) <= 0
  )
    return null;
  for (let j = right.index; j < i; j++) {
    const bar = bars[j]!;
    if (!validBar(bar) || bar.date >= bars[j + 1]!.date) return null;
    if (
      (bar.close - neck.at(j)) * sign > 0 ||
      (long ? bar.low < right.price : bar.high > right.price)
    )
      return null;
  }
  const height = (neck.at(head.index) - head.price) * sign;
  if (height <= 0 || sign * (bars[i]!.close - right.price) <= 0) return null;
  return {
    kind: long ? "head-shoulders-bottom" : "head-shoulders-top",
    subKind: long ? "头肩底" : "头肩顶",
    pivotPrice: neck.at(i),
    stopPrice: right.price,
    targetPrice: neck.at(i) + sign * height,
    durationBars: i - left.index,
    depthPercent: (100 * height) / neck.at(head.index),
    geometry: {
      lines: [
        line(ctx, "颈线", "neckline", a.index, neck.at),
        {
          kind: "outline",
          style: "solid",
          label: "双肩与头部",
          points: [left, a, head, b, right].map(({ index, date, price }) => ({
            index,
            date,
            price,
          })),
        },
      ],
    },
  };
}

function channelSetup(
  ctx: Context,
  kind: "box" | "triangle" | "wedge",
  subKind: SubKind,
  start: number,
  upper: Pick<Rail, "a" | "at">,
  lower: Pick<Rail, "a" | "at">,
  stopPrice: number,
): Setup {
  const { i, long } = ctx;
  const width = upper.at(start) - lower.at(start);
  const pivotPrice = long ? upper.at(i) : lower.at(i);
  return {
    kind,
    subKind,
    durationBars: i - start,
    depthPercent: (100 * width) / lower.at(start),
    pivotPrice,
    stopPrice,
    targetPrice: pivotPrice + (long ? width : -width),
    geometry: {
      lines: [
        line(ctx, "上轨", "upper", upper.a.index, upper.at),
        line(ctx, "下轨", "lower", lower.a.index, lower.at),
      ],
    },
  };
}

function box(ctx: Context): Setup | null {
  const { i, bars, long, pivots } = ctx;
  let best: Setup | null = null;
  let bestTouches = 0;
  for (const duration of [60, 45, 30, 20, 15]) {
    const windowStart = Math.max(0, i - duration);
    const touches = pivots.filter((p) => p.index >= windowStart && p.index < i);
    const highs = touches.filter((p) => p.kind === "high");
    const lows = touches.filter((p) => p.kind === "low");
    if (highs.length < 2 || lows.length < 2) continue;
    const start = Math.min(...touches.map((p) => p.index));
    if (i - start < 15) continue;
    const window = bars.slice(start, i);
    const topAnchor = highs.reduce((a, b) => (b.price > a.price ? b : a));
    const bottomAnchor = lows.reduce((a, b) => (b.price < a.price ? b : a));
    const top = topAnchor.price;
    const bottom = bottomAnchor.price;
    const tol = 0.005;
    if (
      window.some(
        (b) => b.close < bottom * (1 - tol) || b.close > top * (1 + tol),
      )
    )
      continue;
    const width = top - bottom;
    if (
      width / bottom < 0.04 ||
      width / bottom > 0.18 ||
      (long ? bars[i]!.close <= top : bars[i]!.close >= bottom)
    )
      continue;
    // Distinct same-kind strict extrema are separated by at least four bars.
    const topCount = touches.filter(
      (p) => p.kind === "high" && p.price >= top - width * 0.2,
    ).length;
    const bottomCount = touches.filter(
      (p) => p.kind === "low" && p.price <= bottom + width * 0.2,
    ).length;
    const balanced = Math.min(topCount, bottomCount);
    if (balanced < 2 || balanced <= bestTouches) continue;
    bestTouches = balanced;
    best = channelSetup(
      ctx,
      "box",
      "水平箱体",
      start,
      { a: topAnchor, at: () => top },
      { a: bottomAnchor, at: () => bottom },
      long ? bottom : top,
    );
  }
  return best;
}

function enclosingRails(ctx: Context, start: number, side: "high" | "low") {
  const points = ctx.pivots.filter((p) => p.index >= start && p.kind === side);
  const upper = side === "high";
  const breakSide = upper === ctx.long;
  const sign = upper ? 1 : -1;
  const rails: Rail[] = [];
  // Wider anchor pairs have priority when several rails enclose the same closes.
  for (let gap = points.length - 1; gap > 0; gap--) {
    for (let n = 0; n + gap < points.length; n++) {
      const a = points[n]!,
        b = points[n + gap]!;
      if (b.index - a.index < 6) continue;
      const rail = through(a, b);
      if (breakSide && sign * (ctx.bars[ctx.i]!.close - rail.at(ctx.i)) <= 0)
        continue;
      let inside = true;
      for (let j = a.index; j < ctx.i; j++) {
        if (sign * (ctx.bars[j]!.close - rail.at(j)) > 0) {
          inside = false;
          break;
        }
      }
      if (inside) rails.push(rail);
    }
  }
  return rails;
}

function converging(ctx: Context, kinds: Set<PatternBreakoutKind>): Setup[] {
  const { i, bars, long } = ctx;
  const matches = new Map<PatternBreakoutKind, Setup>();
  const start = Math.max(0, i - 65);
  const highs = enclosingRails(ctx, start, "high");
  if (!highs.length) return [];
  const lows = enclosingRails(ctx, start, "low");
  for (const upper of highs)
    for (const lower of lows) {
      const anchorStart = Math.min(upper.a.index, lower.a.index);
      const span = i - anchorStart;
      const minAnchorGap = Math.max(6, Math.floor(span * 0.35));
      if (
        span < 15 ||
        upper.b.index - upper.a.index < minAnchorGap ||
        lower.b.index - lower.a.index < minAnchorGap
      )
        continue;
      const upperStart = upper.at(anchorStart),
        lowerStart = lower.at(anchorStart);
      const startWidth = upperStart - lowerStart;
      const endWidth = upper.at(i) - lower.at(i);
      if (
        endWidth <= 0 ||
        endWidth > 0.72 * startWidth ||
        lowerStart <= 0 ||
        startWidth / lowerStart < 0.04 ||
        lower.at(i) <= 0
      )
        continue;
      const window = bars.slice(anchorStart, i);
      const maxWindowHigh = Math.max(...window.map((bar) => bar.high));
      const minWindowLow = Math.min(...window.map((bar) => bar.low));
      if (upperStart > maxWindowHigh * 1.03 || lowerStart < minWindowLow * 0.97)
        continue;
      // Each rail already contains closes from its own first anchor through
      // the prior bar. Check its extension back to the other rail's anchor.
      const later = upper.a.index > lower.a.index ? upper : lower;
      const sign = later === upper ? 1 : -1;
      if (
        bars
          .slice(anchorStart, later.a.index)
          .some((bar, n) => (bar.close - later.at(anchorStart + n)) * sign > 0)
      )
        continue;
      const avg = window.reduce((sum, bar) => sum + bar.close, 0) / span;
      const u = upper.slope / avg,
        l = lower.slope / avg;
      // The near-horizontal triangle bands overlap the shallow-wedge bands.
      // Each requested family is assessed independently.
      const triangle =
        u < -0.0002 && l > 0.0002
          ? "对称三角形"
          : Math.abs(u) <= 0.0006 && l > 0.0003
            ? "上升三角形"
            : Math.abs(l) <= 0.0006 && u < -0.0003
              ? "下降三角形"
              : null;
      if (triangle && kinds.has("triangle") && !matches.has("triangle"))
        matches.set(
          "triangle",
          channelSetup(
            ctx,
            "triangle",
            triangle,
            anchorStart,
            upper,
            lower,
            long ? lower.at(i) : upper.at(i),
          ),
        );
      const wedge = long ? u < l && l < -0.0002 : l > u && u > 0.0002;
      if (wedge && kinds.has("wedge") && !matches.has("wedge")) {
        const stop = long
          ? Math.min(lower.at(i), minWindowLow)
          : Math.max(upper.at(i), maxWindowHigh);
        matches.set(
          "wedge",
          channelSetup(
            ctx,
            "wedge",
            long ? "下降楔形" : "上升楔形",
            anchorStart,
            upper,
            lower,
            stop,
          ),
        );
      }
      if (
        (!kinds.has("triangle") || matches.has("triangle")) &&
        (!kinds.has("wedge") || matches.has("wedge"))
      )
        return [...matches.values()];
    }
  return [...matches.values()];
}

function validBar(bar: Bar) {
  return (
    [bar.low, bar.high, bar.open, bar.close, bar.volume].every(
      Number.isFinite,
    ) &&
    bar.low > 0 &&
    bar.low <= Math.min(bar.open, bar.close) &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.volume >= 0
  );
}

// Append only newly confirmed centers. Looking up an older index after a newer
// one uses the event time cutoff, including for ambiguous outside bars.
function preparePivots(bars: readonly Bar[]) {
  const events: { index: number; pivot: ConfirmedExtremum | null }[] = [];
  let scanned = 0;
  return (i: number) => {
    if (i > scanned) {
      const offset = Math.max(0, scanned - 6);
      const facts = confirmedExtrema(bars.slice(offset, i));
      const batch = [
        ...facts.extrema.map((p) => ({
          index: offset + p.index,
          pivot: { ...p, index: offset + p.index },
        })),
        ...facts.ambiguousIndices.map((index) => ({
          index: offset + index,
          pivot: null,
        })),
      ].sort((a, b) => a.index - b.index);
      for (const event of batch) events.push(event);
      scanned = i;
    }
    let low = 0,
      high = events.length;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (events[mid]!.index + 3 < i) low = mid + 1;
      else high = mid;
    }
    const result: ConfirmedExtremum[] = [];
    // The allowed shoulder span ends at the right shoulder, which can be
    // confirmed well before the neckline breaks.
    const first = (events[low - 1]?.index ?? i) - 120;
    for (let j = low - 1; j >= 0; j--) {
      const event = events[j]!;
      if (event.index < first || !event.pivot) break;
      result.push(event.pivot);
    }
    return result.reverse();
  };
}

export function preparePatternBreakout(
  bars: readonly Bar[],
  options: PatternBreakoutOptions = {},
) {
  const kinds = new Set(options.kinds ?? patternBreakoutKinds);
  const pivotsAt = preparePivots(bars);
  return {
    at(i: number): PatternBreakoutMatch[] {
      if (!Number.isInteger(i) || i < 0 || i >= bars.length)
        throw new RangeError("Invalid pattern breakout index");
      const bar = bars[i]!;
      if (
        i < 15 ||
        i < (options.from ?? 0) ||
        bar.open === bar.close ||
        !validBar(bar)
      )
        return [];
      const long = bar.close > bar.open;
      const direction = long ? "long" : "short";
      if (
        options.direction &&
        options.direction !== "both" &&
        options.direction !== direction
      )
        return [];
      // Include the three left peers of the earliest possible anchor.
      const offset = Math.max(0, i - 123);
      const prior = bars.slice(offset, i);
      if (
        prior.some(
          (b, j) => !validBar(b) || b.date >= bars[offset + j + 1]!.date,
        )
      )
        return [];
      const volume20 =
        i >= 20
          ? prior.slice(-20).reduce((sum, b) => sum + b.volume, 0) / 20
          : 0;
      const volumeRatio = volume20 > 0 ? bar.volume / volume20 : null;
      if (
        (options.minVolumeRatio ?? 0) > 0 &&
        (volumeRatio === null || volumeRatio < options.minVolumeRatio!)
      )
        return [];
      const ctx = { bars, i, long, pivots: pivotsAt(i) };
      const setups: (Setup | null)[] = [];
      if (kinds.has(long ? "head-shoulders-bottom" : "head-shoulders-top"))
        setups.push(shoulders(ctx));
      if (kinds.has("box")) setups.push(box(ctx));
      if (kinds.has("triangle") || kinds.has("wedge"))
        setups.push(...converging(ctx, kinds));
      const matches: PatternBreakoutMatch[] = [];
      for (const setup of setups) {
        if (!setup) continue;
        const risk = (long ? 1 : -1) * (bar.close - setup.stopPrice);
        const reward = (long ? 1 : -1) * (setup.targetPrice - bar.close);
        const rewardMultiple = reward / risk;
        const positive = (price: number) => Number.isFinite(price) && price > 0;
        if (
          ![
            setup.pivotPrice,
            setup.stopPrice,
            setup.targetPrice,
            risk,
            reward,
            rewardMultiple,
          ].every(positive) ||
          setup.geometry.lines.some((rail) =>
            rail.points.some((p) => !positive(p.price)),
          )
        )
          continue;
        // One structural point; duration, relative volume and remaining reward add evidence.
        const score =
          1 +
          Number(setup.durationBars >= 20) +
          Number((volumeRatio ?? 0) >= 1.2) +
          Number((volumeRatio ?? 0) >= 1.5) +
          Number((rewardMultiple ?? 0) >= 1);
        if (score < (options.minScore ?? 1)) continue;
        const label =
          setup.kind === "box"
            ? long
              ? "箱体突破↑"
              : "箱体破位↓"
            : setup.kind.startsWith("head-shoulders")
              ? setup.subKind + (long ? "突破↑" : "破位↓")
              : setup.subKind + (long ? "↑" : "↓");
        matches.push({
          ...setup,
          label,
          index: i,
          date: bar.date,
          close: bar.close,
          direction,
          rewardMultiple,
          volumeRatio,
          score,
          summary: `${label}，收盘 ${bar.close}，突破位 ${setup.pivotPrice.toFixed(2)}，失效位 ${setup.stopPrice.toFixed(2)}，量度目标 ${setup.targetPrice.toFixed(2)}`,
        });
      }
      matches.sort(
        (a, b) => b.score - a.score || b.durationBars - a.durationBars,
      );
      return options.dedupPerBar ? matches.slice(0, 1) : matches;
    },
  };
}

export function analyzePatternBreakouts(
  bars: readonly Bar[],
  options: PatternBreakoutOptions = {},
): PatternBreakoutMatch[] {
  const prepared = preparePatternBreakout(bars, options);
  const matches: PatternBreakoutMatch[] = [];
  const cooldown = options.cooldownBars ?? 0;
  const lastAccepted = { long: -Infinity, short: -Infinity };
  for (
    let i = Math.max(0, Math.ceil(options.from ?? 0));
    i < bars.length;
    i++
  ) {
    const candidates = prepared.at(i);
    const match = candidates[0];
    if (!match || i - lastAccepted[match.direction] <= cooldown) continue;
    matches.push(...candidates);
    lastAccepted[match.direction] = i;
  }
  return matches;
}
