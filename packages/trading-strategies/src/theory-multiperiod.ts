import type { Bar } from "trading-strategy-core/bars";
import { emaSeries, macd } from "trading-strategy-core/indicators";

export const tripleScreenVariants = ["week-day", "day-hour-five"] as const;
export type TripleScreenVariant = (typeof tripleScreenVariants)[number];
export const tripleScreenDefinitions = [
  {
    id: "theory-triple-screen-week-day",
    variant: "week-day",
    name: "三重滤网·周日收盘代理",
    theoryId: "F03.11",
    family: "趋势",
    rule: "完成周MACD(12,26,9)柱上升，日Force EMA2为负时冻结准备高低；随后5根日收盘越高加已核实价格步长进入。实际成交后不加仓，收盘破冻结低点或背景失效退出。",
  },
  {
    id: "theory-triple-screen-day-hour-five",
    variant: "day-hour-five",
    name: "三重滤网·日60分5分代理",
    theoryId: "F03.11",
    family: "趋势",
    rule: "完成日MACD(12,26,9)柱上升，完成60分Force EMA2为负时冻结准备高低；随后12根5分收盘越高加已核实价格步长进入。实际成交后不加仓，5分收盘破冻结低点或日背景失效退出。",
  },
] as const;
/** A null slot is an observed missing period, never a fabricated OHLC bar. */
export type CompletedPeriod = {
  availableAt: string;
  bar: Bar | null;
  /** Signal/raw price multiplier at this execution bar; raw tick uses this scale. */
  priceScale?: number;
  reason?: string;
};
export type TripleScreenSeries = {
  period: "week" | "day" | "60m" | "5m";
  sourceHash: string;
  adjustmentId: string;
  calendarHash: string;
  slots: readonly CompletedPeriod[];
};
export type TripleScreenInput = {
  variant: TripleScreenVariant;
  market: "cn-equity" | "crypto";
  tick: number | null;
  execution: TripleScreenSeries;
  background: TripleScreenSeries;
  setup: TripleScreenSeries;
};
export type TripleScreenPosition = {
  entry: number;
  entryIndex: number;
  signalIndex?: number;
  /** Last actual full exit, not an exit intention; retained while holding. */
  lastExitIndex?: number;
};
export type TripleScreenDecision = {
  enter: boolean;
  exit: boolean;
  entryKnown: boolean;
  exitKnown: boolean;
  reason: string;
  stop: number | null;
  setupAt: string | null;
  backgroundAt: string | null;
};
type Candidate = {
  upper: number;
  stop: number;
  created: number;
  setupAt: string;
};
const empty = (reason: string): TripleScreenDecision => ({
  enter: false,
  exit: false,
  entryKnown: true,
  exitKnown: true,
  reason,
  stop: null,
  setupAt: null,
  backgroundAt: null,
});

function earliestCompletion(
  date: string,
  period: TripleScreenSeries["period"],
  market: TripleScreenInput["market"],
) {
  if (period === "5m" || period === "60m") return Date.parse(date);
  const day = date.slice(0, 10),
    time = Date.parse(day),
    weekday = new Date(time).getUTCDay();
  if (period === "day")
    return market === "crypto"
      ? time + 86400000
      : Date.parse(`${day}T15:00:00+08:00`);
  const monday = time - ((weekday + 6) % 7) * 86400000;
  return market === "crypto"
    ? monday + 7 * 86400000
    : Date.parse(
        `${new Date(monday + 4 * 86400000).toISOString().slice(0, 10)}T15:05:00+08:00`,
      );
}
function validateSeries(
  series: TripleScreenSeries,
  market: TripleScreenInput["market"],
) {
  if (!series.sourceHash || !series.adjustmentId || !series.calendarHash)
    throw new Error(
      "Multi-period source, adjustment and calendar identities are required",
    );
  let previous = -Infinity;
  for (const slot of series.slots) {
    const time = Date.parse(slot.availableAt);
    if (!Number.isFinite(time) || time <= previous)
      throw new Error("Multi-period availability must be strictly increasing");
    previous = time;
    if (
      slot.priceScale !== undefined &&
      (!Number.isFinite(slot.priceScale) || slot.priceScale <= 0)
    )
      throw new Error("Invalid signal price scale");
    const b = slot.bar;
    if (
      b &&
      (!Number.isFinite(Date.parse(b.date)) ||
        ((series.period === "day" || series.period === "week") &&
          !/^\d{4}-\d{2}-\d{2}$/.test(b.date)) ||
        earliestCompletion(b.date, series.period, market) > time ||
        ![b.open, b.high, b.low, b.close, b.volume, b.amount].every(
          Number.isFinite,
        ) ||
        b.low <= 0 ||
        b.high < Math.max(b.open, b.close, b.low) ||
        b.low > Math.min(b.open, b.close) ||
        b.volume < 0 ||
        b.amount < 0)
    )
      throw new Error("Invalid multi-period OHLCV");
  }
}

