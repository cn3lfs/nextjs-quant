/**
 * F04.05 ORB: UTC-session opening-range breakout proxy.
 *
 * Frozen semantics (A proxy, not a strict intraday execution claim):
 * - Bars are completed, end-labelled 5-minute UTC bars. The label 00:05 is the
 *   first completed bar of a UTC day; 00:00 belongs to the preceding day.
 * - The first completed bar of the session forms OL/OH.
 * - stretch = mean over the prior 10 complete UTC days of min(H-O, O-L), where
 *   each day derives O/H/L from its 288 completed 5-minute bars.
 * - U = OH + stretch, S = OL - stretch, frozen once the session opens.
 * - The first completed close above U consumes that day's single entry attempt,
 *   even if the execution adapter later rejects the fill.
 * - A completed close at or below the signal day's frozen S, or the 23:55
 *   completed bar, produces an exit intent; execution happens at the next
 *   5-minute open. This is a close proxy, never hard intrabar protection.
 *
 * Missing opening slot, an incomplete prior-10-day window or a non-positive
 * protection level is UNKNOWN; no OHLC is fabricated. Missing intermediate bars
 * block new entries only. They never erase a confirmed position's signal-day
 * frozen S, and a delayed position exits at the next observed bar.
 * Evaluation is stateless: all state comes from the frozen input, the completed
 * bars, and the engine-confirmed position facts.
 */
import type { Bar } from "trading-strategy-core/bars";
import { dailyBarEpoch, isValidOhlc } from "./theory-input.js";

export const utcOrbPeriod = "5m" as const;
export const utcOrbBarMinutes = 5;
export const utcOrbSessionBars = 288;
export const utcOrbWarmupDays = 10;
/** The 23:55 end-labelled bar is the final decision bar before the session closes. */
export const utcOrbEndDaySlot = 286;
export const utcOrbSymbols = ["cxBTCUSDT", "cxETHUSDT"] as const;

const barStepMs = utcOrbBarMinutes * 60_000;
const labelPattern =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/;

/** Strict end-labelled UTC 5-minute bar label -> epoch milliseconds, or null. */
export function utcOrbBarEpoch(date: string): number | null {
  const match = labelPattern.exec(date);
  if (!match) return null;
  const zone = match[6]!;
  if (zone !== "Z" && zone !== "+00:00") return null;
  const year = Number(match[1]!.slice(0, 4));
  const month = Number(match[1]!.slice(5, 7));
  const day = Number(match[1]!.slice(8, 10));
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = Number(match[4] ?? "0");
  const millis = Number((match[5] ?? "").padEnd(3, "0") || "0");
  if (month < 1 || month > 12 || day < 1 || hour > 23 || minute > 59)
    return null;
  if (second > 59 || millis > 999) return null;
  if (minute % utcOrbBarMinutes !== 0) return null;
  const time = Date.parse(
    `${match[1]}T${match[2]}:${match[3]}:${match[4] ?? "00"}.${String(millis).padStart(3, "0")}Z`,
  );
  if (!Number.isFinite(time)) return null;
  const check = new Date(time);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute
  )
    return null;
  return time;
}

/** End-labelled bar date -> UTC session day. Midnight belongs to the prior day. */
export function utcOrbSessionDay(date: string): string | null {
  const time = utcOrbBarEpoch(date);
  if (time === null) return null;
  const at = new Date(time);
  const day =
    at.getUTCHours() === 0 && at.getUTCMinutes() === 0
      ? new Date(time - 86_400_000)
      : at;
  return day.toISOString().slice(0, 10);
}

/** 0-based session slot: 00:05 -> 0, 23:55 -> 286, 00:00 -> 287. */
export function utcOrbSlotIndex(date: string): number | null {
  const time = utcOrbBarEpoch(date);
  const day = utcOrbSessionDay(date);
  if (time === null || day === null) return null;
  const start = Date.parse(`${day}T00:00:00Z`);
  const slot = (time - start) / barStepMs - 1;
  return Number.isInteger(slot) && slot >= 0 && slot < utcOrbSessionBars
    ? slot
    : null;
}

export function utcOrbSlotLabel(day: string, slot: number): string {
  const midnight = dailyBarEpoch(day);
  if (midnight === null)
    throw new Error("UTC ORB session day must be a real YYYY-MM-DD day");
  if (!Number.isInteger(slot) || slot < 0 || slot >= utcOrbSessionBars)
    throw new Error("UTC ORB slot outside session");
  const time = midnight + (slot + 1) * barStepMs;
  return new Date(time).toISOString().replace(".000Z", "+00:00");
}

export function utcOrbShiftDay(day: string, days: number): string {
  const midnight = dailyBarEpoch(day);
  if (midnight === null)
    throw new Error("UTC ORB day must be a real YYYY-MM-DD day");
  return new Date(midnight + days * 86_400_000).toISOString().slice(0, 10);
}

