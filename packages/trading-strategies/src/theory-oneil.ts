/**
 * F09.04-F09.08 O'Neil components.
 *
 * These are rule-level components, not registered strategies. F09.05 P5/P6,
 * F09.06 P5 and F09.07 P6 do specify protection levels, but this module only
 * exposes candidate/pivot/protection; it does not execute a position or
 * portfolio contract. Manual endpoints and the upper F09.01 risk gate require
 * host binding. `exitRule: null` means no bound host executor is provided here,
 * not that the source rule lacks exits. No stop or position size is invented
 * beyond the explicit A-proxy stop parameters supplied by the caller.
 *
 * Source-fixed v2 thresholds are module constants and cannot be overridden by
 * caller parameters. A-proxy choices are explicit parameter objects with
 * pre-registered defaults; every evaluator validates them and echoes the values
 * actually used in the evidence.
 *
 * Endpoints are caller-frozen confirmed swings. A missing or not-yet-confirmed
 * endpoint returns UNKNOWN at the public boundary; malformed numeric input
 * (NaN, non-positive prices, invalid confirmation timestamps) throws. A breakout
 * must occur at or after every required structural confirmation. Equal
 * confirmation times cannot establish distinct pivots, so shape sequences
 * require strict chronological order.
 */
import { dailyBarEpoch } from "./theory-input.js";
import {
  confirmationEpoch,
  type ConfirmedSwingPoint,
  type ConfirmationTime,
} from "./theory-confirmation.js";

export type OneilStatus = "known" | "unknown" | "invalid";

export type OneilBreakout = {
  close: number;
  volume: number;
  priorAverageVolume: number | null;
  at: ConfirmationTime;
};

export type OneilCandidate = {
  branch: string;
  pivot: number;
  protection: number;
  triggered: boolean;
  /** No host-bound position/portfolio executor is provided by this component. */
  registerable: false;
  exitRule: null;
  capitalContract: null;
  evidence: Record<string, unknown>;
};

export type OneilResult = {
  status: OneilStatus;
  candidate: OneilCandidate | null;
  reason: string;
};

const result = (
  status: OneilStatus,
  reason: string,
  candidate: OneilCandidate | null = null,
): OneilResult => ({ status, candidate, reason });

type ResolvedPoint = { price: number; time: number };
type PointSpec = {
  point: ConfirmedSwingPoint | null | undefined;
  kind: ConfirmedSwingPoint["kind"];
  label: string;
};

type ResolveOutcome =
  { ok: true; points: ResolvedPoint[] } | { ok: false; error: OneilResult };

/** Missing/future endpoints become UNKNOWN; malformed values throw. */
function resolvePoints(
  asOf: number,
  specs: readonly PointSpec[],
): ResolveOutcome {
  const points: ResolvedPoint[] = [];
  for (const spec of specs) {
    if (!spec.point)
      return { ok: false, error: result("unknown", `${spec.label}-missing`) };
    if (spec.point.kind !== spec.kind)
      throw new Error(`${spec.label} must be a ${spec.kind} pivot`);
    const time = confirmationEpoch(spec.point.confirmedAt);
    if (time === null)
      throw new Error(`${spec.label} confirmation time is malformed`);
    if (!Number.isFinite(spec.point.price) || spec.point.price <= 0)
      throw new Error(`${spec.label} price must be finite positive`);
    if (time > asOf)
      return {
        ok: false,
        error: result("unknown", `${spec.label}-not-confirmed-by-asOf`),
      };
    points.push({ price: spec.point.price, time });
  }
  return { ok: true, points };
}

function asOfEpoch(value: ConfirmationTime) {
  const asOf = confirmationEpoch(value);
  if (asOf === null) throw new Error("asOf must carry an explicit timezone");
  return asOf;
}

function timeOf(value: ConfirmationTime, asOf: number, label: string) {
  const time = confirmationEpoch(value);
  if (time === null) throw new Error(`${label} time is malformed`);
  if (time > asOf) return null;
  return time;
}

