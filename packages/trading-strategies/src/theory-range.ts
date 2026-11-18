import type { Bar } from "trading-strategy-core/bars";
import { atr, confirmedExtrema } from "trading-strategy-core/indicators";

/** Fixed local proxies: these rules do not certify Wyckoff phases or author systems. */
export const theoryRangeDefinitions = [
  {
    id: "theory-range-reversion",
    theoryId: "F12.01",
    name: "冻结区间拒绝回归·日线代理",
    family: "反转",
    rule: "60根内最近各两次3/3高低点交错、组内差≤均值2%，冻结20根区间；支撑拒绝后5根内收盘越拒绝高且低于区间顶入场。",
  },
  {
    id: "theory-sos-pullback",
    theoryId: "F08.09",
    name: "突破后缩量回撤·日线代理",
    family: "回调",
    rule: "冻结区间突破量比>1.5、幅比>1.2、收盘位置>.75；首个3/3回撤低点不破区间顶且量幅较推进段收缩，确认后5根内越冻结反弹高入场；不是完整LPS或吸筹认定。",
  },
] as const;
export type TheoryRangeId = (typeof theoryRangeDefinitions)[number]["id"];
export const theoryRangeIds = theoryRangeDefinitions.map((row) => row.id);
export const theoryRangeExitRule =
  "只做多不加仓，保护仅收盘确认、下一合法机会成交。区间回归保护为min(拒绝低,区间低)-形成ATR14×.25，中点或持20根退出；SOS回撤收盘破冻结低点或持40根退出。";

type Position = {
  entry: number;
  entryIndex: number;
  signalIndex?: number;
  lastExitIndex?: number;
};
export type FrozenTheoryRange = {
  lower: number;
  upper: number;
  buffer: number;
  formedAt: number;
  expiresAt: number;
};
export type TheoryComponentResult = {
  status: "wait" | "unknown" | "invalid" | "signal";
  level?: number;
  confirmedAt?: number;
};
type Entry = { stop: number; target?: number };

function validBar(bar: Bar | undefined): bar is Bar {
  return (
    !!bar &&
    [bar.open, bar.high, bar.low, bar.close].every(
      (v) => Number.isFinite(v) && v > 0,
    ) &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close)
  );
}

function context(bars: readonly Bar[]) {
  const valid = bars.map(validBar);
  const pivots = confirmedExtrema(bars).extrema.filter((pivot) =>
    valid.slice(pivot.index - 3, pivot.index + 4).every(Boolean),
  );
  return { valid, pivots, ranges: atr(bars, 14) };
}

/** F02.04 component only. Frozen tolerance is measured when the pivot confirms. */
export function createTheorySupportRejection(bars: readonly Bar[]) {
  const { valid, pivots, ranges } = context(bars);
  const result: TheoryComponentResult[] = [];
  let support: { price: number; delta: number; confirmed: number } | null =
    null;
  let after = -1;
  for (let i = 0; i < bars.length; i++) {
    if (!valid[i]) {
      support = null;
      after = i;
      result.push({ status: "unknown" });
      continue;
    }
    if (support && i > support.confirmed + 20) {
      support = null;
      after = i - 1;
    }
    if (!support) {
      const pivot = pivots.find(
        (p) => p.kind === "low" && p.index > after && p.index + 3 === i,
      );
      const range = ranges[i];
      if (pivot && range != null && range > 0)
        support = { price: pivot.price, delta: range * 0.25, confirmed: i };
    }
    if (!support) {
      result.push({ status: "wait" });
      continue;
    }
    const b = bars[i]!;
    const base = { level: support.price, confirmedAt: support.confirmed };
    if (b.close < support.price - support.delta) {
      result.push({ status: "invalid", ...base });
      support = null;
      after = i;
    } else {
      result.push({
        status:
          i > support.confirmed &&
          b.low >= support.price - support.delta &&
          b.low <= support.price + support.delta &&
          b.close > support.price + support.delta
            ? "signal"
            : "wait",
        ...base,
      });
    }
  }
  return (index: number): TheoryComponentResult =>
    result[index] ?? { status: "unknown" };
}

/** Snapshot is the range known before this bar's close invalidates it.
 * This lets a breakout consume the prior range without rebuilding it around the breakout. */