export type UtcOrbOpening = {
  /** 00:05 end-labelled bar open. */
  open: number;
  high: number;
  low: number;
};

export type UtcOrbSession = {
  day: string;
  /** Expected first completed slot label (00:05), even when the bar is absent. */
  firstSlotAt: string;
  opening: UtcOrbOpening | null;
  /** Mean of prior 10 complete days' min(H-O, O-L); null when unknown. */
  stretch: number | null;
  upper: number | null;
  lower: number | null;
  /** The exact prior session days used, oldest first; empty when unknown. */
  priorCompleteDays: readonly string[];
  /** Null only when the opening and prior-day prerequisites are satisfied. */
  unknown: string | null;
};

export type UtcOrbCoverage = {
  from: string | null;
  to: string | null;
  bars: number;
  sessions: number;
  completeSessions: number;
};

export type UtcOrbInput = {
  market: "crypto";
  period: typeof utcOrbPeriod;
  barMinutes: typeof utcOrbBarMinutes;
  sessionBars: typeof utcOrbSessionBars;
  warmupDays: typeof utcOrbWarmupDays;
  /** Hash of the raw, unadjusted completed 5-minute source. */
  sourceHash: string;
  /** Explicit raw (no adjustment) identity. */
  adjustmentId: string;
  /** Continuous UTC calendar identity; crypto has no exchange holiday calendar. */
  calendarHash: string;
  coverage: UtcOrbCoverage;
  sessions: readonly UtcOrbSession[];
};

export type UtcOrbPosition = {
  entry: number;
  entryIndex: number;
  signalIndex?: number;
  lastExitIndex?: number;
};

export type UtcOrbDecision = {
  entry: boolean;
  exit: boolean;
  entryKnown: boolean;
  exitKnown: boolean;
  reason: string;
  sessionDay: string | null;
  slotIndex: number | null;
  upper: number | null;
  /** Always the signal day's frozen S when a position is held. */
  lower: number | null;
};

type SessionBars = {
  slots: Map<number, Bar>;
  /** Daily O/H/L derived from the session's completed bars. */
  open: number;
  high: number;
  low: number;
};

function validBar(bar: Bar) {
  return (
    isValidOhlc(bar) &&
    Number.isFinite(bar.volume) &&
    bar.volume >= 0 &&
    Number.isFinite(bar.amount) &&
    bar.amount >= 0
  );
}

function sessionBars(bars: readonly Bar[]): Map<string, SessionBars> {
  const sessions = new Map<string, SessionBars>();
  let previous = -Infinity;
  for (const bar of bars) {
    if (!validBar(bar)) throw new Error(`Invalid UTC ORB OHLCV: ${bar.date}`);
    const time = utcOrbBarEpoch(bar.date);
    const day = utcOrbSessionDay(bar.date);
    const slot = utcOrbSlotIndex(bar.date);
    if (time === null || day === null || slot === null)
      throw new Error(`UTC ORB requires end-labelled UTC 5m bars: ${bar.date}`);
    if (time <= previous)
      throw new Error("UTC ORB bars must be strictly increasing 5m instants");
    previous = time;
    let row = sessions.get(day);
    if (!row) {
      row = {
        slots: new Map(),
        open: bar.open,
        high: bar.high,
        low: bar.low,
      };
      sessions.set(day, row);
    }
    if (row.slots.has(slot))
      throw new Error(`Duplicate UTC ORB 5m slot ${day} #${slot}`);
    row.slots.set(slot, bar);
    if (slot === 0) row.open = bar.open;
    row.high = Math.max(row.high, bar.high);
    row.low = Math.min(row.low, bar.low);
  }
  return sessions;
}

function dailyRange(row: SessionBars) {
  return Math.min(row.high - row.open, row.open - row.low);
}

/** Pure session builder. Every observed day is listed; incomplete prerequisites
 * remain explicit unknowns instead of a fabricated opening range. */
