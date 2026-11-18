/**
 * Watchlist components:
 * - F02.07 Livermore pivotal-point watchlist.
 * - F11.02 trend-leader selection inside a frozen theme.
 *
 * Shared discipline:
 * - Every timestamp is explicit and must be knowable at the decision. Daily
 *   labels are labels, not confirmation timestamps. Future bars are never
 *   borrowed; they are filtered out before any window is built.
 * - Known protection comes first. A real position's fill-time frozen S is
 *   checked even when the benchmark, candidate list or current watchlist is
 *   missing. Likewise, an existing theme candidate is cancelled when its own
 *   latest close is below the frozen MA_m even if a new ranking is unavailable.
 * - An EXIT is an intent, not a fill. The state carries it keyed by the actual
 *   fillId with its original trigger evidence; it repeats until the host
 *   reports position:null. An absent position never clears it.
 * - F02 is a current-close decision (core Shanghai 15:05 boundary). F11 reads
 *   only the previous completed day and may run in the current morning.
 * - Missing facts stay UNKNOWN. No return is filled with zero, no symbol is
 *   added from a current pool, and no mean/neutral value is invented.
 * - These components only produce intents or selections. They never create a
 *   position, order or fill.
 */
import type { Bar } from "trading-strategy-core/bars";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import { ma } from "trading-strategy-core/indicators";
import {
  confirmationEpoch,
  type ConfirmationTime,
} from "./theory-confirmation.js";
import { dailyBarEpoch, isValidOhlc } from "./theory-input.js";

/* ------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* ------------------------------------------------------------------------- */

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function clean(value: number): number {
  const rounded = Number(value.toFixed(12));
  return Math.abs(rounded) < 1e-12 ? 0 : rounded;
}

/** Boolean wrapper so a shared type guard does not narrow a `Bar` variable. */
function hasValidOhlc(value: unknown): boolean {
  return isValidOhlc(value);
}

function isCompletedBar(bar: Bar | null | undefined): bar is Bar {
  return (
    bar !== null &&
    bar !== undefined &&
    typeof bar === "object" &&
    isValidOhlc(bar) &&
    isFiniteNumber(bar.volume) &&
    bar.volume >= 0 &&
    isFiniteNumber(bar.amount) &&
    bar.amount >= 0
  );
}

/**
 * Keep bars at or before `decisionDate` (or strictly before it), while
 * validating the whole supplied ordering. Future bars are ignored, never used.
 */
function dailyPrefix(
  bars: readonly (Bar | null | undefined)[],
  decisionDate: string,
  includeDecisionBar: boolean,
): (Bar | null)[] {
  if (!Array.isArray(bars)) throw new Error("daily series must be an array");
  const decisionEpoch = dailyBarEpoch(decisionDate);
  if (decisionEpoch === null)
    throw new Error("decisionDate must be a real day");
  let previous = Number.NEGATIVE_INFINITY;
  let boundaryCrossed = false;
  const prefix: (Bar | null)[] = [];
  for (const bar of bars) {
    if (bar === null || bar === undefined) {
      // After the first dated bar at/after the decision boundary, later nulls
      // cannot be positioned in history; they are not inserted retroactively.
      if (!boundaryCrossed) prefix.push(null);
      continue;
    }
    if (typeof bar !== "object")
      throw new Error("daily bar must be an object or null");
    const epoch = dailyBarEpoch(bar.date);
    if (epoch === null) throw new Error("daily bar date is invalid");
    if (epoch <= previous)
      throw new Error("daily bar dates must be strictly ascending");
    previous = epoch;
    if (
      epoch > decisionEpoch ||
      (!includeDecisionBar && epoch === decisionEpoch)
    ) {
      boundaryCrossed = true;
      continue;
    }
    if (!isCompletedBar(bar)) throw new Error("daily bar OHLCV is invalid");
    prefix.push(bar);
  }
  return prefix;
}

function barByDate(bars: readonly (Bar | null)[]): Map<string, Bar> {
  const byDate = new Map<string, Bar>();
  for (const bar of bars) {
    if (!bar) continue;
    if (byDate.has(bar.date)) throw new Error("duplicate daily bar date");
    byDate.set(bar.date, bar);
  }
  return byDate;
}

function lastValidBar(bars: readonly (Bar | null)[]): Bar | null {
  for (let index = bars.length - 1; index >= 0; index--) {
    const bar = bars[index];
    if (bar) return bar;
  }
  return null;
}

function indexOfDate(bars: readonly (Bar | null)[], date: string): number {
  for (let index = 0; index < bars.length; index++)
    if (bars[index]?.date === date) return index;
  return -1;
}

/** A complete run of valid bars over the last `count` slots. */
function recentComplete(bars: readonly (Bar | null)[], count: number): boolean {
  if (bars.length < count) return false;
  for (let index = bars.length - count; index < bars.length; index++)
    if (!bars[index]) return false;
  return true;
}

