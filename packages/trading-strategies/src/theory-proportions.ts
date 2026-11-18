/**
 * P4 proportional components: F06.05 Fibonacci extension/projection targets
 * and F06.08 harmonic swing-pattern labels.
 *
 * Both components only consume caller-confirmed pivots. Formation order is
 * validated from `formedAt`; confirmation times are never sorted to infer a
 * pivot sequence. Nothing here creates an order or a new entry.
 */

import {
  confirmationEpoch,
  type ConfirmationTime,
} from "./theory-confirmation.js";

/** A pivot with its own price, first formation time and confirmation time. */
export type ProportionAnchor = Readonly<{
  price: number;
  formedAt: ConfirmationTime;
  confirmedAt: ConfirmationTime;
}>;

type ParsedAnchor = Readonly<{
  price: number;
  formedAt: number;
  confirmedAt: number;
}>;

function parseAnchor(
  anchor: ProportionAnchor | null | undefined,
  asOf: number,
): ParsedAnchor | null {
  if (!anchor || typeof anchor !== "object") return null;
  if (
    typeof anchor.price !== "number" ||
    !Number.isFinite(anchor.price) ||
    anchor.price <= 0
  )
    return null;
  const formedAt = confirmationEpoch(anchor.formedAt);
  const confirmedAt = confirmationEpoch(anchor.confirmedAt);
  if (formedAt === null || confirmedAt === null) return null;
  if (formedAt > confirmedAt || confirmedAt > asOf) return null;
  return Object.freeze({ price: anchor.price, formedAt, confirmedAt });
}

export type FibTargetMode = "EXTENSION" | "PROJECTION";

export type FibTargetStatus =
  "UNKNOWN" | "ACTIVE" | "INVALIDATED" | "PROTECTIVE_EXIT";

export type FibTargetReference = "TARGET_REACHED" | "REDUCE";

export type FibTargetInput = Readonly<{
  mode: FibTargetMode;
  ratios: readonly number[];
  anchors: Readonly<{
    a: ProportionAnchor;
    b: ProportionAnchor;
    /** Required only for PROJECTION; ignored by EXTENSION. */
    c?: ProportionAnchor;
  }>;
  asOf: ConfirmationTime;
  /** Latest completed close observed at `asOf`; never a future bar. */
  completedClose?: number;
  /** Only an explicitly held long receives target/reduce references. */
  heldLong?: boolean;
  /** An explicit host protective exit outranks every target reference. */
  protectiveExit?: boolean;
}>;

export type FibParameterIdentity = Readonly<{
  mode: FibTargetMode;
  ratios: readonly number[];
}>;

export type FibTargetLevel = Readonly<{
  ratio: number;
  price: number;
  /** A completed close at or beyond this target was observed. */
  reached: boolean;
  /** Reference only; never an order size or a new entry. */
  references: readonly FibTargetReference[];
}>;

export type FibTargetResult = Readonly<{
  status: FibTargetStatus;
  parameterIdentity: FibParameterIdentity | null;
  /** Every calculated target, including ones already passed. */
  targets: readonly FibTargetLevel[];
  projectionC: number | null;
  completedClose: number | null;
  protectiveExit: boolean;
}>;

function fibResult(
  status: FibTargetStatus,
  parameterIdentity: FibParameterIdentity | null,
  targets: readonly FibTargetLevel[],
  projectionC: number | null,
  completedClose: number | null,
  protectiveExit: boolean,
): FibTargetResult {
  return Object.freeze({
    status,
    parameterIdentity,
    targets: Object.freeze([...targets]),
    projectionC,
    completedClose,
    protectiveExit,
  });
}

function fibRatioSet(
  mode: FibTargetMode,
  ratios: readonly number[] | null | undefined,
): number[] | null {
  if (!Array.isArray(ratios) || ratios.length === 0) return null;
  const parsed: number[] = [];
  for (const ratio of ratios) {
    if (typeof ratio !== "number" || !Number.isFinite(ratio)) return null;
    if (mode === "EXTENSION" ? ratio <= 1 : ratio <= 0) return null;
    parsed.push(ratio);
  }
  return parsed;
}