export function buildUtcOrbSessions(
  bars: readonly Bar[],
  options: { warmupDays?: number } = {},
): UtcOrbSession[] {
  const warmupDays = options.warmupDays ?? utcOrbWarmupDays;
  if (warmupDays !== utcOrbWarmupDays)
    throw new Error("UTC ORB prior-day warmup is fixed at 10 complete days");
  const grouped = sessionBars(bars);
  const days = [...grouped.keys()].sort();
  return days.map((day) => {
    const row = grouped.get(day)!;
    const firstSlotAt = utcOrbSlotLabel(day, 0);
    const openingBar = row.slots.get(0) ?? null;
    const opening = openingBar
      ? { open: openingBar.open, high: openingBar.high, low: openingBar.low }
      : null;
    const priorCompleteDays: string[] = [];
    let priorComplete = true;
    const ranges: number[] = [];
    for (let offset = warmupDays; offset >= 1; offset--) {
      const priorDay = utcOrbShiftDay(day, -offset);
      const prior = grouped.get(priorDay);
      if (!prior || prior.slots.size !== utcOrbSessionBars) {
        priorComplete = false;
        break;
      }
      priorCompleteDays.push(priorDay);
      ranges.push(dailyRange(prior));
    }
    const stretch =
      priorComplete && ranges.length === warmupDays
        ? ranges.reduce((sum, value) => sum + value, 0) / warmupDays
        : null;
    const upper = opening && stretch !== null ? opening.high + stretch : null;
    const lower = opening && stretch !== null ? opening.low - stretch : null;
    const unknown = !opening
      ? "missing-opening-slot"
      : stretch === null
        ? "prior-10-days-incomplete"
        : lower === null || !(lower > 0) || upper === null || !(upper > 0)
          ? "non-positive-opening-range"
          : null;
    return {
      day,
      firstSlotAt,
      opening,
      stretch,
      upper: unknown === null ? upper : null,
      lower: unknown === null ? lower : null,
      priorCompleteDays,
      unknown,
    };
  });
}

/** The rule is explicitly an A proxy: completed 5-minute close signals with
 * next-bar execution, not a strict intraday or hard intrabar stop. */
export const utcOrbDefinition = {
  id: "theory-utc-orb",
  name: "ORB·UTC 5分钟收盘代理",
  theoryId: "F04.05",
  family: "突破",
  rule: "UTC 开盘后首根完成 5 分钟 bar 形成 OL/OH；stretch 为前 10 个完整 UTC 日 min(H-O,O-L) 均值，冻结 U=OH+stretch、S=OL-stretch。当日首个完成 5 分钟收盘越过 U 仅触发一次进入尝试（即使成交被拒也消耗）；收盘跌破信号日冻结 S 或 23:55 完成 bar 产生退出意图，下一 5 分钟开盘执行。仅 BTC/ETH 现货；未知缺口不补造，非严格日内执行或盘中硬止损。",
} as const;

function frozenSession(
  input: UtcOrbInput,
  bars: readonly Bar[],
): Map<string, UtcOrbSession> {
  if (input.market !== "crypto" || input.period !== utcOrbPeriod)
    throw new Error("UTC ORB is crypto 5m only");
  if (
    input.barMinutes !== utcOrbBarMinutes ||
    input.sessionBars !== utcOrbSessionBars ||
    input.warmupDays !== utcOrbWarmupDays
  )
    throw new Error("UTC ORB clock parameters are frozen");
  if (
    !input.sourceHash ||
    !input.adjustmentId ||
    input.calendarHash !== "continuous-UTC-v1"
  )
    throw new Error(
      "UTC ORB source, raw adjustment and calendar identity required",
    );
  if (!Array.isArray(input.sessions) || !input.sessions.length)
    throw new Error("UTC ORB frozen sessions required");
  let previous = "";
  for (const session of input.sessions) {
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(session.day) ||
      session.day <= previous ||
      session.firstSlotAt !== utcOrbSlotLabel(session.day, 0)
    )
      throw new Error("UTC ORB malformed frozen session date");
    previous = session.day;
  }
  const built = buildUtcOrbSessions(bars, { warmupDays: input.warmupDays });
  if (JSON.stringify(built) !== JSON.stringify(input.sessions))
    throw new Error("UTC ORB frozen sessions differ from completed 5m bars");
  return new Map(input.sessions.map((session) => [session.day, session]));
}

/** Stateless evaluation. Repeating or reordering calls cannot consume a second
 * entry attempt or invent a fill; actual holdings come from the engine position. */