/** Indicators restart after a missing slot; warmup never jumps across a gap. */
function indicators(series: TripleScreenSeries) {
  const histogram: (number | null)[] = [],
    force: (number | null)[] = [];
  for (let start = 0; start < series.slots.length;) {
    if (!series.slots[start]!.bar) {
      histogram.push(null);
      force.push(null);
      start++;
      continue;
    }
    let end = start;
    const segment: Bar[] = [];
    while (end < series.slots.length && series.slots[end]!.bar)
      segment.push(series.slots[end++]!.bar!);
    const hist = macd(segment);
    const fi = emaSeries(
      segment.map((bar, i) =>
        i === 0 ? null : (bar.close - segment[i - 1]!.close) * bar.volume,
      ),
      2,
    );
    for (let i = 0; i < segment.length; i++) {
      histogram.push(i < 34 ? null : hist[i]!.macd);
      force.push(i < 2 ? null : fi[i]!);
    }
    start = end;
  }
  return { histogram, force };
}
function atOrBefore(slots: readonly CompletedPeriod[], time: number) {
  let lo = 0,
    hi = slots.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (Date.parse(slots[mid]!.availableAt) <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/** Stateless evaluation: the caller supplies actual last-exit and entry facts.
 * Repeating or reordering calls cannot consume a candidate or invent a fill. */
export function createTripleScreenRule(input: TripleScreenInput) {
  for (const series of [input.execution, input.background, input.setup])
    validateSeries(series, input.market);
  if (
    input.execution.slots.some(
      (slot) => slot.bar !== null && slot.priceScale === undefined,
    )
  )
    throw new Error("Execution signal/raw price scale must be explicit");
  const periods =
    input.variant === "week-day"
      ? ["day", "week", "day"]
      : ["5m", "day", "60m"];
  if (
    [input.execution, input.background, input.setup].some(
      (s, i) => s.period !== periods[i],
    )
  )
    throw new Error("Triple-screen variant and periods disagree");
  if (
    new Set(
      [input.execution, input.background, input.setup].map(
        (s) => s.adjustmentId,
      ),
    ).size !== 1
  )
    throw new Error("Multi-period adjustment identities disagree");
  const background = indicators(input.background),
    setup = indicators(input.setup);
  const lifespan = input.variant === "week-day" ? 5 : 12;
  const frames = input.execution.slots.map((slot) => {
    const time = Date.parse(slot.availableAt);
    const bi = atOrBefore(input.background.slots, time),
      si = atOrBefore(input.setup.slots, time);
    const current = background.histogram[bi],
      previous = background.histogram[bi - 1];
    return {
      slot,
      bi,
      si,
      direction:
        current == null || previous == null ? null : current > previous,
      force: setup.force[si] ?? null,
    };
  });
  const scans = new Map<
    number,
    {
      candidate: Candidate | null;
      seen: number;
      results: TripleScreenDecision[];
    }
  >();
  function scan(index: number, after: number) {
    if (index <= after) return empty("waiting-after-actual-exit");
    let cached = scans.get(after);
    if (!cached) {
      if (scans.size >= 8) scans.delete(scans.keys().next().value!);
      cached = { candidate: null, seen: -1, results: [] };
      scans.set(after, cached);
    }
    let candidate = cached.candidate,
      seen = cached.seen;
    for (let i = after + 1 + cached.results.length; i <= index; i++) {
      const f = frames[i]!;
      const b = f.slot.bar;
      let result = empty("waiting");
      // Store every frame, including early-return unknown and invalidation frames.
      cached.results.push(result);
      result.backgroundAt = input.background.slots[f.bi]?.availableAt ?? null;
      if (!b || f.direction === null || f.force === null) {
        candidate = null;
        seen = f.si;
        result.reason = "incomplete-period-or-warmup";
        result.entryKnown = false;
        continue;
      }
      if (
        candidate &&
        (b.close < candidate.stop ||
          !f.direction ||
          i - candidate.created > lifespan)
      ) {
        candidate = null;
        seen = f.si;
        result.reason = "candidate-invalidated";
        continue;
      }
      if (candidate) {
        result.stop = candidate.stop;
        result.setupAt = candidate.setupAt;
        if (
          i > candidate.created &&
          input.tick !== null &&
          Number.isFinite(input.tick) &&
          input.tick > 0 &&
          b.close > candidate.upper + input.tick * f.slot.priceScale!
        ) {
          result.enter = true;
          result.reason = "completed-close-trigger";
        } else
          result.reason =
            input.tick === null ||
            !Number.isFinite(input.tick) ||
            !(input.tick > 0)
              ? "unknown-price-tick"
              : "candidate-waiting";
        if (result.reason === "unknown-price-tick") result.entryKnown = false;
      }
      if (!candidate && f.si !== seen && f.direction && f.force < 0) {
        const s = input.setup.slots[f.si]!;
        // A held period or a period completed before the actual exit cannot prepare a new entry.
        if (
          s.bar &&
          (after < 0 ||
            Date.parse(s.availableAt) >
              Date.parse(frames[after]!.slot.availableAt))
        ) {
          candidate = {
            upper: s.bar.high,
            stop: s.bar.low,
            created: i,
            setupAt: s.availableAt,
          };
          result = {
            ...result,
            stop: candidate.stop,
            setupAt: candidate.setupAt,
            reason: "candidate-created",
          };
          cached.results[cached.results.length - 1] = result;
        }
      }
      seen = f.si;
    }
    cached.candidate = candidate;
    cached.seen = seen;
    return { ...cached.results[index - after - 1]! };
  }
  return (
    index: number,
    position: TripleScreenPosition,
  ): TripleScreenDecision => {
    if (!Number.isInteger(index) || index < 0 || index >= frames.length)
      throw new Error("Invalid execution index");
    const after = position.lastExitIndex ?? -1;
    if (!Number.isInteger(after) || after < -1 || after > index)
      throw new Error("Invalid actual exit index");
    if (!(position.entry > 0)) return scan(index, after);
    const signal = position.signalIndex;
    if (
      signal === undefined ||
      signal <= after ||
      signal >= position.entryIndex ||
      position.entryIndex > index
    )
      return {
        ...empty("missing-actual-entry-evidence"),
        entryKnown: false,
        exitKnown: false,
      };
    const origin = scan(signal, after),
      f = frames[index]!;
    if (!origin.enter || origin.stop === null)
      return {
        ...empty("invalid-entry-signal-evidence"),
        entryKnown: false,
        exitKnown: false,
      };
    const protect = f.slot.bar !== null && f.slot.bar.close < origin.stop;
    return {
      ...origin,
      enter: false,
      exit: protect || f.direction === false,
      entryKnown: true,
      exitKnown:
        protect ||
        f.direction === false ||
        (f.slot.bar !== null && f.direction !== null),
      backgroundAt: input.background.slots[f.bi]?.availableAt ?? null,
      reason: protect
        ? "frozen-close-protection"
        : f.direction === false
          ? "background-failed"
          : f.direction === null || !f.slot.bar
            ? "unknown-background-protection-retained"
            : "holding",
    };
  };
}