/**
 * F06.05 pure target component. EXTENSION uses `A + r*(B-A)` with r > 1;
 * PROJECTION uses the later frozen C and `C + r*(B-A)` with r > 0. Both
 * require a strictly positive A -> B segment. A projection completed close
 * below C invalidates the projection, while EXTENSION has no C rule. Every
 * computable target is returned; an explicit host protective exit keeps its
 * priority and suppresses target/reduce references.
 */
export function fibTargets(
  input: FibTargetInput | null | undefined,
): FibTargetResult {
  const protectiveExit = input?.protectiveExit === true;
  const mode =
    input?.mode === "EXTENSION" || input?.mode === "PROJECTION"
      ? input.mode
      : null;
  const ratios = mode ? fibRatioSet(mode, input?.ratios) : null;
  const parameterIdentity =
    mode && ratios
      ? Object.freeze({ mode, ratios: Object.freeze([...ratios]) })
      : null;

  const asOf = confirmationEpoch(input?.asOf);
  const rawClose = input?.completedClose;
  const closeValid =
    rawClose === undefined ||
    (typeof rawClose === "number" && Number.isFinite(rawClose) && rawClose > 0);
  const completedClose =
    closeValid && typeof rawClose === "number" ? rawClose : null;

  const anchors = input?.anchors;
  const a = asOf === null ? null : parseAnchor(anchors?.a, asOf);
  const b = asOf === null ? null : parseAnchor(anchors?.b, asOf);
  const c =
    mode === "PROJECTION" && asOf !== null
      ? parseAnchor(anchors?.c, asOf)
      : null;

  const anchorsValid =
    a !== null &&
    b !== null &&
    a.formedAt < b.formedAt &&
    (mode !== "PROJECTION" || (c !== null && b.formedAt < c.formedAt));
  const segmentLength = a !== null && b !== null ? b.price - a.price : null;
  const derivedValid =
    anchorsValid && segmentLength !== null && segmentLength > 0;

  const unknown = () =>
    fibResult(
      protectiveExit ? "PROTECTIVE_EXIT" : "UNKNOWN",
      parameterIdentity,
      [],
      mode === "PROJECTION" && c !== null ? c.price : null,
      completedClose,
      protectiveExit,
    );

  if (
    !closeValid ||
    asOf === null ||
    mode === null ||
    ratios === null ||
    !derivedValid
  )
    return unknown();

  const base = mode === "EXTENSION" ? a!.price : c!.price;
  const levels: FibTargetLevel[] = [];
  for (const ratio of ratios) {
    const price = base + ratio * segmentLength!;
    if (!Number.isFinite(price)) return unknown();
    const reached = completedClose !== null && completedClose >= price;
    const references: FibTargetReference[] =
      !protectiveExit && input?.heldLong === true && reached
        ? ["TARGET_REACHED", "REDUCE"]
        : [];
    levels.push(
      Object.freeze({
        ratio,
        price,
        reached,
        references: Object.freeze(references),
      }),
    );
  }

  const invalidated =
    mode === "PROJECTION" &&
    completedClose !== null &&
    completedClose < c!.price;

  return fibResult(
    protectiveExit ? "PROTECTIVE_EXIT" : invalidated ? "INVALIDATED" : "ACTIVE",
    parameterIdentity,
    levels,
    mode === "PROJECTION" ? c!.price : null,
    completedClose,
    protectiveExit,
  );
}

export type HarmonicPointKind = "high" | "low";

export type HarmonicPoint = Readonly<
  ProportionAnchor & { kind: HarmonicPointKind }
>;

export type HarmonicPattern = "GARTLEY" | "BAT" | "BUTTERFLY" | "CRAB";

export type HarmonicStatus = "UNKNOWN" | "NO_PATTERN" | "MATCH" | "AMBIGUOUS";

export type HarmonicSide = "bullish" | "bearish";

export type HarmonicInput = Readonly<{
  /** Exactly X, A, B, C, D in actual formation order. */
  points: readonly HarmonicPoint[];
  /** Absolute ratio tolerance e >= 0. */
  tolerance: number;
  asOf: ConfirmationTime;
}>;

export type HarmonicRatios = Readonly<{
  b: number;
  d: number;
  c: number;
  a: number;
}>;