export function theoryFrozenRanges(
  bars: readonly Bar[],
): (FrozenTheoryRange | null)[] {
  const { valid, pivots, ranges } = context(bars);
  const result: (FrozenTheoryRange | null)[] = bars.map(() => null);
  let active: FrozenTheoryRange | null = null;
  let after = -1;
  for (let i = 0; i < bars.length; i++) {
    if (!valid[i]) {
      active = null;
      after = i;
      continue;
    }
    if (active && i > active.expiresAt) {
      active = null;
      after = i - 1;
    }
    // Do not replay old pivots after invalidation or expiry.
    if (!active && i >= 59 && ranges[i] != null && ranges[i]! > 0) {
      const known = pivots.filter(
        (p) => p.index > after && p.index >= i - 59 && p.index + 3 <= i,
      );
      const lows = known.filter((p) => p.kind === "low").slice(-2);
      const highs = known.filter((p) => p.kind === "high").slice(-2);
      const four = [...lows, ...highs].sort((a, b) => a.index - b.index);
      if (
        lows.length === 2 &&
        highs.length === 2 &&
        four.every((p, n) => n === 0 || p.kind !== four[n - 1]!.kind)
      ) {
        const lower = (lows[0]!.price + lows[1]!.price) / 2;
        const upper = (highs[0]!.price + highs[1]!.price) / 2;
        if (
          upper > lower &&
          Math.abs(lows[0]!.price - lows[1]!.price) <= lower * 0.02 &&
          Math.abs(highs[0]!.price - highs[1]!.price) <= upper * 0.02
        )
          active = {
            lower,
            upper,
            buffer: ranges[i]! * 0.25,
            formedAt: i,
            expiresAt: i + 20,
          };
      }
    }
    result[i] = active;
    if (
      active &&
      (bars[i]!.close < active.lower - active.buffer ||
        bars[i]!.close > active.upper + active.buffer)
    ) {
      active = null;
      after = i;
    }
  }
  return result;
}

/** F08.07 is an exit component, never a short entry or a certified UTAD. */
export function createTheoryFailedUpthrust(bars: readonly Bar[]) {
  const { valid, pivots } = context(bars);
  const frozen = theoryFrozenRanges(bars);
  const result: TheoryComponentResult[] = bars.map(() => ({ status: "wait" }));
  let event: {
    start: number;
    upper: number;
    peak: number;
    returned?: number;
    pullback?: { low: number; confirmed: number };
  } | null = null;
  for (let i = 0; i < bars.length; i++) {
    if (!valid[i]) {
      event = null;
      result[i] = { status: "unknown" };
      continue;
    }
    const b = bars[i]!;
    if (event) {
      if (
        i > event.start + 20 ||
        (event.returned !== undefined && b.close > event.peak)
      ) {
        event = null;
        continue;
      }
      if (event.returned === undefined) {
        event.peak = Math.max(event.peak, b.high);
        if (i > event.start + 3) event = null;
        else if (b.close < event.upper) event.returned = i;
      } else if (!event.pullback) {
        const peak = pivots.find(
          (p) =>
            p.kind === "high" &&
            p.index > event!.returned! &&
            p.index + 3 === i,
        );
        if (peak) {
          if (peak.price >= event.peak) event = null;
          else event.pullback = { low: bars[peak.index]!.low, confirmed: i };
        }
      } else if (i > event.pullback.confirmed && b.close < event.pullback.low) {
        result[i] = {
          status: "signal",
          level: event.pullback.low,
          confirmedAt: event.pullback.confirmed,
        };
        event = null;
      }
      continue;
    }
    const range = frozen[i];
    // Intrabar high and close do not establish the order of the initial breach/reclaim.
    if (range && i > range.formedAt && b.close > range.upper)
      event = { start: i, upper: range.upper, peak: b.high };
    else if (range && i > range.formedAt && b.high > range.upper)
      result[i] = { status: "unknown" };
  }
  return (index: number): TheoryComponentResult =>
    result[index] ?? { status: "unknown" };
}

function rangeEntries(
  bars: readonly Bar[],
  frozen: readonly (FrozenTheoryRange | null)[],
  after: number,
) {
  const entries: (Entry | null)[] = [];
  let candidate: {
    index: number;
    low: number;
    high: number;
    range: FrozenTheoryRange;
  } | null = null;
  let next = after + 1;
  return (index: number) => {
    for (; next <= index; next++) {
      const i = next;
      const b = bars[i]!;
      const range = frozen[i];
      if (
        !validBar(b) ||
        !range ||
        b.close < range.lower - range.buffer ||
        b.close > range.upper + range.buffer
      ) {
        candidate = null;
        continue;
      }
      if (candidate) {
        if (
          candidate.range.formedAt !== range.formedAt ||
          i > candidate.index + 5 ||
          b.low < candidate.low
        )
          candidate = null;
        else if (
          i > candidate.index &&
          b.close > candidate.high &&
          b.close < range.upper
        ) {
          entries[i] = {
            stop: Math.min(candidate.low, range.lower) - range.buffer,
            target: (range.lower + range.upper) / 2,
          };
          continue;
        }
      }
      if (
        !candidate &&
        i > range.formedAt &&
        b.low <= range.lower + range.buffer &&
        b.close > range.lower
      )
        candidate = { index: i, low: b.low, high: b.high, range };
    }
    return entries[index] ?? null;
  };
}