export function createUtcOrbRule(input: UtcOrbInput, bars: readonly Bar[]) {
  const sessions = frozenSession(input, bars);
  const slotByIndex = bars.map((bar) => utcOrbSlotIndex(bar.date));
  const dayByIndex = bars.map((bar) => utcOrbSessionDay(bar.date));
  const indexByDaySlot = new Map<string, number>();
  bars.forEach((bar, index) => {
    const day = dayByIndex[index],
      slot = slotByIndex[index];
    if (day !== null && slot !== null)
      indexByDaySlot.set(`${day}:${slot}`, index);
  });
  const prefixComplete = (day: string, slot: number) => {
    for (let i = 0; i <= slot; i++)
      if (!indexByDaySlot.has(`${day}:${i}`)) return false;
    return true;
  };
  const unknown = (
    reason: string,
    sessionDay: string | null,
    slotIndex: number | null,
    upper: number | null,
    lower: number | null,
  ): UtcOrbDecision => ({
    entry: false,
    exit: false,
    entryKnown: false,
    exitKnown: false,
    reason,
    sessionDay,
    slotIndex,
    upper,
    lower,
  });
  return (
    index: number,
    position: UtcOrbPosition = { entry: 0, entryIndex: index },
  ): UtcOrbDecision => {
    if (!Number.isInteger(index) || index < 0 || index >= bars.length)
      throw new Error("Invalid UTC ORB index");
    if (
      !Number.isFinite(position.entry) ||
      position.entry < 0 ||
      !Number.isInteger(position.entryIndex) ||
      position.entryIndex < 0 ||
      position.entryIndex > index
    )
      throw new Error("Invalid UTC ORB position");
    const bar = bars[index]!;
    const day = dayByIndex[index]!;
    const slot = slotByIndex[index]!;

    // A confirmed position is protected before ANY current-session warmup or
    // opening-completeness check. Its signal-day S survives later gaps.
    if (position.entry > 0) {
      const signal = position.signalIndex;
      if (
        signal === undefined ||
        !Number.isInteger(signal) ||
        signal < 0 ||
        signal >= position.entryIndex
      )
        return unknown("missing-actual-entry-evidence", day, slot, null, null);
      const signalDay = dayByIndex[signal]!;
      const signalSession =
        signalDay === null ? undefined : sessions.get(signalDay);
      if (
        !signalSession ||
        signalSession.lower === null ||
        !(signalSession.lower > 0)
      )
        return unknown("signal-day-protection-unknown", day, slot, null, null);
      const lower = signalSession.lower;
      // Original P1: visible completed close at or below frozen S -> EXIT,
      // regardless of missing intermediate bars or an unknown later session.
      if (bar.close <= lower)
        return {
          entry: false,
          exit: true,
          entryKnown: true,
          exitKnown: true,
          reason: "close-at-or-below-frozen-lower",
          sessionDay: day,
          slotIndex: slot,
          upper: signalSession.upper,
          lower,
        };
      // A delayed position exits at the next observed bar; it needs no new
      // session stretch or opening range.
      if (day !== null && day > signalDay)
        return {
          entry: false,
          exit: true,
          entryKnown: true,
          exitKnown: true,
          reason: "late-end-of-day-exit-intent",
          sessionDay: day,
          slotIndex: slot,
          upper: signalSession.upper,
          lower,
        };
      if (day === signalDay && slot !== null && slot >= utcOrbEndDaySlot)
        return {
          entry: false,
          exit: true,
          entryKnown: true,
          exitKnown: true,
          reason: "end-of-day-exit-intent",
          sessionDay: day,
          slotIndex: slot,
          upper: signalSession.upper,
          lower,
        };
      return {
        entry: false,
        exit: false,
        entryKnown: true,
        exitKnown: true,
        reason: "holding",
        sessionDay: day,
        slotIndex: slot,
        upper: signalSession.upper,
        lower,
      };
    }

    const session = day === null ? undefined : sessions.get(day);
    if (!session || session.upper === null || session.lower === null)
      return unknown(
        session?.unknown ?? "session-unknown",
        day,
        slot,
        session?.upper ?? null,
        session?.lower ?? null,
      );
    if (slot === null || day === null)
      return unknown("invalid-slot", day, slot, session.upper, session.lower);
    // The 23:55 and 00:00 bars are exit-intent bars; no new entry there.
    if (slot >= utcOrbEndDaySlot)
      return {
        entry: false,
        exit: false,
        entryKnown: true,
        exitKnown: true,
        reason: "end-day-exit-priority",
        sessionDay: day,
        slotIndex: slot,
        upper: session.upper,
        lower: session.lower,
      };
    if (!prefixComplete(day, slot))
      return unknown(
        "current-session-gap",
        day,
        slot,
        session.upper,
        session.lower,
      );
    let earlierCross = false;
    for (let i = 1; i < slot; i++) {
      const earlier = indexByDaySlot.get(`${day}:${i}`);
      if (earlier !== undefined && bars[earlier]!.close > session.upper) {
        earlierCross = true;
        break;
      }
    }
    if (earlierCross)
      return {
        entry: false,
        exit: false,
        entryKnown: true,
        exitKnown: true,
        reason: "entry-attempt-consumed",
        sessionDay: day,
        slotIndex: slot,
        upper: session.upper,
        lower: session.lower,
      };
    const crossing = bar.close > session.upper;
    return {
      entry: crossing,
      exit: false,
      entryKnown: true,
      exitKnown: true,
      reason: crossing ? "first-completed-close-above-upper" : "waiting",
      sessionDay: day,
      slotIndex: slot,
      upper: session.upper,
      lower: session.lower,
    };
  };
}