function finiteMa(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Shared core MA, read at a fixed completed-bar offset. */
function requiredMa(bars: readonly Bar[], window: number, offset = 0): number {
  const value = finiteMa(ma(bars, window).at(-1 - offset));
  if (value === null)
    throw new Error("MA warmup was not complete for a complete window");
  return value;
}

function closeDrawdown(closes: readonly number[]): number {
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (const close of closes) {
    if (close > peak) peak = close;
    const drawdown = (peak - close) / peak;
    if (drawdown > worst) worst = drawdown;
  }
  return worst;
}

/**
 * CN daily decision clock. The Shanghai 15:05 completion boundary comes from
 * trading-strategy-core's public completedBarFilter; this module never
 * re-implements a close-time rule. `asOf` must be on the decision day after
 * the cutoff, so a historical decision cannot be backfilled with a later clock.
 */
type CnMarketDay = {
  asOf: number;
  decisionEpoch: number;
};

type CnDecisionClock = CnMarketDay & {
  decisionCutoff: number;
  completed: (date: string) => boolean;
};

/** CN-only, same Shanghai market day. No close-time assumption here. */
function cnMarketDay(
  market: unknown,
  decisionDate: string,
  asOfValue: ConfirmationTime,
): CnMarketDay {
  if (market !== "cn-equity")
    throw new Error("watchlist components accept market 'cn-equity' only");
  const asOf = confirmationEpoch(asOfValue);
  if (asOf === null) throw new Error("asOf must carry an explicit timezone");
  const decisionEpoch = dailyBarEpoch(decisionDate);
  if (decisionEpoch === null)
    throw new Error("decisionDate must be a real day");
  const localDate = new Date(asOf + 8 * 3_600_000).toISOString().slice(0, 10);
  if (localDate !== decisionDate)
    throw new Error(
      "asOf must fall on the same Shanghai market day as decisionDate",
    );
  return { asOf, decisionEpoch };
}

/**
 * F02 current-close decision clock. The decision day must be completed by the
 * core Shanghai 15:05 filter; F11 uses cnMarketDay because it reads only the
 * previous completed day.
 */
function cnDecisionClock(
  market: unknown,
  decisionDate: string,
  asOfValue: ConfirmationTime,
): CnDecisionClock {
  const day = cnMarketDay(market, decisionDate, asOfValue);
  const completed = completedBarFilter("day", day.asOf);
  if (!completed(decisionDate))
    throw new Error("decisionDate daily bar is not completed by asOf");
  const decisionCutoff = Date.parse(`${decisionDate}T15:05:00+08:00`);
  if (!Number.isFinite(decisionCutoff))
    throw new Error("decisionDate cutoff is invalid");
  if (day.asOf < decisionCutoff)
    throw new Error(
      "asOf must be at or after the 15:05 Shanghai decision cutoff",
    );
  return { ...day, decisionCutoff, completed };
}

/**
 * Price-stop evidence only needs the unique completed decision-day bar with a
 * trustworthy OHLC. Old volume/amount defects and unrelated historical bars do
 * not block a known protection.
 */
function decisionBarForStop(
  bars: readonly (Bar | null | undefined)[],
  decisionDate: string,
): { bar: Bar | null; ambiguous: boolean } {
  if (!Array.isArray(bars)) throw new Error("position bars must be an array");
  let found: Bar | null = null;
  for (const item of bars) {
    if (!item || typeof item !== "object") continue;
    if (item.date !== decisionDate) continue;
    if (found) return { bar: null, ambiguous: true };
    if (!hasValidOhlc(item)) return { bar: null, ambiguous: false };
    found = item;
  }
  return { bar: found, ambiguous: false };
}

/* ------------------------------------------------------------------------- */
/* F02.07 Livermore pivotal-point watchlist                                    */
/* ------------------------------------------------------------------------- */

export type LivermoreSeries = {
  symbol: string;
  bars: readonly (Bar | null)[];
};

export type LivermoreFrozenUniverse = {
  frozenAt: ConfirmationTime;
  members: readonly LivermoreSeries[];
};

export type LivermoreBenchmark = {
  symbol: string;
  frozenAt: ConfirmationTime;
  bars: readonly (Bar | null)[];
};

export type LivermoreAnchor = {
  anchorId: string;
  symbol: string;
  /** Confirmed resistance. */
  upper: number;
  /** Confirmed support; the fill-time protection is frozen separately. */
  lower: number;
  /** Completed daily bar at which U/S were confirmed. */
  confirmedBarDate: string;
  /** First knowable confirmation time; must not postdate the decision. */
  confirmedAt: ConfirmationTime;
};

export type LivermorePosition = {
  symbol: string;
  /** Support frozen at the actual fill; never replaced by a watchlist anchor. */
  lower: number;
  /** Actual fill identity; no position is invented from an ENTER intent. */
  fillId: string;
  /** Completed daily bars for the held symbol, independent of the watchlist. */
  bars: readonly (Bar | null)[];
};

/** A host-carried EXIT intent; it is not a fill and stays until actual is flat. */
export type LivermorePendingExit = {
  fillId: string;
  symbol: string;
  /** Fill-time frozen support captured when the exit first triggered. */
  protection: number;
  /** The exact completed decision bar that first triggered the exit. */
  triggerDate: string;
  triggerClose: number;
  /** Decision clock of the trigger, in epoch milliseconds. */
  decidedAt: number;
};

export type LivermoreWatchlistState = {
  consumedAnchorIds: readonly string[];
  pendingEnterAnchorIds: readonly string[];
  /** Optional on input; always echoed on output. Cleared only by position:null. */
  pendingExit?: LivermorePendingExit | null;
};

export type LivermoreWatchlistInput = {
  /** This component is limited to CN daily bars in this batch. */
  market: "cn-equity";
  /**
   * Decision clock, not the current run time. It must be on the same Shanghai
   * market day as decisionDate and at/after 15:05, so a later run cannot
   * backfill an earlier decision.
   */
  asOf: ConfirmationTime;
  decisionDate: string;
  /** Past-return window n, in completed daily bars. */
  lookback: number;
  /** Maximum flat-candidate age w, in completed daily bars (0 allowed). */
  maxCandidateAge: number;
  universe?: LivermoreFrozenUniverse | null;
  benchmark?: LivermoreBenchmark | null;
  anchors?: readonly LivermoreAnchor[];
  position?: LivermorePosition | null;
  state?: LivermoreWatchlistState;
};

export type LivermoreCandidateStatus =
  | "CONSUMED"
  | "EXPIRED"
  | "BELOW_PROTECTION"
  | "PENDING"
  | "TRIGGER"
  | "WAIT"
  | "UNKNOWN";

export type LivermoreCandidateEvaluation = {
  anchorId: string;
  symbol: string;
  status: LivermoreCandidateStatus;
  reason: string;
  age: number | null;
  close: number | null;
  previousClose: number | null;
  symbolReturn: number | null;
  benchmarkReturn: number | null;
  excessReturn: number | null;
  upper: number;
  lower: number;
  confirmedBarDate: string;
  confirmedAt: number | null;
};

export type LivermoreEnterIntent = {
  kind: "ENTER";
  anchorId: string;
  symbol: string;
  upper: number;
  lower: number;
  /** Protection to carry with the intent; host fills establish the position. */
  protection: number;
  triggerClose: number;
  previousClose: number;
  excessReturn: number;
  decisionDate: string;
  asOf: number;
};

export type LivermoreExitIntent = {
  kind: "EXIT";
  symbol: string;
  protection: number;
  /** The close that first triggered the exit; not a fresh replacement price. */
  close: number;
  fillId: string;
  reason: "CLOSE_BELOW_FILL_FROZEN_SUPPORT";
  triggerDate: string;
  decidedAt: number;
  /** True when this repeats a host-carried pending exit. */
  pending: boolean;
};

export type LivermoreWatchlistIssueCode =
  | "UNIVERSE_MISSING"
  | "BENCHMARK_MISSING"
  | "ANCHOR_SYMBOL_NOT_IN_WATCHLIST"
  | "ANCHOR_CONFIRMED_AFTER_DECISION"
  | "ANCHOR_CONFIRMED_AFTER_CUTOFF"
  | "ANCHOR_NOT_IN_SERIES"
  | "CONFLICTING_ANCHOR_ID"
  | "BENCHMARK_WINDOW_UNAVAILABLE"
  | "POSITION_CLOSE_UNKNOWN"
  | "AMBIGUOUS_DECISION_BAR"
  | "PENDING_EXIT_INCONSISTENT"
  | "ANCHOR_NOT_COMPLETED_AT_CONFIRMATION";

export type LivermoreWatchlistIssue = {
  code: LivermoreWatchlistIssueCode;
  severity: "UNKNOWN" | "INFO";
  anchorId: string | null;
  symbol: string | null;
  detail: string;
};

export type LivermoreWatchlistResult = {
  status: "ENTER" | "HOLD" | "EXIT" | "WAIT" | "UNKNOWN";
  reason: string;
  symbol: string | null;
  anchorId: string | null;
  /** Known protection, echoed even when the status is UNKNOWN. */
  protection: number | null;
  asOf: number | null;
  decisionDate: string;
  state: LivermoreWatchlistState;
  enterIntent: LivermoreEnterIntent | null;
  exitIntent: LivermoreExitIntent | null;
  candidates: readonly LivermoreCandidateEvaluation[];
  issues: readonly LivermoreWatchlistIssue[];
};

type AnchorRun = {
  anchor: LivermoreAnchor;
  symbol: string;
  confirmedAt: number;
};

function livermoreIssue(
  code: LivermoreWatchlistIssueCode,
  detail: string,
  values: { anchorId?: string | null; symbol?: string | null } = {},
): LivermoreWatchlistIssue {
  return {
    code,
    severity: "UNKNOWN",
    anchorId: values.anchorId ?? null,
    symbol: values.symbol ?? null,
    detail,
  };
}

function sortLivermoreIssues(
  issues: LivermoreWatchlistIssue[],
): LivermoreWatchlistIssue[] {
  return issues.sort(
    (left, right) =>
      compareText(left.code, right.code) ||
      compareText(left.anchorId ?? "", right.anchorId ?? "") ||
      compareText(left.symbol ?? "", right.symbol ?? "") ||
      compareText(left.detail, right.detail),
  );
}

function resolveAnchors(anchors: readonly LivermoreAnchor[]): {
  runs: AnchorRun[];
  issues: LivermoreWatchlistIssue[];
} {
  const issues: LivermoreWatchlistIssue[] = [];
  const byId = new Map<string, LivermoreAnchor[]>();
  for (const anchor of anchors) {
    if (!anchor) throw new Error("anchor must not be null");
    if (!isNonEmptyString(anchor.anchorId))
      throw new Error("anchorId must be non-empty");
    if (!isNonEmptyString(anchor.symbol))
      throw new Error(`anchor ${anchor.anchorId} symbol must be non-empty`);
    if (
      !isFiniteNumber(anchor.upper) ||
      !isFiniteNumber(anchor.lower) ||
      anchor.upper <= 0 ||
      anchor.lower <= 0 ||
      anchor.upper <= anchor.lower
    )
      throw new Error(
        `anchor ${anchor.anchorId} requires finite 0 < lower < upper`,
      );
    if (dailyBarEpoch(anchor.confirmedBarDate) === null)
      throw new Error(`anchor ${anchor.anchorId} confirmedBarDate is invalid`);
    if (confirmationEpoch(anchor.confirmedAt) === null)
      throw new Error(
        `anchor ${anchor.anchorId} confirmedAt must carry a timezone`,
      );
    const list = byId.get(anchor.anchorId) ?? [];
    list.push(anchor);
    byId.set(anchor.anchorId, list);
  }

  const runs: AnchorRun[] = [];
  for (const [anchorId, list] of byId) {
    const first = list[0];
    if (!first) continue;
    const identical = list.every(
      (candidate) =>
        candidate.symbol === first.symbol &&
        candidate.upper === first.upper &&
        candidate.lower === first.lower &&
        candidate.confirmedBarDate === first.confirmedBarDate &&
        candidate.confirmedAt === first.confirmedAt,
    );
    if (!identical) {
      issues.push(
        livermoreIssue(
          "CONFLICTING_ANCHOR_ID",
          "duplicate anchor id has conflicting content",
          { anchorId },
        ),
      );
      continue;
    }
    const confirmedAt = confirmationEpoch(first.confirmedAt);
    if (confirmedAt === null) continue;
    // The documented Completed daily bar must actually be complete at the
    // declared confirmation time. Same-day 10:00 is not a daily completion.
    if (!completedBarFilter("day", confirmedAt)(first.confirmedBarDate)) {
      issues.push(
        livermoreIssue(
          "ANCHOR_NOT_COMPLETED_AT_CONFIRMATION",
          "anchor confirmation time precedes its daily bar completion",
          { anchorId, symbol: first.symbol },
        ),
      );
      continue;
    }
    runs.push({ anchor: first, symbol: first.symbol, confirmedAt });
  }
  runs.sort(
    (left, right) =>
      compareText(
        left.anchor.confirmedBarDate,
        right.anchor.confirmedBarDate,
      ) ||
      compareText(left.symbol, right.symbol) ||
      compareText(left.anchor.anchorId, right.anchor.anchorId),
  );
  return { runs, issues };
}

function normalizeState(
  state: LivermoreWatchlistState | undefined,
): LivermoreWatchlistState {
  const consumed = state?.consumedAnchorIds ?? [];
  const pending = state?.pendingEnterAnchorIds ?? [];
  if (!Array.isArray(consumed) || !Array.isArray(pending))
    throw new Error("watchlist state must contain arrays");
  for (const id of [...consumed, ...pending])
    if (!isNonEmptyString(id))
      throw new Error("watchlist state ids must be non-empty");

  let pendingExit: LivermorePendingExit | null = null;
  const rawPendingExit = state?.pendingExit;
  if (rawPendingExit !== undefined && rawPendingExit !== null) {
    if (!isNonEmptyString(rawPendingExit.fillId))
      throw new Error("pending exit fillId must be non-empty");
    if (!isNonEmptyString(rawPendingExit.symbol))
      throw new Error("pending exit symbol must be non-empty");
    if (
      !isFiniteNumber(rawPendingExit.protection) ||
      rawPendingExit.protection <= 0
    )
      throw new Error("pending exit protection must be finite positive");
    if (dailyBarEpoch(rawPendingExit.triggerDate) === null)
      throw new Error("pending exit triggerDate must be a real day");
    if (
      !isFiniteNumber(rawPendingExit.triggerClose) ||
      rawPendingExit.triggerClose <= 0
    )
      throw new Error("pending exit triggerClose must be finite positive");
    if (
      !isNonNegativeInteger(rawPendingExit.decidedAt) ||
      rawPendingExit.decidedAt < 0
    )
      throw new Error("pending exit decidedAt must be a non-negative epoch");
    pendingExit = { ...rawPendingExit };
  }

  return {
    consumedAnchorIds: [...new Set(consumed)].sort(compareText),
    pendingEnterAnchorIds: [...new Set(pending)].sort(compareText),
    pendingExit,
  };
}

function emptyLivermoreResult(
  status: "UNKNOWN" | "WAIT" | "HOLD" | "EXIT" | "ENTER",
  reason: string,
  decisionDate: string,
  state: LivermoreWatchlistState,
  protection: number | null = null,
  issues: LivermoreWatchlistIssue[] = [],
): LivermoreWatchlistResult {
  return {
    status,
    reason,
    symbol: null,
    anchorId: null,
    protection,
    asOf: null,
    decisionDate,
    state,
    enterIntent: null,
    exitIntent: null,
    candidates: [],
    issues: sortLivermoreIssues(issues),
  };
}

/** Repeat a host-carried EXIT with its original trigger evidence. */
function pendingExitResult(
  decisionDate: string,
  state: LivermoreWatchlistState,
  pending: LivermorePendingExit,
  asOf: number,
): LivermoreWatchlistResult {
  return {
    ...emptyLivermoreResult(
      "EXIT",
      "pending-exit-until-actual-flat",
      decisionDate,
      { ...state, pendingExit: pending },
      pending.protection,
    ),
    symbol: pending.symbol,
    asOf,
    exitIntent: {
      kind: "EXIT",
      symbol: pending.symbol,
      protection: pending.protection,
      close: pending.triggerClose,
      fillId: pending.fillId,
      reason: "CLOSE_BELOW_FILL_FROZEN_SUPPORT",
      triggerDate: pending.triggerDate,
      decidedAt: pending.decidedAt,
      pending: true,
    },
  };
}

type WindowReturn = {
  symbolReturn: number;
  benchmarkReturn: number;
  excessReturn: number;
};

function alignedReturn(
  symbolBars: readonly (Bar | null)[],
  benchmarkBars: readonly (Bar | null)[],
  benchmarkByDate: ReadonlyMap<string, Bar>,
  decisionIndex: number,
  lookback: number,
): WindowReturn | null {
  const startIndex = decisionIndex - lookback;
  if (startIndex < 0) return null;
  const windowDates: string[] = [];
  for (let index = startIndex; index <= decisionIndex; index++) {
    const bar = symbolBars[index];
    if (!bar) return null;
    windowDates.push(bar.date);
  }
  // The benchmark must expose the same complete window one-for-one. Merely
  // containing the symbol dates is not enough: an extra or missing benchmark
  // day would otherwise let a shorter symbol window masquerade as aligned.
  if (benchmarkBars.length < lookback + 1) return null;
  const benchmarkWindow = benchmarkBars.slice(-(lookback + 1));
  if (benchmarkWindow.length !== windowDates.length) return null;
  for (let index = 0; index < windowDates.length; index++)
    if (benchmarkWindow[index]?.date !== windowDates[index]) return null;

  const benchmarkStart = benchmarkByDate.get(windowDates[0]!)?.close ?? null;
  const benchmarkEnd = benchmarkByDate.get(windowDates.at(-1)!)?.close ?? null;
  const symbolBar = symbolBars[decisionIndex];
  const symbolStart = symbolBars[startIndex];
  if (
    !symbolBar ||
    !symbolStart ||
    benchmarkStart === null ||
    benchmarkEnd === null ||
    benchmarkStart <= 0
  )
    return null;
  const symbolReturn = symbolBar.close / symbolStart.close - 1;
  const benchmarkReturn = benchmarkEnd / benchmarkStart - 1;
  return {
    symbolReturn,
    benchmarkReturn,
    excessReturn: symbolReturn - benchmarkReturn,
  };
}

/**
 * F02.07. Protection is evaluated before any watchlist, candidate or benchmark
 * availability check. A held symbol outside the frozen watchlist is still
 * protected by its actual fill-time support.
 */
export function livermoreWatchlistDecision(
  input: LivermoreWatchlistInput | null | undefined,
): LivermoreWatchlistResult {
  if (!input)
    return emptyLivermoreResult(
      "UNKNOWN",
      "watchlist input is missing",
      "",
      normalizeState(undefined),
    );

  // Validate the decision day and clock before replaying a pending exit, but
  // do not require the current close: F11-style morning carry is valid.
  const day = cnMarketDay(input.market, input.decisionDate, input.asOf);
  const state = normalizeState(input.state);
  const pendingExit = state.pendingExit ?? null;
  const position = input.position;

  const inconsistentPending = (detail: string): LivermoreWatchlistResult => ({
    ...emptyLivermoreResult(
      "UNKNOWN",
      "pending-exit-inconsistent",
      input.decisionDate,
      state,
      pendingExit?.protection ?? null,
      [
        livermoreIssue("PENDING_EXIT_INCONSISTENT", detail, {
          symbol: pendingExit?.symbol ?? null,
        }),
      ],
    ),
    symbol: pendingExit?.symbol ?? null,
    asOf: day.asOf,
  });

  /* --- 1. A host-carried EXIT is not a fill; keep it until actual flat. --- */
  if (pendingExit) {
    if (position === null) {
      // Explicit flat acknowledges the pending exit; continue as flat even if
      // the old evidence is now unverifiable.
    } else {
      let usesPending = position === undefined;
      if (position !== undefined) {
        if (!isNonEmptyString(position.fillId))
          throw new Error("position fillId must be non-empty");
        usesPending = position.fillId === pendingExit.fillId;
      }
      if (usesPending) {
        if (pendingExit.decidedAt > day.asOf)
          return inconsistentPending(
            "pending exit decidedAt is after the current decision clock",
          );
        if (pendingExit.triggerDate > input.decisionDate)
          return inconsistentPending(
            "pending exit triggerDate is after the current decision date",
          );
        if (pendingExit.triggerClose >= pendingExit.protection)
          return inconsistentPending(
            "pending exit triggerClose is not below its protection",
          );
        // The original trigger bar must have been complete at the original
        // decision clock; a same-day morning "close" is not a known exit.
        if (
          !completedBarFilter(
            "day",
            pendingExit.decidedAt,
          )(pendingExit.triggerDate)
        )
          return inconsistentPending(
            "pending exit trigger bar was not completed at its original decision clock",
          );
        if (position !== undefined) {
          if (!isNonEmptyString(position.symbol))
            throw new Error("position symbol must be non-empty");
          if (position.symbol !== pendingExit.symbol)
            return inconsistentPending(
              "pending exit symbol conflicts with the actual fill symbol",
            );
        }
        return pendingExitResult(
          input.decisionDate,
          state,
          pendingExit,
          day.asOf,
        );
      }
      // A different actual fill must not inherit the previous pending exit.
    }
  }

  /* --- 2. Actual position without a matching pending exit. -------------- */
  if (position) {
    if (!isNonEmptyString(position.symbol))
      throw new Error("position symbol must be non-empty");
    if (!isFiniteNumber(position.lower) || position.lower <= 0)
      throw new Error("position lower support must be finite positive");
    if (!isNonEmptyString(position.fillId))
      throw new Error("position fillId must be non-empty");
    // F02 is a current-close decision, so the decision day must be complete.
    const clock = cnDecisionClock(input.market, input.decisionDate, input.asOf);
    const asOf = clock.asOf;
    const stop = decisionBarForStop(position.bars, input.decisionDate);
    const positionState: LivermoreWatchlistState = {
      ...state,
      pendingExit: null,
    };
    if (stop.ambiguous) {
      return {
        ...emptyLivermoreResult(
          "UNKNOWN",
          "ambiguous-decision-bar",
          input.decisionDate,
          positionState,
          position.lower,
          [
            livermoreIssue(
              "AMBIGUOUS_DECISION_BAR",
              "held position has duplicate decision-day bars",
              { symbol: position.symbol },
            ),
          ],
        ),
        symbol: position.symbol,
        asOf,
      };
    }
    if (!stop.bar) {
      return {
        ...emptyLivermoreResult(
          "UNKNOWN",
          "position-close-unknown",
          input.decisionDate,
          positionState,
          position.lower,
          [
            livermoreIssue(
              "POSITION_CLOSE_UNKNOWN",
              "held position has no trustworthy decision-day close; a stale close is not used",
              { symbol: position.symbol },
            ),
          ],
        ),
        symbol: position.symbol,
        asOf,
      };
    }
    if (stop.bar.close < position.lower) {
      const pending: LivermorePendingExit = {
        fillId: position.fillId,
        symbol: position.symbol,
        protection: position.lower,
        triggerDate: input.decisionDate,
        triggerClose: stop.bar.close,
        decidedAt: asOf,
      };
      return {
        ...emptyLivermoreResult(
          "EXIT",
          "close-below-fill-frozen-support",
          input.decisionDate,
          { ...positionState, pendingExit: pending },
          position.lower,
        ),
        symbol: position.symbol,
        asOf,
        exitIntent: {
          kind: "EXIT",
          symbol: position.symbol,
          protection: position.lower,
          close: stop.bar.close,
          fillId: position.fillId,
          reason: "CLOSE_BELOW_FILL_FROZEN_SUPPORT",
          triggerDate: input.decisionDate,
          decidedAt: asOf,
          pending: false,
        },
      };
    }
    return {
      ...emptyLivermoreResult(
        "HOLD",
        "position-held-no-add",
        input.decisionDate,
        positionState,
        position.lower,
      ),
      symbol: position.symbol,
      asOf,
    };
  }

  /* --- 3. Flat watchlist: entry parameters are validated only here. ----- */
  const clock = cnDecisionClock(input.market, input.decisionDate, input.asOf);
  const asOf = clock.asOf;
  if (!isPositiveInteger(input.lookback))
    throw new Error("lookback must be a positive integer");
  if (!isNonNegativeInteger(input.maxCandidateAge))
    throw new Error("maxCandidateAge must be a non-negative integer");
  const flatState: LivermoreWatchlistState = { ...state, pendingExit: null };
  const issues: LivermoreWatchlistIssue[] = [];
  const universe = input.universe;
  const benchmark = input.benchmark;
  if (!universe) {
    issues.push(
      livermoreIssue("UNIVERSE_MISSING", "frozen watchlist is missing"),
    );
    return {
      ...emptyLivermoreResult(
        "UNKNOWN",
        "watchlist-universe-missing",
        input.decisionDate,
        flatState,
        null,
        issues,
      ),
      asOf,
    };
  }
  const universeFrozenAt = confirmationEpoch(universe.frozenAt);
  if (universeFrozenAt === null)
    throw new Error("watchlist frozenAt must carry an explicit timezone");
  if (universeFrozenAt > clock.decisionCutoff)
    throw new Error("watchlist frozenAt must not postdate the decision cutoff");
  if (!Array.isArray(universe.members))
    throw new Error("watchlist members must be an array");

  const seriesBySymbol = new Map<string, (Bar | null)[]>();
  for (const member of universe.members) {
    if (!member || !isNonEmptyString(member.symbol))
      throw new Error("watchlist member symbol must be non-empty");
    if (seriesBySymbol.has(member.symbol))
      throw new Error(`duplicate watchlist member ${member.symbol}`);
    seriesBySymbol.set(
      member.symbol,
      dailyPrefix(member.bars, input.decisionDate, true),
    );
  }

  let benchmarkBars: (Bar | null)[] | null = null;
  let benchmarkByDate: Map<string, Bar> | null = null;
  if (benchmark) {
    const benchmarkFrozenAt = confirmationEpoch(benchmark.frozenAt);
    if (benchmarkFrozenAt === null)
      throw new Error("benchmark frozenAt must carry an explicit timezone");
    if (benchmarkFrozenAt > clock.decisionCutoff)
      throw new Error(
        "benchmark frozenAt must not postdate the decision cutoff",
      );
    if (!isNonEmptyString(benchmark.symbol))
      throw new Error("benchmark symbol must be non-empty");
    benchmarkBars = dailyPrefix(benchmark.bars, input.decisionDate, true);
    benchmarkByDate = barByDate(benchmarkBars);
  } else {
    issues.push(livermoreIssue("BENCHMARK_MISSING", "benchmark is missing"));
  }

  const resolved = resolveAnchors(input.anchors ?? []);
  issues.push(...resolved.issues);
  const consumed = new Set(flatState.consumedAnchorIds);
  const pending = new Set(flatState.pendingEnterAnchorIds);
  const candidates: LivermoreCandidateEvaluation[] = [];
  let trigger: AnchorRun | null = null;
  let triggerClose = 0;
  let triggerPreviousClose = 0;
  let triggerExcess = 0;

  for (const run of resolved.runs) {
    const evaluation: LivermoreCandidateEvaluation = {
      anchorId: run.anchor.anchorId,
      symbol: run.symbol,
      status: "UNKNOWN",
      reason: "",
      age: null,
      close: null,
      previousClose: null,
      symbolReturn: null,
      benchmarkReturn: null,
      excessReturn: null,
      upper: run.anchor.upper,
      lower: run.anchor.lower,
      confirmedBarDate: run.anchor.confirmedBarDate,
      confirmedAt: run.confirmedAt,
    };
    candidates.push(evaluation);

    if (consumed.has(run.anchor.anchorId)) {
      evaluation.status = "CONSUMED";
      evaluation.reason = "anchor-already-consumed";
      continue;
    }
    const series = seriesBySymbol.get(run.symbol);
    if (!series) {
      evaluation.reason = "symbol-not-in-frozen-watchlist";
      issues.push(
        livermoreIssue(
          "ANCHOR_SYMBOL_NOT_IN_WATCHLIST",
          "anchor symbol is absent from the frozen watchlist",
          { anchorId: run.anchor.anchorId, symbol: run.symbol },
        ),
      );
      continue;
    }
    if (run.anchor.confirmedBarDate > input.decisionDate) {
      evaluation.reason = "confirmed-after-decision";
      issues.push(
        livermoreIssue(
          "ANCHOR_CONFIRMED_AFTER_DECISION",
          "anchor is not knowable by the decision date",
          { anchorId: run.anchor.anchorId, symbol: run.symbol },
        ),
      );
      continue;
    }
    if (run.confirmedAt > clock.decisionCutoff) {
      evaluation.reason = "confirmed-after-decision-cutoff";
      issues.push(
        livermoreIssue(
          "ANCHOR_CONFIRMED_AFTER_CUTOFF",
          "anchor confirmation postdates the decision cutoff",
          { anchorId: run.anchor.anchorId, symbol: run.symbol },
        ),
      );
      continue;
    }
    const confirmedIndex = indexOfDate(series, run.anchor.confirmedBarDate);
    const decisionIndex = indexOfDate(series, input.decisionDate);
    if (confirmedIndex < 0 || decisionIndex < 0) {
      evaluation.reason =
        confirmedIndex < 0
          ? "confirmation-bar-not-in-series"
          : "decision-bar-missing";
      issues.push(
        livermoreIssue("ANCHOR_NOT_IN_SERIES", evaluation.reason, {
          anchorId: run.anchor.anchorId,
          symbol: run.symbol,
        }),
      );
      continue;
    }
    const age = decisionIndex - confirmedIndex;
    evaluation.age = age;
    const decisionBar = series[decisionIndex];
    if (!decisionBar) {
      evaluation.reason = "decision-bar-missing";
      continue;
    }
    evaluation.close = decisionBar.close;

    // Known candidate invalidation is independent of the benchmark.
    if (age > input.maxCandidateAge) {
      consumed.add(run.anchor.anchorId);
      evaluation.status = "EXPIRED";
      evaluation.reason = "candidate-age-exceeded";
      continue;
    }
    if (decisionBar.close < run.anchor.lower) {
      consumed.add(run.anchor.anchorId);
      evaluation.status = "BELOW_PROTECTION";
      evaluation.reason = "close-below-anchor-support";
      continue;
    }

    const previousBar = decisionIndex > 0 ? series[decisionIndex - 1] : null;
    if (!previousBar) {
      evaluation.reason = "previous-bar-missing";
      continue;
    }
    evaluation.previousClose = previousBar.close;

    if (!benchmarkByDate || !benchmarkBars) {
      evaluation.reason = "benchmark-missing";
      continue;
    }
    const window = alignedReturn(
      series,
      benchmarkBars,
      benchmarkByDate,
      decisionIndex,
      input.lookback,
    );
    if (!window) {
      evaluation.reason = "benchmark-window-unavailable";
      issues.push(
        livermoreIssue(
          "BENCHMARK_WINDOW_UNAVAILABLE",
          "symbol and benchmark do not share a complete return window",
          { anchorId: run.anchor.anchorId, symbol: run.symbol },
        ),
      );
      continue;
    }
    evaluation.symbolReturn = clean(window.symbolReturn);
    evaluation.benchmarkReturn = clean(window.benchmarkReturn);
    evaluation.excessReturn = clean(window.excessReturn);

    if (pending.has(run.anchor.anchorId)) {
      evaluation.status = "PENDING";
      evaluation.reason = "enter-intent-already-pending";
      continue;
    }
    if (window.excessReturn <= 0) {
      evaluation.status = "WAIT";
      evaluation.reason = "not-a-leader";
      continue;
    }
    if (
      decisionBar.close > run.anchor.upper &&
      previousBar.close <= run.anchor.upper
    ) {
      evaluation.status = "TRIGGER";
      evaluation.reason = "leader-crossed-confirmed-resistance";
      if (!trigger) {
        trigger = run;
        triggerClose = decisionBar.close;
        triggerPreviousClose = previousBar.close;
        triggerExcess = window.excessReturn;
      }
      continue;
    }
    evaluation.status = "WAIT";
    evaluation.reason = "no-close-cross-above-resistance";
  }

  const nextConsumed = [...consumed].sort(compareText);
  const nextPending = [...pending];
  if (trigger) {
    nextConsumed.push(trigger.anchor.anchorId);
    nextPending.push(trigger.anchor.anchorId);
    const uniqueConsumed = [...new Set(nextConsumed)].sort(compareText);
    const uniquePending = [...new Set(nextPending)].sort(compareText);
    return {
      status: "ENTER",
      reason: "leader-crossed-confirmed-resistance",
      symbol: trigger.symbol,
      anchorId: trigger.anchor.anchorId,
      protection: trigger.anchor.lower,
      asOf,
      decisionDate: input.decisionDate,
      state: {
        consumedAnchorIds: uniqueConsumed,
        pendingEnterAnchorIds: uniquePending,
        pendingExit: null,
      },
      enterIntent: {
        kind: "ENTER",
        anchorId: trigger.anchor.anchorId,
        symbol: trigger.symbol,
        upper: trigger.anchor.upper,
        lower: trigger.anchor.lower,
        protection: trigger.anchor.lower,
        triggerClose,
        previousClose: triggerPreviousClose,
        excessReturn: clean(triggerExcess),
        decisionDate: input.decisionDate,
        asOf,
      },
      exitIntent: null,
      candidates,
      issues: sortLivermoreIssues(issues),
    };
  }

  const nextState: LivermoreWatchlistState = {
    consumedAnchorIds: nextConsumed,
    pendingEnterAnchorIds: [...new Set(nextPending)].sort(compareText),
    pendingExit: null,
  };
  const unknownCandidate = candidates.some(
    (candidate) =>
      candidate.status === "UNKNOWN" &&
      candidate.reason !== "anchor-already-consumed",
  );
  const incompleteEvidence =
    unknownCandidate || !benchmarkByDate || issues.length > 0;
  return {
    status: incompleteEvidence ? "UNKNOWN" : "WAIT",
    reason: incompleteEvidence
      ? "candidate-evidence-incomplete"
      : "no-enter-trigger",
    symbol: null,
    anchorId: null,
    protection: null,
    asOf,
    decisionDate: input.decisionDate,
    state: nextState,
    enterIntent: null,
    exitIntent: null,
    candidates,
    issues: sortLivermoreIssues(issues),
  };
}

/* ------------------------------------------------------------------------- */
/* F11.02 trend-leader selection                                              */
/* ------------------------------------------------------------------------- */

export type ThemeMemberSeries = {
  symbol: string;
  bars: readonly (Bar | null)[];
};

export type ThemeLeaderParams = {
  /** L: excess-return and drawdown window. */
  excessLookback: number;
  /** n: fast MA window. */
  fastMa: number;
  /** m: slow MA window. */
  slowMa: number;
  /** q: top fraction in (0, 1]. */
  rankFraction: number;
  /** d: maximum close-to-close drawdown over L, in [0, 1]. */
  maxDrawdown: number;
  /** k: MA_m comparison lag and consecutive rank-out periods. */
  stablePeriods: number;
  /** a0: minimum decision-day (yesterday) amount. */
  minAmount: number;
};

export type ThemeLeaderState = {
  candidateSymbol: string | null;
  /** Consecutive completed decision periods outside the top q. */
  rankOutStreak: number;
  /** Last decision date actually evaluated; replaying it must not advance. */
  lastEvaluatedDate: string | null;
  /** Latest completed bar date used by that evaluation. */
  lastEvaluatedBarDate: string | null;
};

export type ThemeLeaderInput = {
  /** This component is limited to CN daily bars in this batch. */
  market: "cn-equity";
  /**
   * Decision clock on the same Shanghai market day. It may be before the
   * current close because F11 uses only the previous completed day.
   */
  asOf: ConfirmationTime;
  decisionDate: string;
  params: ThemeLeaderParams;
  theme?: {
    themeId: string;
    frozenAt: ConfirmationTime;
    members: readonly ThemeMemberSeries[];
  } | null;
  benchmark?: {
    symbol: string;
    frozenAt: ConfirmationTime;
    bars: readonly (Bar | null)[];
  } | null;
  state?: ThemeLeaderState;
};

export type ThemeMemberMetrics = {
  symbol: string;
  status: "COMPLETE" | "UNKNOWN";
  latestDate: string | null;
  close: number | null;
  maFast: number | null;
  maSlow: number | null;
  maSlowPrior: number | null;
  periodReturn: number | null;
  benchmarkReturn: number | null;
  excessReturn: number | null;
  maxDrawdown: number | null;
  amount: number | null;
  rank: number | null;
  trendEligible: boolean;
  /** MA structure plus drawdown and amount: required for a new selection. */
  selectionEligible: boolean;
  rankEligible: boolean;
  reasons: readonly string[];
};

export type ThemeLeaderSelection = {
  symbol: string;
  rank: number;
  metrics: ThemeMemberMetrics;
};

export type ThemeLeaderIssueCode =
  | "THEME_MISSING"
  | "BENCHMARK_MISSING"
  | "INCOMPLETE_POOL"
  | "CANDIDATE_NOT_IN_FROZEN_POOL";

export type ThemeLeaderIssue = {
  code: ThemeLeaderIssueCode;
  severity: "UNKNOWN" | "INFO";
  symbol: string | null;
  detail: string;
};

export type ThemeLeaderResult = {
  status: "LEADER" | "KEEP" | "NONE" | "UNKNOWN";
  decisionDate: string;
  themeId: string | null;
  leader: ThemeLeaderSelection | null;
  members: readonly ThemeMemberMetrics[];
  state: ThemeLeaderState;
  issues: readonly ThemeLeaderIssue[];
};

function themeIssue(
  code: ThemeLeaderIssueCode,
  detail: string,
  symbol: string | null = null,
): ThemeLeaderIssue {
  return { code, severity: "UNKNOWN", symbol, detail };
}

function normalizeThemeState(
  state: ThemeLeaderState | undefined,
): ThemeLeaderState {
  const candidateSymbol = state?.candidateSymbol ?? null;
  const rankOutStreak = state?.rankOutStreak ?? 0;
  const lastEvaluatedDate = state?.lastEvaluatedDate ?? null;
  const lastEvaluatedBarDate = state?.lastEvaluatedBarDate ?? null;
  if (candidateSymbol !== null && !isNonEmptyString(candidateSymbol))
    throw new Error("theme candidate symbol must be null or non-empty");
  if (!isNonNegativeInteger(rankOutStreak))
    throw new Error("theme rankOutStreak must be a non-negative integer");
  if (lastEvaluatedDate !== null && dailyBarEpoch(lastEvaluatedDate) === null)
    throw new Error("theme lastEvaluatedDate must be a real day");
  if (
    lastEvaluatedBarDate !== null &&
    dailyBarEpoch(lastEvaluatedBarDate) === null
  )
    throw new Error("theme lastEvaluatedBarDate must be a real day");
  if ((lastEvaluatedDate === null) !== (lastEvaluatedBarDate === null))
    throw new Error(
      "theme state must carry both last evaluated dates or neither",
    );
  return {
    candidateSymbol,
    rankOutStreak,
    lastEvaluatedDate,
    lastEvaluatedBarDate,
  };
}

function emptyThemeResult(
  status: "LEADER" | "KEEP" | "NONE" | "UNKNOWN",
  decisionDate: string,
  themeId: string | null,
  state: ThemeLeaderState,
  issues: ThemeLeaderIssue[] = [],
): ThemeLeaderResult {
  return {
    status,
    decisionDate,
    themeId,
    leader: null,
    members: [],
    state,
    issues: [...issues].sort(
      (left, right) =>
        compareText(left.code, right.code) ||
        compareText(left.symbol ?? "", right.symbol ?? "") ||
        compareText(left.detail, right.detail),
    ),
  };
}

type ThemeEvaluation = {
  metrics: ThemeMemberMetrics;
};

/** Known MA_m break from a candidate's own completed closes only. */
function candidateSlowMaBreak(
  bars: readonly (Bar | null)[],
  slowMa: number,
): boolean | null {
  if (!recentComplete(bars, slowMa)) return null;
  const barsArray = bars.filter((bar): bar is Bar => bar !== null);
  const latest = barsArray.at(-1);
  const slow = finiteMa(ma(barsArray, slowMa).at(-1));
  if (!latest || slow === null) return null;
  return latest.close < slow;
}

/**
 * F11.02 theme leader selection. Only completed closes strictly before the
 * decision date are used. The frozen pool must be fully rankable; a missing
 * member keeps the pool UNKNOWN instead of silently shrinking it. An existing
 * candidate is cancelled only by a known close below MA_m or k consecutive
 * rank-outs, never by a single fast-MA or amount shortfall.
 */
export function themeLeaderSelection(
  input: ThemeLeaderInput | null | undefined,
): ThemeLeaderResult {
  if (!input)
    return emptyThemeResult(
      "UNKNOWN",
      "",
      null,
      normalizeThemeState(undefined),
      [themeIssue("THEME_MISSING", "theme input is missing")],
    );

  // F11 reads only the previous completed day, so it is usable in the current
  // morning. The decision day itself is not required to be closed.
  const clock = cnMarketDay(input.market, input.decisionDate, input.asOf);
  const params = input.params;
  if (!params || typeof params !== "object")
    throw new Error("theme params are required");
  if (!isPositiveInteger(params.excessLookback))
    throw new Error("excessLookback must be a positive integer");
  if (!isPositiveInteger(params.fastMa))
    throw new Error("fastMa must be a positive integer");
  if (!isPositiveInteger(params.slowMa) || params.slowMa <= params.fastMa)
    throw new Error("slowMa must be a positive integer greater than fastMa");
  if (
    !isFiniteNumber(params.rankFraction) ||
    params.rankFraction <= 0 ||
    params.rankFraction > 1
  )
    throw new Error("rankFraction must be in (0, 1]");
  if (
    !isFiniteNumber(params.maxDrawdown) ||
    params.maxDrawdown < 0 ||
    params.maxDrawdown > 1
  )
    throw new Error("maxDrawdown must be in [0, 1]");
  if (!isPositiveInteger(params.stablePeriods))
    throw new Error("stablePeriods must be a positive integer");
  if (!isFiniteNumber(params.minAmount) || params.minAmount < 0)
    throw new Error("minAmount must be finite non-negative");

  const state = normalizeThemeState(input.state);
  if (
    state.lastEvaluatedDate !== null &&
    state.lastEvaluatedDate > input.decisionDate
  )
    throw new Error("theme state decision date is ahead of this decision");
  const theme = input.theme;
  if (!theme)
    return emptyThemeResult("UNKNOWN", input.decisionDate, null, state, [
      themeIssue("THEME_MISSING", "frozen theme is missing"),
    ]);
  if (!isNonEmptyString(theme.themeId))
    throw new Error("themeId must be non-empty");
  const themeFrozenAt = confirmationEpoch(theme.frozenAt);
  if (themeFrozenAt === null)
    throw new Error("theme frozenAt must carry an explicit timezone");
  if (themeFrozenAt > clock.asOf)
    throw new Error("theme frozenAt must not postdate asOf");
  if (!Array.isArray(theme.members) || theme.members.length === 0)
    return emptyThemeResult(
      "UNKNOWN",
      input.decisionDate,
      theme.themeId,
      state,
      [themeIssue("INCOMPLETE_POOL", "frozen theme has no members")],
    );

  const members: { symbol: string; bars: (Bar | null)[] }[] = [];
  const symbols = new Set<string>();
  for (const member of theme.members) {
    if (!member || !isNonEmptyString(member.symbol))
      throw new Error("theme member symbol must be non-empty");
    if (symbols.has(member.symbol))
      throw new Error(`duplicate theme member ${member.symbol}`);
    symbols.add(member.symbol);
    members.push({
      symbol: member.symbol,
      bars: dailyPrefix(member.bars, input.decisionDate, false),
    });
  }

  /**
   * Ranking is unavailable, but a known candidate MA_m break is still a known
   * cancellation. It must not be shielded by a benchmark or pool gap.
   */
  const unknownPool = (issue: ThemeLeaderIssue): ThemeLeaderResult => {
    let nextState = state;
    let finalIssue = issue;
    if (state.candidateSymbol !== null) {
      const candidate = members.find(
        (member) => member.symbol === state.candidateSymbol,
      );
      if (!candidate) {
        finalIssue = themeIssue(
          "CANDIDATE_NOT_IN_FROZEN_POOL",
          "candidate is not a member of the frozen theme",
          state.candidateSymbol,
        );
      } else {
        const broken = candidateSlowMaBreak(candidate.bars, params.slowMa);
        if (broken === true)
          nextState = {
            ...state,
            candidateSymbol: null,
            rankOutStreak: 0,
          };
      }
    }
    const metrics: ThemeMemberMetrics[] = members.map((member) => {
      const latest = lastValidBar(member.bars);
      return {
        symbol: member.symbol,
        status: "UNKNOWN" as const,
        latestDate: latest?.date ?? null,
        close: latest?.close ?? null,
        maFast: null,
        maSlow: null,
        maSlowPrior: null,
        periodReturn: null,
        benchmarkReturn: null,
        excessReturn: null,
        maxDrawdown: null,
        amount: null,
        rank: null,
        trendEligible: false,
        selectionEligible: false,
        rankEligible: false,
        reasons: [
          finalIssue.code === "BENCHMARK_MISSING"
            ? "benchmark-missing"
            : "pool-incomplete",
        ],
      };
    });
    return {
      status: "UNKNOWN",
      decisionDate: input.decisionDate,
      themeId: theme.themeId,
      leader: null,
      members: metrics,
      state: nextState,
      issues: [finalIssue],
    };
  };

  const benchmark = input.benchmark;
  if (!benchmark)
    return unknownPool(themeIssue("BENCHMARK_MISSING", "benchmark is missing"));
  const benchmarkFrozenAt = confirmationEpoch(benchmark.frozenAt);
  if (benchmarkFrozenAt === null)
    throw new Error("benchmark frozenAt must carry an explicit timezone");
  if (benchmarkFrozenAt > clock.asOf)
    throw new Error("benchmark frozenAt must not postdate asOf");
  if (!isNonEmptyString(benchmark.symbol))
    throw new Error("benchmark symbol must be non-empty");

  const benchmarkPrefix = dailyPrefix(
    benchmark.bars,
    input.decisionDate,
    false,
  );
  const benchmarkByDate = barByDate(benchmarkPrefix);

  const needed = Math.max(
    params.excessLookback + 1,
    params.fastMa,
    params.slowMa + params.stablePeriods,
  );
  if (!members.every((member) => recentComplete(member.bars, needed)))
    return unknownPool(
      themeIssue(
        "INCOMPLETE_POOL",
        "a frozen member lacks enough completed history",
      ),
    );
  if (!recentComplete(benchmarkPrefix, needed))
    return unknownPool(
      themeIssue(
        "BENCHMARK_MISSING",
        "benchmark lacks the common completed window",
      ),
    );

  // The whole ranking window, not only the L return window, must share one
  // completed date sequence with the benchmark. A missing day is UNKNOWN; the
  // pool is never shrunk and no date is filled with a neutral value.
  const benchmarkDates = benchmarkPrefix.slice(-needed).map((bar) => bar!.date);
  const latestDate = benchmarkDates.at(-1)!;
  if (!completedBarFilter("day", clock.asOf)(latestDate))
    return unknownPool(
      themeIssue("INCOMPLETE_POOL", "latest used bar is not completed by asOf"),
    );
  for (const member of members) {
    const memberDates = member.bars.slice(-needed).map((bar) => bar!.date);
    if (
      memberDates.length !== benchmarkDates.length ||
      memberDates.some((date, index) => date !== benchmarkDates[index])
    )
      return unknownPool(
        themeIssue(
          "INCOMPLETE_POOL",
          "members and benchmark do not share the same completed calendar window",
        ),
      );
  }
  const commonWindowDates = benchmarkDates.slice(-(params.excessLookback + 1));

  const evaluations: ThemeEvaluation[] = members.map((member) => {
    const bars = member.bars.filter((bar): bar is Bar => bar !== null);
    const closes = bars.map((bar) => bar.close);
    const latest = bars.at(-1)!;
    const maFast = requiredMa(bars, params.fastMa);
    const maSlow = requiredMa(bars, params.slowMa);
    const maSlowPrior = requiredMa(bars, params.slowMa, params.stablePeriods);
    const windowStart = closes.length - (params.excessLookback + 1);
    const periodCloses = closes.slice(windowStart);
    const periodReturn = latest.close / periodCloses[0]! - 1;
    const startDate = commonWindowDates[0]!;
    const benchmarkStart = benchmarkByDate.get(startDate)!.close;
    const benchmarkEnd = benchmarkByDate.get(latest.date)!.close;
    const benchmarkReturn = benchmarkEnd / benchmarkStart - 1;
    const maxDrawdown = closeDrawdown(periodCloses);
    const amount = latest.amount;
    const trendEligible =
      latest.close > maFast && maFast > maSlow && maSlow > maSlowPrior;
    const drawdownEligible = maxDrawdown <= params.maxDrawdown;
    const amountEligible = amount >= params.minAmount;
    const selectionEligible =
      trendEligible && drawdownEligible && amountEligible;
    const reasons: string[] = [];
    if (latest.close <= maFast) reasons.push("close-not-above-fast-ma");
    if (maFast <= maSlow) reasons.push("fast-ma-not-above-slow-ma");
    if (maSlow <= maSlowPrior)
      reasons.push("slow-ma-not-rising-over-stable-periods");
    if (!drawdownEligible) reasons.push("drawdown-above-limit");
    if (!amountEligible) reasons.push("amount-below-minimum");
    return {
      metrics: {
        symbol: member.symbol,
        status: "COMPLETE" as const,
        latestDate: latest.date,
        close: clean(latest.close),
        maFast: clean(maFast),
        maSlow: clean(maSlow),
        maSlowPrior: clean(maSlowPrior),
        periodReturn: clean(periodReturn),
        benchmarkReturn: clean(benchmarkReturn),
        excessReturn: clean(periodReturn - benchmarkReturn),
        maxDrawdown: clean(maxDrawdown),
        amount: clean(amount),
        rank: null,
        trendEligible,
        selectionEligible,
        rankEligible: false,
        reasons,
      },
    };
  });

  const ranked = [...evaluations].sort(
    (left, right) =>
      right.metrics.excessReturn! - left.metrics.excessReturn! ||
      right.metrics.amount! - left.metrics.amount! ||
      compareText(left.metrics.symbol, right.metrics.symbol),
  );
  const threshold = Math.max(1, Math.ceil(params.rankFraction * ranked.length));
  ranked.forEach((evaluation, index) => {
    evaluation.metrics.rank = index + 1;
    evaluation.metrics.rankEligible =
      index + 1 <= threshold && evaluation.metrics.selectionEligible;
  });
  const bySymbol = new Map(
    evaluations.map((evaluation) => [evaluation.metrics.symbol, evaluation]),
  );

  const current = state.candidateSymbol;
  if (current !== null && !bySymbol.has(current)) {
    return {
      status: "UNKNOWN",
      decisionDate: input.decisionDate,
      themeId: theme.themeId,
      leader: null,
      members: evaluations.map((evaluation) => evaluation.metrics),
      state,
      issues: [
        themeIssue(
          "CANDIDATE_NOT_IN_FROZEN_POOL",
          "candidate is not a member of the frozen theme",
          current,
        ),
      ],
    };
  }

  /** Record one fully evaluated ranking day. Non-ranking days do not call it. */
  const evaluatedState = (
    candidateSymbol: string | null,
    rankOutStreak: number,
  ): ThemeLeaderState => ({
    candidateSymbol,
    rankOutStreak,
    lastEvaluatedDate: input.decisionDate,
    lastEvaluatedBarDate: latestDate,
  });

  const previousVisibleDate =
    benchmarkDates.length >= 2 ? benchmarkDates.at(-2)! : null;
  /**
   * A rank-out counts as consecutive only on the immediately next visible
   * completed day. Same decision date, same bar date, or an unknown gap does
   * not advance the streak; a gap starts a new chain at one.
   */
  const nextRankOutStreak = (): number => {
    if (state.lastEvaluatedDate === input.decisionDate)
      return state.rankOutStreak;
    if (state.lastEvaluatedBarDate === null) return 1;
    if (state.lastEvaluatedBarDate === latestDate) return state.rankOutStreak;
    if (state.lastEvaluatedBarDate !== previousVisibleDate) return 1;
    return state.rankOutStreak + 1;
  };
  const replacement = () =>
    ranked.find((candidate) => candidate.metrics.rankEligible) ?? null;

  let nextState: ThemeLeaderState;
  let status: ThemeLeaderResult["status"];
  let leader: ThemeLeaderSelection | null = null;

  if (current !== null) {
    const evaluation = bySymbol.get(current)!;
    const metrics = evaluation.metrics;
    // Known protection only: MA_m break or k consecutive rank-outs. A single
    // fast-MA, drawdown or amount shortfall never cancels an existing candidate.
    if (metrics.close! < metrics.maSlow!) {
      const next = replacement();
      if (next) {
        status = "LEADER";
        nextState = evaluatedState(next.metrics.symbol, 0);
        leader = {
          symbol: next.metrics.symbol,
          rank: next.metrics.rank!,
          metrics: next.metrics,
        };
      } else {
        status = "NONE";
        nextState = evaluatedState(null, 0);
      }
    } else if (metrics.rank! <= threshold) {
      nextState = evaluatedState(current, 0);
      status = "KEEP";
      leader = { symbol: current, rank: metrics.rank!, metrics };
    } else {
      const streak = nextRankOutStreak();
      if (streak >= params.stablePeriods) {
        const next = replacement();
        if (next) {
          status = "LEADER";
          nextState = evaluatedState(next.metrics.symbol, 0);
          leader = {
            symbol: next.metrics.symbol,
            rank: next.metrics.rank!,
            metrics: next.metrics,
          };
        } else {
          status = "NONE";
          nextState = evaluatedState(null, 0);
        }
      } else {
        nextState = evaluatedState(current, streak);
        status = "KEEP";
        leader = { symbol: current, rank: metrics.rank!, metrics };
      }
    }
  } else {
    const next = replacement();
    if (next) {
      nextState = evaluatedState(next.metrics.symbol, 0);
      status = "LEADER";
      leader = {
        symbol: next.metrics.symbol,
        rank: next.metrics.rank!,
        metrics: next.metrics,
      };
    } else {
      nextState = evaluatedState(null, 0);
      status = "NONE";
    }
  }

  return {
    status,
    decisionDate: input.decisionDate,
    themeId: theme.themeId,
    leader,
    members: evaluations.map((evaluation) => evaluation.metrics),
    state: nextState,
    issues: [],
  };
}