function sosEntries(
  bars: readonly Bar[],
  frozen: readonly (FrozenTheoryRange | null)[],
  after: number,
  facts: ReturnType<typeof context>,
) {
  const { valid, pivots } = facts;
  const entries: (Entry | null)[] = [];
  let event: {
    start: number;
    upper: number;
    expiresAt: number;
    volume: number;
    width: number;
    candidate?: { confirmed: number; low: number; high: number };
  } | null = null;
  const average = (from: number, to: number, field: "volume" | "width") =>
    bars
      .slice(from, to + 1)
      .reduce(
        (sum, b) => sum + (field === "volume" ? b.volume : b.high - b.low),
        0,
      ) /
    (to - from + 1);
  let next = after + 1;
  return (index: number) => {
    for (; next <= index; next++) {
      const i = next;
      const b = bars[i]!;
      if (!valid[i] || !Number.isFinite(b.volume) || b.volume <= 0) {
        event = null;
        continue;
      }
      if (event) {
        if (b.low < event.upper || (!event.candidate && i > event.expiresAt)) {
          event = null;
          continue;
        }
        const candidate = event.candidate;
        if (candidate) {
          if (b.low < candidate.low || i > candidate.confirmed + 5)
            event = null;
          else if (i > candidate.confirmed && b.close > candidate.high) {
            entries[i] = { stop: candidate.low };
          }
        } else {
          const low = pivots.find(
            (p) =>
              p.kind === "low" && p.index > event!.start && p.index + 3 === i,
          );
          if (low) {
            if (
              average(event.start + 1, low.index, "volume") < event.volume &&
              average(event.start + 1, low.index, "width") < event.width &&
              bars
                .slice(low.index + 1, i + 1)
                .every((bar) => bar.low >= low.price)
            )
              event.candidate = {
                confirmed: i,
                low: low.price,
                high: Math.max(
                  ...bars.slice(low.index + 1, i + 1).map((bar) => bar.high),
                ),
              };
            else event = null;
          }
        }
        continue;
      }
      const range = frozen[i];
      if (
        !range ||
        i <= range.formedAt ||
        i < 20 ||
        b.close <= range.upper ||
        !bars
          .slice(i - 20, i + 1)
          .every(
            (bar) =>
              validBar(bar) && Number.isFinite(bar.volume) && bar.volume > 0,
          )
      )
        continue;
      const width = b.high - b.low;
      const start = pivots
        .filter(
          (p) =>
            p.kind === "low" && p.index >= range.formedAt && p.index + 3 < i,
        )
        .at(-1);
      if (
        start &&
        b.volume > average(i - 20, i - 1, "volume") * 1.5 &&
        width > average(i - 20, i - 1, "width") * 1.2 &&
        width > 0 &&
        (b.close - b.low) / width > 0.75
      )
        event = {
          start: i,
          upper: range.upper,
          expiresAt: range.expiresAt,
          volume: average(start.index, i, "volume"),
          width: average(start.index, i, "width"),
        };
    }
    return entries[index] ?? null;
  };
}

export function createTheoryRangeRule(strategy: string, bars: readonly Bar[]) {
  if (!theoryRangeDefinitions.some((row) => row.id === strategy)) return null;
  const frozen = theoryFrozenRanges(bars);
  const facts = context(bars);
  const scans = new Map<number, (index: number) => Entry | null>();
  const entryAt = (index: number, after: number) => {
    if (index <= after) return null;
    let scan = scans.get(after);
    if (!scan) {
      if (scans.size >= 8) scans.delete(scans.keys().next().value!);
      scan =
        strategy === "theory-range-reversion"
          ? rangeEntries(bars, frozen, after)
          : sosEntries(bars, frozen, after, facts);
      scans.set(after, scan);
    }
    return scan(index);
  };
  return (index: number, position: Position) => {
    const b = bars[index];
    if (!validBar(b)) return { enter: false, exit: false };
    const after = position.lastExitIndex ?? -1;
    if (!Number.isInteger(after) || after < -1 || after > index)
      throw new Error("Invalid actual exit index");
    const held = position.entry > 0 && index >= position.entryIndex;
    const origin = held
      ? entryAt(position.signalIndex ?? position.entryIndex - 1, after)
      : null;
    const timed =
      index - position.entryIndex >=
      (strategy === "theory-range-reversion" ? 20 : 40);
    return {
      enter: !held && entryAt(index, after) != null,
      exit:
        held &&
        (timed ||
          (origin != null &&
            (b.close < origin.stop ||
              (origin.target !== undefined && b.close >= origin.target)))),
    };
  };
}