function positive(value: number, label: string) {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${label} must be finite positive`);
  return value;
}

function fraction(value: number, label: string) {
  positive(value, label);
  if (value > 1) throw new Error(`${label} must not exceed 1`);
  return value;
}

function nonNegativeInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function breakoutCheck(
  breakout: OneilBreakout | null,
  pivot: number,
  volumeMultiple: number,
  chaseLimit: number,
  asOf: number,
  requiredConfirmedAt: number,
): {
  state: "none" | "waiting" | "triggered" | "unknown" | "invalid";
  reason: string;
} {
  positive(volumeMultiple, "breakoutVolumeMultiple");
  fraction(chaseLimit, "chaseLimit");
  if (!breakout) return { state: "none", reason: "breakout-not-observed" };
  const time = timeOf(breakout.at, asOf, "breakout");
  if (time === null) return { state: "unknown", reason: "breakout-after-asOf" };
  if (time < requiredConfirmedAt)
    return { state: "invalid", reason: "breakout-before-structure-confirmed" };
  positive(breakout.close, "breakout.close");
  if (!Number.isFinite(breakout.volume) || breakout.volume < 0)
    throw new Error("Breakout volume must be finite and non-negative");
  if (breakout.close <= pivot)
    return { state: "waiting", reason: "close-not-above-pivot" };
  if (
    breakout.priorAverageVolume === null ||
    !Number.isFinite(breakout.priorAverageVolume) ||
    breakout.priorAverageVolume <= 0
  )
    return { state: "unknown", reason: "breakout-volume-evidence-missing" };
  if (breakout.volume < volumeMultiple * breakout.priorAverageVolume)
    return { state: "waiting", reason: "volume-below-registered-multiple" };
  if ((breakout.close - pivot) / pivot > chaseLimit)
    return { state: "invalid", reason: "chase-limit-exceeded" };
  return { state: "triggered", reason: "registered-breakout" };
}

function withBreakout(
  candidate: Omit<OneilCandidate, "triggered">,
  breakout: OneilBreakout | null,
  volumeMultiple: number,
  chaseLimit: number,
  asOf: number,
  requiredConfirmedAt: number,
): OneilResult {
  const check = breakoutCheck(
    breakout,
    candidate.pivot,
    volumeMultiple,
    chaseLimit,
    asOf,
    requiredConfirmedAt,
  );
  if (check.state === "invalid") return result("invalid", check.reason);
  if (check.state === "unknown") return result("unknown", check.reason);
  return result(
    "known",
    check.reason,
    check.state === "triggered"
      ? { ...candidate, triggered: true }
      : { ...candidate, triggered: false },
  );
}

// Source-fixed v2 thresholds. These are not caller parameters.
const cupSource = {
  minPriorAdvance: 0.3,
  minWeeks: 6,
  maxWeeks: 65,
  minDepth: 0.08,
  maxDepth: 0.5,
} as const;
const doubleBottomSource = {
  minWeeks: 7,
  maxWeeks: 65,
  minDepth: 0.1,
  maxDepth: 0.5,
} as const;
const flatBaseSource = {
  minWeeks: 5,
  maxDepth: 0.15,
} as const;
const ascendingSource = {
  minWeeks: 9,
  maxWeeks: 16,
  minPullback: 0.1,
  maxPullback: 0.2,
  minPreBaseAdvance: 0.2,
} as const;
const flagSource = {
  maxPoleWeeks: 8,
  minPoleAdvance: 1,
  minFlagWeeks: 3,
  maxFlagWeeks: 5,
  maxFlagDrawdown: 0.25,
} as const;

// ---------------------------------------------------------------------------
// F09.04 Cup with handle / handle-less cup
// ---------------------------------------------------------------------------

/** A-proxy choices only; source-fixed thresholds live in `cupSource`. */
export type CupHandleParams = {
  /** A: handle maximum depth h. */
  handleMaxDepth: number;
  /** A: handle average volume <= this fraction of the pre-handle average. */
  handleVolumeShrink: number;
  /** A: breakout volume multiple v of the prior n-bar average. */
  breakoutVolumeMultiple: number;
  /** A: prior average-volume window n. */
  averageVolumeWindow: number;
  /** A: maximum chase above the pivot a. */
  chaseLimit: number;
  /** A: predefined no-handle protection distance below the cup rim. */
  noHandleProtectionFraction: number;
};

export const cupHandleParams: CupHandleParams = {
  handleMaxDepth: 0.12,
  handleVolumeShrink: 1,
  breakoutVolumeMultiple: 1.4,
  averageVolumeWindow: 50,
  chaseLimit: 0.05,
  noHandleProtectionFraction: 0.05,
};

export type CupHandleUEvidence = {
  bottomDwellWeeks: number;
  leftWeeks: number;
  rightWeeks: number;
  /** Two-day V-shaped crash/recovery is not this cup. */
  singleBarRecovery: boolean;
};

export type CupHandleInput = {
  asOf: ConfirmationTime;
  priorAdvanceStart: ConfirmedSwingPoint;
  leftHigh: ConfirmedSwingPoint;
  cupLow: ConfirmedSwingPoint;
  rightHigh: ConfirmedSwingPoint;
  weeks: number;
  uShape: CupHandleUEvidence | null;
  handle: {
    high: ConfirmedSwingPoint;
    low: ConfirmedSwingPoint;
    pivot: ConfirmedSwingPoint;
    averageVolume: number | null;
    priorAverageVolume: number | null;
  } | null;
  breakout: OneilBreakout | null;
};

function validateParams(params: CupHandleParams) {
  fraction(params.handleMaxDepth, "handleMaxDepth");
  positive(params.handleVolumeShrink, "handleVolumeShrink");
  positive(params.breakoutVolumeMultiple, "breakoutVolumeMultiple");
  positive(params.averageVolumeWindow, "averageVolumeWindow");
  fraction(params.chaseLimit, "chaseLimit");
  fraction(params.noHandleProtectionFraction, "noHandleProtectionFraction");
}

function validateUEvidence(evidence: CupHandleUEvidence, weeks: number) {
  const values = [
    evidence.bottomDwellWeeks,
    evidence.leftWeeks,
    evidence.rightWeeks,
  ];
  if (
    !values.every((value) => Number.isFinite(value) && value >= 0) ||
    typeof evidence.singleBarRecovery !== "boolean" ||
    evidence.bottomDwellWeeks <= 0 ||
    evidence.leftWeeks + evidence.rightWeeks > weeks ||
    evidence.bottomDwellWeeks > weeks
  )
    return "u-shape-evidence-invalid";
  return null;
}

/** P2-P5: cup geometry, U evidence, optional handle, then the registered breakout. */
export function evaluateOneilCupHandle(
  input: CupHandleInput,
  params: CupHandleParams = cupHandleParams,
): OneilResult {
  validateParams(params);
  const asOf = asOfEpoch(input.asOf);
  if (
    !Number.isFinite(input.weeks) ||
    input.weeks < cupSource.minWeeks ||
    input.weeks > cupSource.maxWeeks
  )
    return result("invalid", "cup-duration-outside-6-65-weeks");
  if (!input.uShape) return result("unknown", "u-shape-evidence-missing");
  const uShapeProblem = validateUEvidence(input.uShape, input.weeks);
  if (uShapeProblem) return result("unknown", uShapeProblem);
  if (input.uShape.singleBarRecovery)
    return result("invalid", "single-bar-recovery-not-cup");
  const resolved = resolvePoints(asOf, [
    { point: input.priorAdvanceStart, kind: "low", label: "priorAdvanceStart" },
    { point: input.leftHigh, kind: "high", label: "leftHigh" },
    { point: input.cupLow, kind: "low", label: "cupLow" },
    { point: input.rightHigh, kind: "high", label: "rightHigh" },
  ]);
  if (!resolved.ok) return resolved.error;
  const [start, left, low, right] = resolved.points as [
    ResolvedPoint,
    ResolvedPoint,
    ResolvedPoint,
    ResolvedPoint,
  ];
  if (!(
    start.time < left.time &&
    left.time < low.time &&
    low.time < right.time
  ))
    return result("invalid", "non-causal-cup-endpoint-order");
  const depth = (left.price - low.price) / left.price;
  if (depth < cupSource.minDepth || depth > cupSource.maxDepth)
    return result("invalid", "cup-depth-outside-8-50-percent");
  const advance = (left.price - start.price) / start.price;
  if (advance < cupSource.minPriorAdvance)
    return result("invalid", "prior-advance-below-30-percent");

  let branch: string;
  let pivot: number;
  let protection: number;
  let requiredConfirmedAt = right.time;
  const evidence: Record<string, unknown> = {
    cupDepth: depth,
    priorAdvance: advance,
    weeks: input.weeks,
    uShape: input.uShape,
    sourceThresholds: { ...cupSource },
    aParams: { ...params },
  };
  if (input.handle) {
    const handle = resolvePoints(asOf, [
      { point: input.handle.high, kind: "high", label: "handleHigh" },
      { point: input.handle.low, kind: "low", label: "handleLow" },
      { point: input.handle.pivot, kind: "high", label: "handlePivot" },
    ]);
    if (!handle.ok) return handle.error;
    const [handleHigh, handleLow, handlePivot] = handle.points as [
      ResolvedPoint,
      ResolvedPoint,
      ResolvedPoint,
    ];
    if (!(right.time < handleHigh.time && handleHigh.time < handleLow.time))
      return result("invalid", "non-causal-handle-order");
    if (!(
      handleHigh.time <= handlePivot.time && handlePivot.time <= handleLow.time
    ))
      return result("invalid", "handle-pivot-outside-handle-window");
    const midpoint = (left.price + low.price) / 2;
    if (handleLow.price <= midpoint)
      return result("invalid", "handle-low-not-in-upper-half");
    const handleDepth = (handleHigh.price - handleLow.price) / handleHigh.price;
    if (handleDepth > params.handleMaxDepth)
      return result("invalid", "handle-depth-above-A-limit");
    if (
      input.handle.averageVolume === null ||
      input.handle.priorAverageVolume === null ||
      !(input.handle.averageVolume > 0) ||
      !(input.handle.priorAverageVolume > 0)
    )
      return result("unknown", "handle-volume-evidence-missing");
    if (
      input.handle.averageVolume >
      params.handleVolumeShrink * input.handle.priorAverageVolume
    )
      return result("invalid", "handle-volume-not-shrinking");
    if (
      handlePivot.price < handleLow.price ||
      handlePivot.price > handleHigh.price
    )
      return result("invalid", "handle-pivot-outside-handle");
    branch = "cup-handle";
    pivot = handlePivot.price;
    protection = handleLow.price;
    requiredConfirmedAt = handleLow.time;
    Object.assign(evidence, {
      handleDepth,
      handleVolumeShrink: params.handleVolumeShrink,
    });
  } else {
    branch = "no-handle-cup";
    pivot = left.price;
    protection = left.price * (1 - params.noHandleProtectionFraction);
    Object.assign(evidence, {
      noHandleProtectionFraction: params.noHandleProtectionFraction,
      label: "A no-handle cup; not a cup-with-handle breakout",
    });
  }
  return withBreakout(
    {
      branch,
      pivot,
      protection,
      registerable: false,
      exitRule: null,
      capitalContract: null,
      evidence,
    },
    input.breakout,
    params.breakoutVolumeMultiple,
    params.chaseLimit,
    asOf,
    requiredConfirmedAt,
  );
}

// ---------------------------------------------------------------------------
// F09.05 Double bottom
// ---------------------------------------------------------------------------

export type DoubleBottomParams = {
  /** A: bars used to confirm an endpoint. */
  confirmationBars: number;
  breakoutVolumeMultiple: number;
  averageVolumeWindow: number;
  chaseLimit: number;
  /** A: cancellation window after L2 confirmation, entry candidates only. */
  waitBars: number;
  /** A: explicit protective stop below the pivot; never invented. */
  stopFraction: number;
};

export const doubleBottomParams: DoubleBottomParams = {
  confirmationBars: 3,
  breakoutVolumeMultiple: 1.4,
  averageVolumeWindow: 50,
  chaseLimit: 0.05,
  waitBars: 20,
  stopFraction: 0.07,
};

export type DoubleBottomInput = {
  asOf: ConfirmationTime;
  leftHigh: ConfirmedSwingPoint;
  firstLow: ConfirmedSwingPoint;
  middlePeak: ConfirmedSwingPoint;
  secondLow: ConfirmedSwingPoint;
  weeks: number;
  /** Bars from L2 confirmation to the breakout (if present) or to the latest observation. */
  barsSinceSecondLow: number;
  newLowAfterSecond: ConfirmedSwingPoint | null;
  marketCondition: boolean | null;
  breakout: OneilBreakout | null;
};

/** P1-P4: strict L2 < L1 W, pivot M; the second low must be confirmed first. */
export function evaluateOneilDoubleBottom(
  input: DoubleBottomInput,
  params: DoubleBottomParams = doubleBottomParams,
): OneilResult {
  nonNegativeInteger(params.confirmationBars, "confirmationBars");
  positive(params.breakoutVolumeMultiple, "breakoutVolumeMultiple");
  positive(params.averageVolumeWindow, "averageVolumeWindow");
  fraction(params.chaseLimit, "chaseLimit");
  nonNegativeInteger(params.waitBars, "waitBars");
  fraction(params.stopFraction, "stopFraction");
  const asOf = asOfEpoch(input.asOf);
  if (
    !Number.isFinite(input.weeks) ||
    input.weeks < doubleBottomSource.minWeeks ||
    input.weeks > doubleBottomSource.maxWeeks
  )
    return result("invalid", "double-bottom-duration-outside-7-65-weeks");
  const resolved = resolvePoints(asOf, [
    { point: input.leftHigh, kind: "high", label: "leftHigh" },
    { point: input.firstLow, kind: "low", label: "firstLow" },
    { point: input.middlePeak, kind: "high", label: "middlePeak" },
    { point: input.secondLow, kind: "low", label: "secondLow" },
  ]);
  if (!resolved.ok) return resolved.error;
  const [left, l1, middle, l2] = resolved.points as [
    ResolvedPoint,
    ResolvedPoint,
    ResolvedPoint,
    ResolvedPoint,
  ];
  if (!(left.time < l1.time && l1.time < middle.time && middle.time < l2.time))
    return result("invalid", "non-causal-double-bottom-order");
  if (!(middle.price < left.price))
    return result("invalid", "middle-peak-not-below-left-high");
  if (!(l2.price < l1.price))
    return result("invalid", "strict-double-bottom-requires-L2-below-L1");
  const depth = (left.price - Math.min(l1.price, l2.price)) / left.price;
  if (
    depth < doubleBottomSource.minDepth ||
    depth > doubleBottomSource.maxDepth
  )
    return result("invalid", "double-bottom-depth-outside-10-50-percent");
  nonNegativeInteger(input.barsSinceSecondLow, "barsSinceSecondLow");
  if (input.barsSinceSecondLow > params.waitBars)
    return result("invalid", "candidate-expired-before-breakout");
  const breakoutTime = input.breakout
    ? timeOf(input.breakout.at, asOf, "breakout")
    : null;
  if (input.newLowAfterSecond) {
    const newLow = resolvePoints(asOf, [
      {
        point: input.newLowAfterSecond,
        kind: "low",
        label: "newLowAfterSecond",
      },
    ]);
    if (!newLow.ok) return newLow.error;
    const point = newLow.points[0]!;
    if (
      point.time >= l2.time &&
      point.time <= (breakoutTime ?? asOf) &&
      point.price < l2.price
    )
      return result("invalid", "second-low-broken-before-breakout");
  }
  if (input.marketCondition === null)
    return result("unknown", "market-condition-unknown");
  if (!input.marketCondition) return result("known", "market-condition-failed");
  const pivot = middle.price,
    protection = pivot * (1 - params.stopFraction);
  return withBreakout(
    {
      branch: "double-bottom",
      pivot,
      protection,
      registerable: false,
      exitRule: null,
      capitalContract: null,
      evidence: {
        depth,
        weeks: input.weeks,
        L1: l1.price,
        L2: l2.price,
        barsSinceSecondLow: input.barsSinceSecondLow,
        sourceThresholds: { ...doubleBottomSource },
        aParams: { ...params },
      },
    },
    input.breakout,
    params.breakoutVolumeMultiple,
    params.chaseLimit,
    asOf,
    l2.time,
  );
}

// ---------------------------------------------------------------------------
// F09.06 Flat base / base on base
// ---------------------------------------------------------------------------

/** A-proxy choices only. Flat base has no source maximum duration. */
export type FlatBaseParams = {
  /** A but pre-registered: exactly 1.4 or 1.5, never chosen after results. */
  breakoutVolumeMultiple: 1.4 | 1.5;
  /** Source text uses a 50-day average; exposed rather than silently varied. */
  averageVolumeWindow: number;
  chaseLimit: number;
};

export const flatBaseParams: FlatBaseParams = {
  breakoutVolumeMultiple: 1.4,
  averageVolumeWindow: 50,
  chaseLimit: 0.05,
};

export type FlatBaseInput = {
  asOf: ConfirmationTime;
  weeks: number;
  high: ConfirmedSwingPoint;
  low: ConfirmedSwingPoint;
  /** Independent prior uptrend evidence; null -> UNKNOWN. */
  priorUptrend: boolean | null;
  breakout: OneilBreakout | null;
};

export function evaluateOneilFlatBase(
  input: FlatBaseInput,
  params: FlatBaseParams = flatBaseParams,
): OneilResult {
  if (
    params.breakoutVolumeMultiple !== 1.4 &&
    params.breakoutVolumeMultiple !== 1.5
  )
    throw new Error(
      "Flat-base breakout multiple is pre-registered as 1.4 or 1.5",
    );
  positive(params.averageVolumeWindow, "averageVolumeWindow");
  fraction(params.chaseLimit, "chaseLimit");
  const asOf = asOfEpoch(input.asOf);
  if (!Number.isFinite(input.weeks) || input.weeks < flatBaseSource.minWeeks)
    return result("invalid", "flat-base-duration-below-5-weeks");
  const resolved = resolvePoints(asOf, [
    { point: input.high, kind: "high", label: "high" },
    { point: input.low, kind: "low", label: "low" },
  ]);
  if (!resolved.ok) return resolved.error;
  const [high, low] = resolved.points as [ResolvedPoint, ResolvedPoint];
  if (!(high.time < low.time))
    return result("invalid", "non-causal-flat-base-order");
  if (high.price <= low.price)
    return result("invalid", "flat-base-invalid-range");
  const depth = (high.price - low.price) / high.price;
  if (depth > flatBaseSource.maxDepth)
    return result("invalid", "flat-base-depth-above-15-percent");
  if (input.priorUptrend === null)
    return result("unknown", "prior-advance-evidence-missing");
  if (!input.priorUptrend)
    return result("invalid", "no-independent-prior-uptrend");
  return withBreakout(
    {
      branch: "flat-base",
      pivot: high.price,
      protection: low.price,
      registerable: false,
      exitRule: null,
      capitalContract: null,
      evidence: {
        depth,
        weeks: input.weeks,
        sourceThresholds: {
          ...flatBaseSource,
          breakoutVolume: "1.4x or 1.5x 50-day average",
        },
        aParams: { ...params },
      },
    },
    input.breakout,
    params.breakoutVolumeMultiple,
    params.chaseLimit,
    asOf,
    low.time,
  );
}

export type BaseOnBaseParams = {
  /** A: maximum advance above P1 still treated as a tight base g. */
  maxAdvance: number;
  /** A: B2 low tolerance epsilon below P1. */
  lowTolerance: number;
  breakoutVolumeMultiple: 1.4 | 1.5;
  averageVolumeWindow: number;
  chaseLimit: number;
  waitBars: number;
};

export const baseOnBaseParams: BaseOnBaseParams = {
  maxAdvance: 0.1,
  lowTolerance: 0.03,
  breakoutVolumeMultiple: 1.4,
  averageVolumeWindow: 50,
  chaseLimit: 0.05,
  waitBars: 20,
};

export type BaseOnBaseInput = {
  asOf: ConfirmationTime;
  /** Confirmed first-base breakout price P1 and its confirmation time. */
  firstBreakout: { price: number; at: ConfirmationTime };
  /** Confirmed maximum advance high after P1; null -> unknown. */
  firstAdvanceHigh: { price: number; confirmedAt: ConfirmationTime } | null;
  base2: {
    high: ConfirmedSwingPoint;
    low: ConfirmedSwingPoint;
    confirmedAt: ConfirmationTime;
  };
  /** Bars from B2 confirmation to the breakout (if present) or latest observation. */
  barsSinceConfirmed: number;
  breakout: OneilBreakout | null;
};

/** P2-P6: a second tight base above P1, distinct from an unfinished B1 pullback. */
export function evaluateOneilBaseOnBase(
  input: BaseOnBaseInput,
  params: BaseOnBaseParams = baseOnBaseParams,
): OneilResult {
  if (
    params.breakoutVolumeMultiple !== 1.4 &&
    params.breakoutVolumeMultiple !== 1.5
  )
    throw new Error(
      "Base-on-base breakout multiple is pre-registered as 1.4 or 1.5",
    );
  fraction(params.maxAdvance, "maxAdvance");
  fraction(params.lowTolerance, "lowTolerance");
  positive(params.averageVolumeWindow, "averageVolumeWindow");
  fraction(params.chaseLimit, "chaseLimit");
  nonNegativeInteger(params.waitBars, "waitBars");
  const asOf = asOfEpoch(input.asOf);
  const firstAt = timeOf(input.firstBreakout.at, asOf, "firstBreakout");
  if (firstAt === null)
    return result("unknown", "first-breakout-not-confirmed-by-asOf");
  positive(input.firstBreakout.price, "firstBreakout.price");
  const p1 = input.firstBreakout.price;
  const resolved = resolvePoints(asOf, [
    { point: input.base2.high, kind: "high", label: "base2.high" },
    { point: input.base2.low, kind: "low", label: "base2.low" },
  ]);
  if (!resolved.ok) return resolved.error;
  const [high, low] = resolved.points as [ResolvedPoint, ResolvedPoint];
  const confirmed = timeOf(input.base2.confirmedAt, asOf, "base2.confirmedAt");
  if (confirmed === null)
    return result("unknown", "base2-not-confirmed-by-asOf");
  if (!(firstAt < high.time && high.time < low.time && low.time <= confirmed))
    return result("invalid", "non-causal-base-on-base-order");
  if (!input.firstAdvanceHigh)
    return result("unknown", "first-advance-evidence-missing");
  const advanceTime = timeOf(
    input.firstAdvanceHigh.confirmedAt,
    asOf,
    "firstAdvanceHigh",
  );
  if (advanceTime === null)
    return result("unknown", "first-advance-not-confirmed-by-asOf");
  positive(input.firstAdvanceHigh.price, "firstAdvanceHigh.price");
  if (advanceTime < firstAt || advanceTime > high.time)
    return result("invalid", "non-causal-first-advance-order");
  if (input.firstAdvanceHigh.price / p1 - 1 >= params.maxAdvance)
    return result("invalid", "subsequent-base-not-base-on-base");
  if (low.price < p1 * (1 - params.lowTolerance))
    return result("invalid", "base2-low-below-P1-tolerance");
  if (high.price <= low.price) return result("invalid", "base2-invalid-range");
  nonNegativeInteger(input.barsSinceConfirmed, "barsSinceConfirmed");
  if (input.barsSinceConfirmed > params.waitBars)
    return result("invalid", "candidate-expired-before-breakout");
  return withBreakout(
    {
      branch: "base-on-base",
      pivot: high.price,
      protection: low.price,
      registerable: false,
      exitRule: null,
      capitalContract: null,
      evidence: {
        p1,
        barsSinceConfirmed: input.barsSinceConfirmed,
        sourceThresholds: { note: "base-on-base relationship is an A proxy" },
        aParams: { ...params },
      },
    },
    input.breakout,
    params.breakoutVolumeMultiple,
    params.chaseLimit,
    asOf,
    confirmed,
  );
}

// ---------------------------------------------------------------------------
// F09.07 Ascending base / high tight flag
// ---------------------------------------------------------------------------

/** Source-fixed geometry; volume/chase remain explicit A choices. */
export type AscendingBaseParams = {
  breakoutVolumeMultiple: number;
  averageVolumeWindow: number;
  chaseLimit: number;
};

export const ascendingBaseParams: AscendingBaseParams = {
  breakoutVolumeMultiple: 1.4,
  averageVolumeWindow: 50,
  chaseLimit: 0.05,
};

export type AscendingBaseInput = {
  asOf: ConfirmationTime;
  weeks: number;
  /** Three confirmed highs and lows, H1 > L1, H2 > L2, H3 > L3 in time order. */
  points: readonly [
    { high: ConfirmedSwingPoint; low: ConfirmedSwingPoint },
    { high: ConfirmedSwingPoint; low: ConfirmedSwingPoint },
    { high: ConfirmedSwingPoint; low: ConfirmedSwingPoint },
  ];
  /** Advance from the prior base breakout, as a ratio; null -> UNKNOWN. */
  preBaseAdvance: number | null;
  breakout: OneilBreakout | null;
};

export function evaluateOneilAscendingBase(
  input: AscendingBaseInput,
  params: AscendingBaseParams = ascendingBaseParams,
): OneilResult {
  positive(params.breakoutVolumeMultiple, "breakoutVolumeMultiple");
  positive(params.averageVolumeWindow, "averageVolumeWindow");
  fraction(params.chaseLimit, "chaseLimit");
  const asOf = asOfEpoch(input.asOf);
  if (
    !Number.isFinite(input.weeks) ||
    input.weeks < ascendingSource.minWeeks ||
    input.weeks > ascendingSource.maxWeeks
  )
    return result("invalid", "ascending-base-duration-outside-9-16-weeks");
  const resolved = resolvePoints(
    asOf,
    input.points.flatMap((pair, index) => [
      {
        point: pair.high,
        kind: "high" as const,
        label: `points[${index}].high`,
      },
      { point: pair.low, kind: "low" as const, label: `points[${index}].low` },
    ]),
  );
  if (!resolved.ok) return resolved.error;
  const parsed = [0, 1, 2].map((index) => ({
    high: resolved.points[index * 2]!,
    low: resolved.points[index * 2 + 1]!,
  }));
  for (const pair of parsed)
    if (!(pair.high.time < pair.low.time))
      return result("invalid", "non-causal-ascending-pair-order");
  for (let i = 1; i < parsed.length; i++)
    if (!(parsed[i]!.high.time > parsed[i - 1]!.low.time))
      return result("invalid", "non-causal-ascending-order");
  for (const pair of parsed) {
    if (!(pair.high.price > pair.low.price))
      return result("invalid", "ascending-invalid-pullback-range");
    const retrace = (pair.high.price - pair.low.price) / pair.high.price;
    if (
      retrace < ascendingSource.minPullback ||
      retrace > ascendingSource.maxPullback
    )
      return result("invalid", "ascending-pullback-outside-10-20-percent");
  }
  for (let i = 1; i < parsed.length; i++)
    if (!(parsed[i]!.low.price > parsed[i - 1]!.low.price))
      return result("invalid", "ascending-lows-not-rising");
  if (input.preBaseAdvance === null)
    return result("unknown", "pre-base-advance-evidence-missing");
  if (
    !Number.isFinite(input.preBaseAdvance) ||
    input.preBaseAdvance < ascendingSource.minPreBaseAdvance
  )
    return result("invalid", "pre-base-advance-below-20-percent");
  const last = parsed.at(-1)!;
  return withBreakout(
    {
      branch: "ascending-base",
      pivot: last.high.price,
      protection: last.low.price,
      registerable: false,
      exitRule: null,
      capitalContract: null,
      evidence: {
        weeks: input.weeks,
        preBaseAdvance: input.preBaseAdvance,
        riskGroup: "oneil-ascending-base",
        sourceThresholds: { ...ascendingSource },
        aParams: { ...params },
      },
    },
    input.breakout,
    params.breakoutVolumeMultiple,
    params.chaseLimit,
    asOf,
    last.low.time,
  );
}

export type HighTightFlagParams = {
  breakoutVolumeMultiple: number;
  averageVolumeWindow: number;
  chaseLimit: number;
};

export const highTightFlagParams: HighTightFlagParams = {
  breakoutVolumeMultiple: 1.4,
  averageVolumeWindow: 50,
  chaseLimit: 0.05,
};

export type HighTightFlagInput = {
  asOf: ConfirmationTime;
  poleStart: ConfirmedSwingPoint;
  poleHigh: ConfirmedSwingPoint;
  poleWeeks: number;
  flagHigh: ConfirmedSwingPoint;
  flagLow: ConfirmedSwingPoint;
  flagWeeks: number;
  breakout: OneilBreakout | null;
};

/** A research version with UNVERIFIED_SOURCE O'Neil attribution. */
export function evaluateOneilHighTightFlag(
  input: HighTightFlagInput,
  params: HighTightFlagParams = highTightFlagParams,
): OneilResult {
  positive(params.breakoutVolumeMultiple, "breakoutVolumeMultiple");
  positive(params.averageVolumeWindow, "averageVolumeWindow");
  fraction(params.chaseLimit, "chaseLimit");
  const asOf = asOfEpoch(input.asOf);
  const resolved = resolvePoints(asOf, [
    { point: input.poleStart, kind: "low", label: "poleStart" },
    { point: input.poleHigh, kind: "high", label: "poleHigh" },
    { point: input.flagHigh, kind: "high", label: "flagHigh" },
    { point: input.flagLow, kind: "low", label: "flagLow" },
  ]);
  if (!resolved.ok) return resolved.error;
  const [start, pole, flagHigh, flagLow] = resolved.points as [
    ResolvedPoint,
    ResolvedPoint,
    ResolvedPoint,
    ResolvedPoint,
  ];
  if (!(
    start.time < pole.time &&
    pole.time < flagHigh.time &&
    flagHigh.time < flagLow.time
  ))
    return result("invalid", "non-causal-flag-order");
  if (
    !Number.isFinite(input.poleWeeks) ||
    input.poleWeeks <= 0 ||
    input.poleWeeks > flagSource.maxPoleWeeks
  )
    return result("invalid", "pole-outside-8-weeks");
  const advance = pole.price / start.price - 1;
  if (advance < flagSource.minPoleAdvance)
    return result("invalid", "pole-advance-below-100-percent");
  if (
    !Number.isFinite(input.flagWeeks) ||
    input.flagWeeks < flagSource.minFlagWeeks ||
    input.flagWeeks > flagSource.maxFlagWeeks
  )
    return result("invalid", "flag-outside-3-5-weeks");
  if (!(flagHigh.price > flagLow.price))
    return result("invalid", "flag-invalid-range");
  const drawdown = (flagHigh.price - flagLow.price) / flagHigh.price;
  if (drawdown > flagSource.maxFlagDrawdown)
    return result("invalid", "flag-drawdown-above-25-percent");
  return withBreakout(
    {
      branch: "high-tight-flag",
      pivot: pole.price,
      protection: flagLow.price,
      registerable: false,
      exitRule: null,
      capitalContract: null,
      evidence: {
        advance,
        poleWeeks: input.poleWeeks,
        flagWeeks: input.flagWeeks,
        drawdown,
        riskGroup: "oneil-high-tight-flag",
        sourceThresholds: { ...flagSource, attribution: "UNVERIFIED_SOURCE" },
        aParams: { ...params },
      },
    },
    input.breakout,
    params.breakoutVolumeMultiple,
    params.chaseLimit,
    asOf,
    flagLow.time,
  );
}

export type OneilContractionInput = {
  ascendingBase?: AscendingBaseInput | null;
  highTightFlag?: HighTightFlagInput | null;
};

/** Both branches are distinct; an overlap still counts as one risk group. */
export function evaluateOneilContractions(
  input: OneilContractionInput,
  ascending: AscendingBaseParams = ascendingBaseParams,
  flag: HighTightFlagParams = highTightFlagParams,
) {
  const results = [
    input.ascendingBase
      ? evaluateOneilAscendingBase(input.ascendingBase, ascending)
      : null,
    input.highTightFlag
      ? evaluateOneilHighTightFlag(input.highTightFlag, flag)
      : null,
  ].filter((row): row is OneilResult => row !== null);
  const triggered = results.filter((row) => row.candidate?.triggered);
  return {
    results,
    riskGroups:
      triggered.length > 1
        ? [{ group: "oneil-ascending-or-flag-overlap", count: 1 }]
        : triggered.map((row) => ({
            group: String(row.candidate!.evidence.riskGroup),
            count: 1,
          })),
  };
}

// ---------------------------------------------------------------------------
// F09.08 Market direction: rally, follow-through day, distribution days
// ---------------------------------------------------------------------------

/** FTD day >= 4 and gain >= 1.25% are 2024Q1 source constants. */
export const marketFollowThroughMinDay = 4;
export const marketFollowThroughMinGain = 0.0125;

export type MarketDirectionParams = {
  /** A: drawdown lookback N. */
  lookback: number;
  /** A: minimum drawdown d to start a rally attempt. */
  pullback: number;
  /** A: distribution-day decline delta. */
  distributionDrop: number;
  /** A: rolling distribution window n. */
  distributionWindow: number;
  /** A: distribution count h that reduces risk. */
  distributionCount: number;
  /** A: base position quota opened once on confirmation. */
  smallPosition: number;
};

export const marketDirectionParams: MarketDirectionParams = {
  lookback: 20,
  pullback: 0.05,
  distributionDrop: 0.005,
  distributionWindow: 25,
  distributionCount: 4,
  smallPosition: 0.2,
};

export type MarketDirectionBar = {
  date: string;
  close: number;
  low: number;
  volume: number | null;
};

export type MarketDirectionDay = {
  date: string;
  state: "none" | "rally" | "confirmed";
  rallyDay: number;
  followThrough: boolean;
  /** True only on the first confirmation of this rally attempt. */
  riskActivated: boolean;
  distributionCount: number;
  /** Potential distribution days in the window whose volume is incomparable. */
  distributionUnknown: number;
  riskReduced: boolean;
  /** True only when the full rolling window is observed, not a short prefix. */
  distributionWindowComplete: boolean;
  volumeComparable: boolean;
  /** Explicit missing-comparison state; never silently treated as "no event". */
  unknown: string | null;
  reason: string;
};

/** P1-P5: causal rally attempt, one FTD risk activation, rolling distribution. */
export function evaluateOneilMarketDirection(
  bars: readonly MarketDirectionBar[],
  params: MarketDirectionParams = marketDirectionParams,
) {
  if (
    !Number.isInteger(params.lookback) ||
    params.lookback < 2 ||
    !Number.isInteger(params.distributionWindow) ||
    params.distributionWindow < 1 ||
    !Number.isInteger(params.distributionCount) ||
    params.distributionCount < 1
  )
    throw new Error("Invalid market-direction parameters");
  fraction(params.pullback, "pullback");
  fraction(params.distributionDrop, "distributionDrop");
  fraction(params.smallPosition, "smallPosition");
  let previousEpoch = Number.NEGATIVE_INFINITY;
  for (const bar of bars) {
    const epoch = dailyBarEpoch(bar.date);
    if (
      epoch === null ||
      epoch <= previousEpoch ||
      !Number.isFinite(bar.close) ||
      bar.close <= 0 ||
      !Number.isFinite(bar.low) ||
      bar.low <= 0 ||
      bar.low > bar.close ||
      (bar.volume !== null && (!Number.isFinite(bar.volume) || bar.volume < 0))
    )
      throw new Error("Invalid market-direction bar");
    previousEpoch = epoch;
  }
  const distribution: boolean[] = [];
  const distributionMissing: boolean[] = [];
  const days: MarketDirectionDay[] = [];
  let rally: {
    day: number;
    low0: number;
    confirmed: boolean;
    riskActivated: boolean;
  } | null = null;
  for (let index = 0; index < bars.length; index++) {
    const bar = bars[index]!;
    const previousBar = bars[index - 1];
    // A rally attempt needs the full prior N-day high, never a short window.
    const priorHigh =
      index < params.lookback
        ? null
        : Math.max(
            ...bars
              .slice(index - params.lookback, index)
              .map((row) => row.close),
          );
    const drawdown =
      priorHigh === null ? 0 : (priorHigh - bar.close) / priorHigh;
    const up = !!previousBar && bar.close > previousBar.close;
    const volumeComparable =
      previousBar !== undefined &&
      bar.volume !== null &&
      previousBar.volume !== null;
    const change =
      previousBar && previousBar.close > 0
        ? (bar.close - previousBar.close) / previousBar.close
        : null;
    const potentialDistribution =
      change !== null && change <= -params.distributionDrop;
    const potentialFollowThrough =
      rally !== null &&
      !rally.confirmed &&
      rally.day + 1 >= marketFollowThroughMinDay &&
      change !== null &&
      change >= marketFollowThroughMinGain;
    const distributionDay =
      potentialDistribution &&
      volumeComparable &&
      bar.volume! > previousBar!.volume!;
    const distributionUnknown = potentialDistribution && !volumeComparable;
    distribution.push(distributionDay);
    distributionMissing.push(distributionUnknown);
    const window = distribution.slice(
      Math.max(0, distribution.length - params.distributionWindow),
    );
    const missingWindow = distributionMissing.slice(
      Math.max(0, distributionMissing.length - params.distributionWindow),
    );
    const distributionCount = window.filter(Boolean).length;
    // index0 has no previous close and therefore no distribution observation.
    // N complete distribution observations need N+1 prices (index >= N).
    const distributionWindowComplete = index >= params.distributionWindow;
    // Known distribution days at or above h already prove reduced risk; an
    // incomplete or volume-unknown window only limits proving the count is low.
    const riskReduced = distributionCount >= params.distributionCount;
    let unknown: string | null =
      index < params.lookback ? "insufficient-lookback" : null;

    let reason = "no-valid-rally-attempt";
    let failedThisBar = false;
    if (rally) {
      if (bar.low < rally.low0) {
        rally = null;
        failedThisBar = true;
        reason = "rally-low0-broken-new-risk-closed";
      } else {
        rally.day++;
        reason = rally.confirmed ? "confirmed-rally" : "rally-attempt";
        const isFollowThrough =
          !rally.confirmed &&
          rally.day >= marketFollowThroughMinDay &&
          change !== null &&
          change >= marketFollowThroughMinGain;
        if (isFollowThrough) {
          if (!volumeComparable) {
            unknown = "follow-through-volume-unknown";
            reason = unknown;
          } else if (bar.volume! <= previousBar!.volume!) {
            reason = "follow-through-volume-not-increasing";
          } else {
            rally.confirmed = true;
            reason = "follow-through-confirmed";
          }
        }
      }
    }
    if (
      !rally &&
      !failedThisBar &&
      priorHigh !== null &&
      drawdown >= params.pullback &&
      up
    ) {
      rally = {
        day: 1,
        low0: bar.low,
        confirmed: false,
        riskActivated: false,
      };
      reason = "rally-attempt-started";
    }
    if (distributionUnknown && unknown === null)
      unknown = "distribution-volume-unknown";
    if (potentialFollowThrough && unknown === null && !volumeComparable)
      unknown = "follow-through-volume-unknown";
    let riskActivated = false;
    if (rally?.confirmed && !rally.riskActivated) {
      rally.riskActivated = true;
      riskActivated = true;
      reason = "follow-through-confirmed";
    }
    days.push({
      date: bar.date,
      state: rally ? (rally.confirmed ? "confirmed" : "rally") : "none",
      rallyDay: rally?.day ?? 0,
      followThrough: riskActivated,
      riskActivated,
      distributionCount,
      distributionUnknown: missingWindow.filter(Boolean).length,
      riskReduced,
      distributionWindowComplete,
      volumeComparable,
      unknown,
      reason,
    });
  }
  return {
    days,
    current: days.at(-1) ?? null,
    parameters: { ...params },
    sourceFollowThrough: {
      minDay: marketFollowThroughMinDay,
      minGain: marketFollowThroughMinGain,
    },
  };
}