export type HarmonicResult = Readonly<{
  /** Outcome of the four family tables only; AB_EQ_CD is separate. */
  status: HarmonicStatus;
  /** Every matching v2 table, in fixed Gartley/Bat/Butterfly/Crab order. */
  patterns: readonly HarmonicPattern[];
  /** Standalone alternating a ~= 1 tag; never a fifth pattern. */
  abEqualsCd: boolean;
  /** True when more than one four-pattern table matches. */
  ambiguous: boolean;
  ratios: HarmonicRatios | null;
  side: HarmonicSide | null;
  /** D's own confirmation epoch; never moved back to D's price extreme. */
  dConfirmedAt: number | null;
  /** max(confirmedAt) across X/A/B/C/D. */
  availableAt: number | null;
  parameterIdentity: Readonly<{ tolerance: number }> | null;
  reference: "NO_DIRECT_TRADE";
}>;

function harmonicUnknown(
  parameterIdentity: Readonly<{ tolerance: number }> | null,
  side: HarmonicSide | null = null,
  dConfirmedAt: number | null = null,
  availableAt: number | null = null,
): HarmonicResult {
  return Object.freeze({
    status: "UNKNOWN",
    patterns: Object.freeze([]),
    abEqualsCd: false,
    ambiguous: false,
    ratios: null,
    side,
    dConfirmedAt,
    availableAt,
    parameterIdentity,
    reference: "NO_DIRECT_TRADE",
  });
}

function harmonicResult(
  status: HarmonicStatus,
  patterns: readonly HarmonicPattern[],
  abEqualsCd: boolean,
  ratios: HarmonicRatios,
  side: HarmonicSide,
  dConfirmedAt: number,
  availableAt: number,
  parameterIdentity: Readonly<{ tolerance: number }>,
): HarmonicResult {
  return Object.freeze({
    status,
    patterns: Object.freeze([...patterns]),
    abEqualsCd,
    ambiguous: patterns.length > 1,
    ratios,
    side,
    dConfirmedAt,
    availableAt,
    parameterIdentity,
    reference: "NO_DIRECT_TRADE",
  });
}

type ParsedHarmonicPoint = Readonly<ParsedAnchor & { kind: HarmonicPointKind }>;

/**
 * F06.08 pure harmonic matcher. Exactly five confirmed X/A/B/C/D pivots must
 * arrive in strict formation order. Ratios:
 * b=|A-B|/|A-X|, d=|A-D|/|A-X|, c=|C-D|/|C-B|, a=|C-D|/|A-B|.
 *
 * Common alternating price direction is separate from four-family geometry.
 * `AB_EQ_CD` only needs alternating kinds/prices plus a ~= 1, so it can be
 * true while `status` is NO_PATTERN. Four-family geometry additionally
 * requires C strictly between B and A and D outside B toward X; Gartley/Bat
 * reject a D beyond X while Butterfly/Crab require it.
 *
 * Known completed geometry that fails these checks is NO_PATTERN. UNKNOWN is
 * reserved for missing/future/invalid-time evidence, zero denominators and
 * malformed inputs. `status` describes the four family tables only;
 * `AB_EQ_CD` is reported separately. Nothing here is a direct trade.
 */
export function harmonicPatterns(
  input: HarmonicInput | null | undefined,
): HarmonicResult {
  const tolerance = input?.tolerance;
  const toleranceValid =
    typeof tolerance === "number" &&
    Number.isFinite(tolerance) &&
    tolerance >= 0;
  if (!toleranceValid) return harmonicUnknown(null);
  const parameterIdentity = Object.freeze({ tolerance });

  const asOf = confirmationEpoch(input?.asOf);
  const points = input?.points;
  if (asOf === null || !Array.isArray(points) || points.length !== 5)
    return harmonicUnknown(parameterIdentity);

  const parsed: ParsedHarmonicPoint[] = [];
  for (const point of points) {
    if (!point || (point.kind !== "high" && point.kind !== "low"))
      return harmonicUnknown(parameterIdentity);
    const anchor = parseAnchor(point, asOf);
    if (!anchor) return harmonicUnknown(parameterIdentity);
    parsed.push(Object.freeze({ ...anchor, kind: point.kind }));
  }

  // Formation order is mandatory evidence. Confirmation times are validated
  // per point but never sorted to guess which pivot came first.
  for (let index = 1; index < parsed.length; index++) {
    if (parsed[index - 1]!.formedAt >= parsed[index]!.formedAt)
      return harmonicUnknown(parameterIdentity);
  }

  const x = parsed[0]!;
  const a = parsed[1]!;
  const b = parsed[2]!;
  const c = parsed[3]!;
  const d = parsed[4]!;
  const side: HarmonicSide = x.kind === "low" ? "bullish" : "bearish";
  const bullish = side === "bullish";
  const availableAt = Math.max(
    x.confirmedAt,
    a.confirmedAt,
    b.confirmedAt,
    c.confirmedAt,
    d.confirmedAt,
  );

  const xa = Math.abs(a.price - x.price);
  const ab = Math.abs(a.price - b.price);
  const cb = Math.abs(c.price - b.price);
  if (xa === 0 || ab === 0 || cb === 0)
    return harmonicUnknown(parameterIdentity, side, d.confirmedAt, availableAt);

  const ratios: HarmonicRatios = Object.freeze({
    b: ab / xa,
    d: Math.abs(a.price - d.price) / xa,
    c: Math.abs(c.price - d.price) / cb,
    a: Math.abs(c.price - d.price) / ab,
  });
  if (
    !Number.isFinite(ratios.b) ||
    !Number.isFinite(ratios.d) ||
    !Number.isFinite(ratios.c) ||
    !Number.isFinite(ratios.a)
  )
    return harmonicUnknown(parameterIdentity, side, d.confirmedAt, availableAt);

  const kindsAlternate = parsed.every(
    (point, index) => index === 0 || parsed[index - 1]!.kind !== point.kind,
  );
  const pricesAlternate = bullish
    ? x.price < a.price &&
      b.price < a.price &&
      c.price > b.price &&
      d.price < c.price
    : x.price > a.price &&
      b.price > a.price &&
      c.price < b.price &&
      d.price > c.price;
  const alternatingStructure = kindsAlternate && pricesAlternate;

  const around = (value: number, target: number) =>
    Math.abs(value - target) <= tolerance;
  const within = (value: number, low: number, high: number) =>
    value >= low - tolerance && value <= high + tolerance;

  // The standalone tag deliberately ignores four-family C/D geometry.
  const abEqualsCd = alternatingStructure && around(ratios.a, 1);

  const cBetween = bullish
    ? b.price < c.price && c.price < a.price
    : a.price < c.price && c.price < b.price;
  const dOutsideB = bullish ? d.price < b.price : d.price > b.price;
  const familyGeometry = alternatingStructure && cBetween && dOutsideB;
  const crossed = bullish ? d.price < x.price : d.price > x.price;

  const patterns: HarmonicPattern[] = [];
  if (familyGeometry) {
    if (
      around(ratios.b, 0.618) &&
      around(ratios.d, 0.786) &&
      around(ratios.a, 1) &&
      (around(ratios.c, 1.27) || around(ratios.c, 1.618)) &&
      !crossed
    )
      patterns.push("GARTLEY");
    if (
      ratios.b < 0.618 &&
      around(ratios.d, 0.886) &&
      within(ratios.c, 1.618, 2.618) &&
      ratios.a >= 1 &&
      !crossed
    )
      patterns.push("BAT");
    if (
      around(ratios.b, 0.786) &&
      around(ratios.d, 1.27) &&
      within(ratios.a, 1, 1.27) &&
      around(ratios.c, 1.618) &&
      crossed
    )
      patterns.push("BUTTERFLY");
    if (
      within(ratios.b, 0.382, 0.618) &&
      around(ratios.d, 1.618) &&
      (around(ratios.c, 2.618) ||
        around(ratios.c, 3.14) ||
        around(ratios.c, 3.618)) &&
      ratios.a >= 1 &&
      crossed
    )
      patterns.push("CRAB");
  }

  const status: HarmonicStatus =
    patterns.length > 1
      ? "AMBIGUOUS"
      : patterns.length === 1
        ? "MATCH"
        : "NO_PATTERN";

  return harmonicResult(
    status,
    patterns,
    abEqualsCd,
    ratios,
    side,
    d.confirmedAt,
    availableAt,
    parameterIdentity,
  );
}
