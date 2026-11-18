/**
 * P4 simple selection components: F09.02 SEPA price trend template, F13.02
 * Graham NCAV arithmetic, F10.03 explicit zero-cash absolute momentum and
 * F11.10 close-confirmed full bearish-bar reclaim.
 *
 * These are pure components, not complete strategies and not reproductions of
 * the authors' original systems. Missing facts stay UNKNOWN; no component
 * invents financial data, reports, RPS-as-platform-RS, orders or positions.
 */

import type { Bar } from "trading-strategy-core/bars";
import { linearSlope, ma } from "trading-strategy-core/indicators";
import {
  confirmationEpoch,
  type ConfirmationTime,
} from "./theory-confirmation.js";
import {
  areDailyDatesStrictlyAscending,
  dailyBarEpoch,
  isValidOhlc,
} from "./theory-input.js";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Boolean wrapper so a shared type guard does not narrow a `Bar` variable. */
function hasValidOhlc(value: unknown): boolean {
  return isValidOhlc(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function nonNegative(value: unknown): number | null {
  return isNonNegativeNumber(value) ? value : null;
}

function positive(value: unknown): number | null {
  return isFiniteNumber(value) && value > 0 ? value : null;
}

/** Consumer-local completion rule: shared OHLC plus finite nonnegative volume. */
function validCompletedBar(bar: Bar | null | undefined): bar is Bar {
  return isValidOhlc(bar) && isNonNegativeNumber((bar as Bar).volume);
}

/** Collect only real supplied dates; a missing bar is not assigned a date. */
function safeDailyDates(
  bars: readonly (Bar | null | undefined)[],
  lastIndex: number,
): string[] | null {
  if (!Number.isInteger(lastIndex) || lastIndex < 0 || lastIndex >= bars.length)
    return null;
  const dates: string[] = [];
  for (let index = 0; index <= lastIndex; index++) {
    const bar = bars[index];
    if (!bar || typeof bar.date !== "string") return null;
    dates.push(bar.date);
  }
  return dates;
}

function validCompletedPrefix(bars: readonly Bar[], lastIndex: number) {
  for (let index = 0; index <= lastIndex; index++)
    if (!validCompletedBar(bars[index])) return false;
  const dates = safeDailyDates(bars, lastIndex);
  return dates !== null && areDailyDatesStrictlyAscending(dates);
}

/* ------------------------------------------------------------------------- */
/* F09.02 SEPA price trend template                                           */
/* ------------------------------------------------------------------------- */

export type SepaTrendCriterion =
  | "closeAboveMa150"
  | "closeAboveMa200"
  | "ma150AboveMa200"
  | "ma50AboveMa150"
  | "ma50AboveMa200"
  | "closeAboveMa50"
  | "ma200SlopePositive"
  | "ma200LastAboveFirst"
  | "closeAtLeast130PctWeek52Low"
  | "closeAtLeast75PctWeek52High"
  | "platformRsAtLeast70";

export type SepaTrendCriteria = Readonly<
  Record<SepaTrendCriterion, boolean | null>
>;

export type SepaPriceTrendStatus = "PASS" | "FAIL" | "UNKNOWN";

export type SepaPriceTrendInput = Readonly<{
  /** Completed daily bars. Bars after `decisionBarIndex` are ignored. */
  bars: readonly Bar[];
  /**
   * Number of most recent completed daily bars that form the frozen 52-week
   * window, ending at the decision bar. The caller declares this explicitly;
   * no hidden 252-bar calendar assumption is applied.
   */
  week52Bars: number;
  /**
   * Supplied platform RS score in [0, 100]. `null`, missing or out-of-range
   * means UNKNOWN. Local RPS is never substituted for this value.
   */
  platformRs?: number | null;
  /** Defaults to the last supplied bar. */
  decisionBarIndex?: number;
}>;

export type SepaWeek52Window = Readonly<{
  barCount: number;
  firstDate: string;
  lastDate: string;
  high: number;
  low: number;
}>;

export type SepaPriceTrendValues = Readonly<{
  close: number;
  ma50: number;
  ma150: number;
  ma200: number;
  ma200First: number;
  ma200Last: number;
  ma200Slope: number;
  platformRs: number | null;
}>;

export type SepaPriceTrendResult = Readonly<{
  status: SepaPriceTrendStatus;
  /** Price criteria only; excludes platform RS. */
  priceStatus: SepaPriceTrendStatus;
  criteria: SepaTrendCriteria;
  values: SepaPriceTrendValues | null;
  week52Window: SepaWeek52Window | null;
  barCount: number;
  decisionBarIndex: number | null;
  scope: "PRICE_TREND_TEMPLATE_ONLY";
  financialEvidence: "NOT_EVALUATED";
  catalystEvidence: "NOT_EVALUATED";
  wholeSepa: false;
}>;

function emptySepaCriteria(): SepaTrendCriteria {
  return Object.freeze({
    closeAboveMa150: null,
    closeAboveMa200: null,
    ma150AboveMa200: null,
    ma50AboveMa150: null,
    ma50AboveMa200: null,
    closeAboveMa50: null,
    ma200SlopePositive: null,
    ma200LastAboveFirst: null,
    closeAtLeast130PctWeek52Low: null,
    closeAtLeast75PctWeek52High: null,
    platformRsAtLeast70: null,
  });
}

function sepaUnknown(
  barCount: number,
  decisionBarIndex: number | null,
): SepaPriceTrendResult {
  return Object.freeze({
    status: "UNKNOWN",
    priceStatus: "UNKNOWN",
    criteria: emptySepaCriteria(),
    values: null,
    week52Window: null,
    barCount,
    decisionBarIndex,
    scope: "PRICE_TREND_TEMPLATE_ONLY" as const,
    financialEvidence: "NOT_EVALUATED" as const,
    catalystEvidence: "NOT_EVALUATED" as const,
    wholeSepa: false as const,
  });
}

/**
 * F09.02 platform-version price trend template only. MA50/150/200 use
 * completed closes; the 120 completed MA200 values require at least 319 daily
 * bars. The MA200 rise is OLS slope > 0 *and* last > first, because a positive
 * slope alone permits a lower endpoint. Every price criterion is reported
 * independently. Financial growth, catalysts and a valid entry setup are not
 * evaluated here and are never implied to pass.
 */
export function sepaPriceTrendTemplate(
  input: SepaPriceTrendInput | null | undefined,
): SepaPriceTrendResult {
  const bars = input?.bars;
  const barCount = Array.isArray(bars) ? bars.length : 0;
  if (!Array.isArray(bars) || bars.length === 0)
    return sepaUnknown(barCount, null);

  const requestedIndex = input?.decisionBarIndex;
  const decisionBarIndex =
    requestedIndex === undefined ? bars.length - 1 : requestedIndex;
  if (
    !Number.isInteger(decisionBarIndex) ||
    decisionBarIndex < 0 ||
    decisionBarIndex >= bars.length
  )
    return sepaUnknown(barCount, null);

  const history = bars.slice(0, decisionBarIndex + 1);
  const usedBars = history.length;
  if (usedBars < 319) return sepaUnknown(usedBars, decisionBarIndex);
  if (
    !history.every(hasValidOhlc) ||
    !areDailyDatesStrictlyAscending(history.map((bar) => bar.date))
  )
    return sepaUnknown(usedBars, decisionBarIndex);

  const week52Bars = input?.week52Bars;
  if (!isPositiveInteger(week52Bars) || week52Bars > history.length)
    return sepaUnknown(usedBars, decisionBarIndex);

  const ma50 = ma(history, 50).at(-1) ?? null;
  const ma150 = ma(history, 150).at(-1) ?? null;
  const ma200Series = ma(history, 200);
  const ma200 = ma200Series.at(-1) ?? null;
  const slopeWindow = ma200Series.slice(-120);
  if (ma50 === null || ma150 === null || ma200 === null)
    return sepaUnknown(usedBars, decisionBarIndex);
  if (slopeWindow.length !== 120)
    return sepaUnknown(usedBars, decisionBarIndex);

  const slopeValues: number[] = [];
  for (const value of slopeWindow) {
    if (value === null || !Number.isFinite(value))
      return sepaUnknown(usedBars, decisionBarIndex);
    slopeValues.push(value);
  }
  const ma200First = slopeValues[0]!;
  const ma200Last = slopeValues.at(-1)!;
  const ma200Slope = linearSlope(slopeValues);
  if (ma200Slope === null) return sepaUnknown(usedBars, decisionBarIndex);

  const week52 = history.slice(-week52Bars);
  const week52First = week52[0];
  const week52Last = week52.at(-1);
  if (!week52First || !week52Last)
    return sepaUnknown(usedBars, decisionBarIndex);
  let week52High = -Infinity;
  let week52Low = Infinity;
  for (const bar of week52) {
    week52High = Math.max(week52High, bar.high);
    week52Low = Math.min(week52Low, bar.low);
  }
  if (!Number.isFinite(week52High) || !Number.isFinite(week52Low))
    return sepaUnknown(usedBars, decisionBarIndex);

  const close = history[decisionBarIndex]!.close;
  const rawPlatformRs = input?.platformRs;
  const platformRs =
    isFiniteNumber(rawPlatformRs) && rawPlatformRs >= 0 && rawPlatformRs <= 100
      ? rawPlatformRs
      : null;

  const priceCriteria = Object.freeze({
    closeAboveMa150: close > ma150,
    closeAboveMa200: close > ma200,
    ma150AboveMa200: ma150 > ma200,
    ma50AboveMa150: ma50 > ma150,
    ma50AboveMa200: ma50 > ma200,
    closeAboveMa50: close > ma50,
    ma200SlopePositive: ma200Slope > 0,
    ma200LastAboveFirst: ma200Last > ma200First,
    closeAtLeast130PctWeek52Low: close >= 1.3 * week52Low,
    closeAtLeast75PctWeek52High: close >= 0.75 * week52High,
  });
  const priceValues = Object.values(priceCriteria);
  const priceStatus: SepaPriceTrendStatus = priceValues.some(
    (value) => value === false,
  )
    ? "FAIL"
    : "PASS";

  const platformRsAtLeast70 = platformRs === null ? null : platformRs >= 70;
  const criteria: SepaTrendCriteria = Object.freeze({
    ...priceCriteria,
    platformRsAtLeast70,
  });
  const allValues = [...priceValues, platformRsAtLeast70];
  const status: SepaPriceTrendStatus = allValues.some(
    (value) => value === false,
  )
    ? "FAIL"
    : allValues.some((value) => value === null)
      ? "UNKNOWN"
      : "PASS";

  return Object.freeze({
    status,
    priceStatus,
    criteria,
    values: Object.freeze({
      close,
      ma50,
      ma150,
      ma200,
      ma200First,
      ma200Last,
      ma200Slope,
      platformRs,
    }),
    week52Window: Object.freeze({
      barCount: week52Bars,
      firstDate: week52First.date,
      lastDate: week52Last.date,
      high: week52High,
      low: week52Low,
    }),
    barCount: history.length,
    decisionBarIndex,
    scope: "PRICE_TREND_TEMPLATE_ONLY" as const,
    financialEvidence: "NOT_EVALUATED" as const,
    catalystEvidence: "NOT_EVALUATED" as const,
    wholeSepa: false as const,
  });
}

/* ------------------------------------------------------------------------- */
/* F13.02 Graham NCAV arithmetic                                              */
/* ------------------------------------------------------------------------- */

export type GrahamNcavStatus =
  "UNKNOWN" | "UNRESOLVED" | "WAIT" | "FILTER_PASS";

export type GrahamNcavPreferenceClassification =
  "INCLUDED_IN_LIABILITIES" | "SEPARATE" | null;

export type GrahamNcavExitReason =
  "NCAV_NON_POSITIVE" | "PRICE_AT_OR_ABOVE_NCAV" | "HOLDING_PERIOD_REACHED";

export type GrahamNcavInput = Readonly<{
  currentAssets: number | null | undefined;
  liabilities: number | null | undefined;
  preferredEquity: number | null | undefined;
  /**
   * Explicit classification. `true` means preferred equity is already inside
   * liabilities and must not be subtracted again; `false` means it is
   * separate. `null`/missing is unresolved.
   */
  preferredIncludedInLiabilities: boolean | null | undefined;
  commonShares: number | null | undefined;
  price: number | null | undefined;
  /** Research discount `a` in (0, 1). */
  discount: number | null | undefined;
  /** Maximum holding duration `H`, a positive integer. */
  maxHoldingDays: number | null | undefined;
  /** Only an explicit audited asset recoverability may allow new entries. */
  assetRecoverabilityAudited: boolean | null | undefined;
  /** Actual known position; intents or rejected orders must not set this. */
  held?: boolean | null;
  /** Actual completed holding duration, required only for the expiry check. */
  holdingDays?: number | null;
}>;

export type GrahamNcavResult = Readonly<{
  status: GrahamNcavStatus;
  netCurrentAssets: number | null;
  ncav: number | null;
  preferredDeduction: number | null;
  preferenceClassification: GrahamNcavPreferenceClassification;
  thresholdPrice: number | null;
  exitReference: "EXIT_HELD_POSITION" | null;
  exitReasons: readonly GrahamNcavExitReason[];
  noNewEntry: boolean;
  held: boolean;
  holdingDaysKnown: boolean;
  parameterIdentity: Readonly<{
    discount: number;
    maxHoldingDays: number;
  }> | null;
  scope: "NCAV_ARITHMETIC_COMPONENT";
  originalGrahamFormula: false;
}>;

function ncavResult(
  overrides: Partial<Omit<GrahamNcavResult, "scope" | "originalGrahamFormula">>,
): GrahamNcavResult {
  return Object.freeze({
    status: "UNKNOWN" as const,
    netCurrentAssets: null,
    ncav: null,
    preferredDeduction: null,
    preferenceClassification: null,
    thresholdPrice: null,
    exitReference: null,
    exitReasons: Object.freeze([]),
    noNewEntry: false,
    held: false,
    holdingDaysKnown: false,
    parameterIdentity: null,
    scope: "NCAV_ARITHMETIC_COMPONENT" as const,
    originalGrahamFormula: false as const,
    ...overrides,
  });
}

/**
 * F13.02 NCAV arithmetic component, an explicit research definition rather
 * than a claim of Graham's original formula. `(CA - L - Pref) / N` subtracts
 * preferred equity only when it is not already included in liabilities.
 * Missing required facts are UNKNOWN. Unaudited asset recoverability is
 * UNRESOLVED and blocks new entries. Known held-position exit references are
 * preserved independently of the screening status.
 */
export function grahamNcavScreen(
  input: GrahamNcavInput | null | undefined,
): GrahamNcavResult {
  const currentAssets = nonNegative(input?.currentAssets);
  const liabilities = nonNegative(input?.liabilities);
  const preferredEquity = nonNegative(input?.preferredEquity);
  const commonShares = positive(input?.commonShares);
  const price = positive(input?.price);
  const rawDiscount = input?.discount;
  const discount =
    isFiniteNumber(rawDiscount) && rawDiscount > 0 && rawDiscount < 1
      ? rawDiscount
      : null;
  const rawMaxHoldingDays = input?.maxHoldingDays;
  const maxHoldingDays = isPositiveInteger(rawMaxHoldingDays)
    ? rawMaxHoldingDays
    : null;

  const preferenceClassification: GrahamNcavPreferenceClassification =
    input?.preferredIncludedInLiabilities === true
      ? "INCLUDED_IN_LIABILITIES"
      : input?.preferredIncludedInLiabilities === false
        ? "SEPARATE"
        : null;
  const preferredDeduction =
    preferenceClassification === "INCLUDED_IN_LIABILITIES"
      ? 0
      : preferenceClassification === "SEPARATE"
        ? preferredEquity
        : null;

  const heldRaw = input?.held;
  const heldValid =
    heldRaw === undefined || heldRaw === null || typeof heldRaw === "boolean";
  const held = heldRaw === true;
  const rawHoldingDays = input?.holdingDays;
  const holdingDays =
    Number.isInteger(rawHoldingDays) && (rawHoldingDays as number) >= 0
      ? (rawHoldingDays as number)
      : null;
  const holdingDaysKnown = held && holdingDays !== null;

  let netCurrentAssets: number | null = null;
  let ncav: number | null = null;
  if (
    currentAssets !== null &&
    liabilities !== null &&
    preferredEquity !== null &&
    preferredDeduction !== null &&
    commonShares !== null
  ) {
    netCurrentAssets = currentAssets - liabilities - preferredDeduction;
    const value = netCurrentAssets / commonShares;
    if (Number.isFinite(value)) ncav = value;
    else netCurrentAssets = null;
  }

  const thresholdPrice =
    discount !== null && ncav !== null ? discount * ncav : null;

  const exitReasons: GrahamNcavExitReason[] = [];
  if (held) {
    if (ncav !== null && ncav <= 0) exitReasons.push("NCAV_NON_POSITIVE");
    if (ncav !== null && price !== null && price >= ncav)
      exitReasons.push("PRICE_AT_OR_ABOVE_NCAV");
    if (
      maxHoldingDays !== null &&
      holdingDays !== null &&
      holdingDays >= maxHoldingDays
    )
      exitReasons.push("HOLDING_PERIOD_REACHED");
  }

  const requiredValid =
    netCurrentAssets !== null &&
    price !== null &&
    discount !== null &&
    maxHoldingDays !== null &&
    heldValid;
  let status: GrahamNcavStatus;
  if (!requiredValid || ncav === null) status = "UNKNOWN";
  else if (input?.assetRecoverabilityAudited !== true) status = "UNRESOLVED";
  else if (
    !held &&
    ncav > 0 &&
    price !== null &&
    discount !== null &&
    price <= discount * ncav
  )
    status = "FILTER_PASS";
  else status = "WAIT";

  return ncavResult({
    status,
    netCurrentAssets,
    ncav,
    preferredDeduction,
    preferenceClassification,
    thresholdPrice,
    exitReference: exitReasons.length > 0 ? "EXIT_HELD_POSITION" : null,
    exitReasons: Object.freeze([...exitReasons]),
    noNewEntry: status === "UNKNOWN" || status === "UNRESOLVED",
    held,
    holdingDaysKnown,
    parameterIdentity:
      discount !== null && maxHoldingDays !== null
        ? Object.freeze({ discount, maxHoldingDays })
        : null,
  });
}

/* ------------------------------------------------------------------------- */
/* F10.03 absolute momentum, explicit zero-cash comparison                    */
/* ------------------------------------------------------------------------- */

export type AbsoluteMomentumStatus = "UNKNOWN" | "RISK_ASSET" | "DEFENSIVE";

export type AbsoluteMomentumPeriod = Readonly<{
  /** Caller-declared identity of the same-period return. */
  identity: string;
  start: ConfirmationTime;
  end: ConfirmationTime;
}>;

export type AbsoluteMomentumInput = Readonly<{
  /** Supplied same-period total return of the asset. */
  assetReturn: number | null | undefined;
  /** Predeclared excess threshold δ in the same return units. */
  threshold: number | null | undefined;
  period: AbsoluteMomentumPeriod | null | undefined;
  /** Optional decision clock; the declared period must be complete by it. */
  asOf?: ConfirmationTime;
}>;

export type AbsoluteMomentumResult = Readonly<{
  status: AbsoluteMomentumStatus;
  comparison:
    "ASSET_RETURN_ABOVE_ZERO_CASH_THRESHOLD" | "DEFENSIVE_TIE_OR_BELOW" | null;
  assetReturn: number | null;
  cashReturn: 0;
  excessOverZeroCash: number | null;
  excessOverThreshold: number | null;
  threshold: number | null;
  periodIdentity: Readonly<{
    identity: string;
    start: number;
    end: number;
  }> | null;
  assumption: "CASH_RETURN_ASSUMED_ZERO";
  model: "ZERO_CASH_COMPARISON_COMPONENT";
  originalCashExcessModel: false;
  treasuryBillModel: false;
  targetWeight: null;
  reference: "NO_TARGET_WEIGHT";
}>;

function momentumResult(
  overrides: Partial<
    Omit<AbsoluteMomentumResult, "assumption" | "model" | "reference">
  >,
): AbsoluteMomentumResult {
  return Object.freeze({
    status: "UNKNOWN" as const,
    comparison: null,
    assetReturn: null,
    cashReturn: 0 as const,
    excessOverZeroCash: null,
    excessOverThreshold: null,
    threshold: null,
    periodIdentity: null,
    assumption: "CASH_RETURN_ASSUMED_ZERO" as const,
    model: "ZERO_CASH_COMPARISON_COMPONENT" as const,
    originalCashExcessModel: false as const,
    treasuryBillModel: false as const,
    targetWeight: null,
    reference: "NO_TARGET_WEIGHT" as const,
    ...overrides,
  });
}

/**
 * F10.03 explicitly named zero-cash comparison component. It compares a
 * supplied same-period asset return with the constant cash return 0 and a
 * predeclared excess threshold. Equality is defensive. This is neither the
 * original cash-excess/T-bill model nor a target-weight generator.
 */
export function absoluteMomentumZeroCash(
  input: AbsoluteMomentumInput | null | undefined,
): AbsoluteMomentumResult {
  const assetReturn = input?.assetReturn;
  const threshold = input?.threshold;
  const period = input?.period;

  if (!isFiniteNumber(assetReturn) || !isFiniteNumber(threshold))
    return momentumResult({});
  if (
    !period ||
    typeof period.identity !== "string" ||
    period.identity.length === 0
  )
    return momentumResult({});

  const start = confirmationEpoch(period.start);
  const end = confirmationEpoch(period.end);
  if (start === null || end === null || start >= end) return momentumResult({});

  const asOfRaw = input?.asOf;
  if (asOfRaw !== undefined) {
    const asOf = confirmationEpoch(asOfRaw);
    if (asOf === null || end > asOf) return momentumResult({});
  }

  const excessOverZeroCash = assetReturn - 0;
  const riskAsset = excessOverZeroCash > threshold;

  return momentumResult({
    status: riskAsset ? "RISK_ASSET" : "DEFENSIVE",
    comparison: riskAsset
      ? "ASSET_RETURN_ABOVE_ZERO_CASH_THRESHOLD"
      : "DEFENSIVE_TIE_OR_BELOW",
    assetReturn,
    excessOverZeroCash,
    excessOverThreshold: assetReturn - threshold,
    threshold,
    periodIdentity: Object.freeze({
      identity: period.identity,
      start,
      end,
    }),
  });
}

/* ------------------------------------------------------------------------- */
/* F11.10 close-confirmed full bearish-bar reclaim                           */
/* ------------------------------------------------------------------------- */

export type BearishReclaimMode = "full";

export type BearishReclaimBlockedReason =
  | "MODE_NOT_FULL"
  | "INVALID_TIMING"
  | "INVALID_BARS"
  | "INVALID_POSITION"
  | "POSITION_UNKNOWN"
  | "INVALID_ENTRY_PARAMETERS"
  | "NO_CANDIDATE"
  | "INVALID_CANDIDATE"
  | "STALE_CANDIDATE"
  | "MISSING_PLANNED_PRICE"
  | "INVALID_STOP"
  | "PLAN_ENTRY_NOT_ABOVE_STOP"
  | "RISK_ABOVE_LIMIT"
  | "CANDIDATE_CONSUMED"
  | "POSITION_HELD"
  | "NO_SIGNAL";

export type BearishReclaimExitReason =
  "STOP_BREACH" | "HOLDING_EXPIRED" | "PENDING_EXIT";

export type BearishReclaimCandidate = Readonly<{
  /**
   * Caller-frozen D bar for the original signal. For a new entry it must be
   * the completed bearish bar immediately before the decision bar.
   */
  dBarIndex: number;
  /** Completion time of D's close. */
  confirmedAt: ConfirmationTime;
  /** Candidate eligibility; must precede the original decision. */
  eligibleAt: ConfirmationTime;
  /** Original signal decision time. */
  originalDecisionAt: ConfirmationTime;
  /** Caller-owned idempotence state. */
  consumed: boolean;
}>;

export type BearishReclaimPosition = Readonly<{
  held: boolean;
  /** Actual fill bar index; used for the T expiry check. */
  entryBarIndex?: number;
  /** Whether the actual position may be sold at this decision. */
  canSell: boolean;
  /**
   * Stop frozen from the actual entry intent/fill. Never replaced by the
   * latest previous bar or a new candidate D.
   */
  frozenStopPrice?: number | null;
}>;

export type BearishBarReclaimInput = Readonly<{
  /** Completed daily bars. Bars after `decisionBarIndex` are ignored. */
  bars: readonly Bar[];
  mode: BearishReclaimMode;
  /** Completion provenance of the current completed daily bar. */
  currentCompletedAt: ConfirmationTime;
  /** Decision time; it must not precede `currentCompletedAt`. */
  decisionAt: ConfirmationTime;
  /** Frozen candidate for a new entry; optional for held-only protection. */
  candidate?: BearishReclaimCandidate | null;
  /** v: current volume >= v * mean(prior volumes excluding current). */
  volumeMultiplier: number;
  /** buffer >= 0; new-entry protection is D.low - buffer. */
  stopBuffer: number;
  /** T: maximum holding duration in completed bars. */
  maxHoldingBars: number;
  /** Predeclared maximum risk fraction of the planned entry price. */
  riskLimit: number;
  /** Supplied plan entry price; the current close is never substituted. */
  plannedEntryPrice?: number | null;
  /** Actual position only. Intents and rejected orders are not positions. */
  position?: BearishReclaimPosition | null;
  /** Caller-owned pending exit from an earlier blocked decision. */
  pendingExit?: boolean;
  /** Defaults to the last supplied bar. */
  decisionBarIndex?: number;
}>;

export type BearishReclaimCandidateEvidence = Readonly<{
  dBarIndex: number;
  high: number;
  low: number;
  volume: number;
  bearish: boolean;
  confirmedAt: number;
  eligibleAt: number;
  originalDecisionAt: number;
  eligibleBeforeOriginalDecision: boolean;
  consumed: boolean;
  fresh: boolean;
}>;

export type BearishReclaimEntryEvidence = Readonly<{
  currentClose: number;
  currentVolume: number;
  priorVolumeMean: number | null;
  requiredVolume: number | null;
  closeAboveDHigh: boolean | null;
  volumeAtLeastRequired: boolean | null;
  stopPrice: number | null;
  plannedEntryPrice: number | null;
  riskDistance: number | null;
  riskFraction: number | null;
  riskWithinLimit: boolean | null;
}>;

export type BearishReclaimHeldEvidence = Readonly<{
  positionSeen: boolean;
  entryBarIndex: number | null;
  frozenStopPrice: number | null;
  currentClose: number | null;
  holdingBars: number | null;
  stopBreached: boolean | null;
  holdingExpired: boolean | null;
  canSell: boolean;
  pendingExit: boolean;
}>;

export type BearishReclaimResult = Readonly<{
  /** Entry status. Held protection is reported independently. */
  status: "UNKNOWN" | "NO_SIGNAL" | "SIGNAL";
  candidate: BearishReclaimCandidateEvidence | null;
  entry: BearishReclaimEntryEvidence | null;
  held: BearishReclaimHeldEvidence;
  entryReference: "ENTRY_REFERENCE" | null;
  exitReference: "EXIT_REFERENCE" | "EXIT_PENDING" | null;
  exitReasons: readonly BearishReclaimExitReason[];
  newEntryBlocked: BearishReclaimBlockedReason | null;
  /** Remains true until the caller reports an actual flat position. */
  nextPendingExit: boolean;
  candidateConsumedNext: boolean;
  timing: Readonly<{
    currentCompletedAt: number | null;
    decisionAt: number | null;
    decisionAfterCompletion: boolean;
  }>;
  parameters: Readonly<{
    volumeMultiplier: number | null;
    stopBuffer: number | null;
    maxHoldingBars: number | null;
    riskLimit: number | null;
  }>;
  decisionBarIndex: number | null;
  reference: "NO_ORDER";
}>;

function emptyHeldEvidence(): BearishReclaimHeldEvidence {
  return Object.freeze({
    positionSeen: false,
    entryBarIndex: null,
    frozenStopPrice: null,
    currentClose: null,
    holdingBars: null,
    stopBreached: null,
    holdingExpired: null,
    canSell: false,
    pendingExit: false,
  });
}

function reclaimResult(
  status: BearishReclaimResult["status"],
  overrides: Partial<Omit<BearishReclaimResult, "status" | "reference">> = {},
): BearishReclaimResult {
  return Object.freeze({
    status,
    candidate: null,
    entry: null,
    held: emptyHeldEvidence(),
    entryReference: null,
    exitReference: null,
    exitReasons: Object.freeze([]),
    newEntryBlocked: null,
    nextPendingExit: false,
    candidateConsumedNext: false,
    timing: Object.freeze({
      currentCompletedAt: null,
      decisionAt: null,
      decisionAfterCompletion: false,
    }),
    parameters: Object.freeze({
      volumeMultiplier: null,
      stopBuffer: null,
      maxHoldingBars: null,
      riskLimit: null,
    }),
    decisionBarIndex: null,
    reference: "NO_ORDER" as const,
    ...overrides,
  });
}

/**
 * F11.10 close-confirmed full-range reclaim.
 *
 * Candidate D is supplied and frozen by the caller. For an entry it must be
 * the completed bearish bar immediately before the current decision bar, with
 * eligibility strictly before the original decision and D confirmed before the
 * current bar completes. A consumed candidate never switches D implicitly.
 *
 * Held protection is evaluated first and independently. It uses the position's
 * own `frozenStopPrice` and actual `entryBarIndex`, never the latest previous
 * bar. A stop breach or T expiry yields EXIT_REFERENCE only when the position
 * can be sold; otherwise EXIT_PENDING. `nextPendingExit` remains true after an
 * exit intent until the caller reports an actual flat position, because an
 * intent is not a fill.
 */
export function bearishBarReclaim(
  input: BearishBarReclaimInput | null | undefined,
): BearishReclaimResult {
  const bars = input?.bars;
  const barsArray = Array.isArray(bars) ? bars : [];
  const requestedIndex = input?.decisionBarIndex;
  const decisionBarIndex =
    requestedIndex === undefined ? barsArray.length - 1 : requestedIndex;
  const indexValid =
    Number.isInteger(decisionBarIndex) &&
    decisionBarIndex >= 0 &&
    decisionBarIndex < barsArray.length;

  const currentBar = indexValid ? barsArray[decisionBarIndex] : undefined;
  const currentBarOhlcValid =
    hasValidOhlc(currentBar) &&
    dailyBarEpoch((currentBar as Bar).date) !== null;

  const currentCompletedAt = confirmationEpoch(input?.currentCompletedAt);
  const decisionAt = confirmationEpoch(input?.decisionAt);
  const currentDateEpoch = currentBarOhlcValid
    ? dailyBarEpoch(currentBar!.date)
    : null;
  const decisionAfterCompletion =
    currentCompletedAt !== null &&
    decisionAt !== null &&
    currentDateEpoch !== null &&
    currentCompletedAt >= currentDateEpoch &&
    decisionAt >= currentCompletedAt;
  const prefixDates = safeDailyDates(barsArray, decisionBarIndex);
  const prefixDatesValid =
    prefixDates !== null && areDailyDatesStrictlyAscending(prefixDates);
  const protectionDataValid = decisionAfterCompletion && prefixDatesValid;
  const entryBarsValid =
    indexValid && validCompletedPrefix(barsArray, decisionBarIndex);
  const timing = Object.freeze({
    currentCompletedAt,
    decisionAt,
    decisionAfterCompletion,
  });

  const volumeMultiplier = input?.volumeMultiplier;
  const stopBuffer = input?.stopBuffer;
  const maxHoldingBars = input?.maxHoldingBars;
  const riskLimit = input?.riskLimit;
  const parameters = Object.freeze({
    volumeMultiplier: isNonNegativeNumber(volumeMultiplier)
      ? volumeMultiplier
      : null,
    stopBuffer: isNonNegativeNumber(stopBuffer) ? stopBuffer : null,
    maxHoldingBars: isPositiveInteger(maxHoldingBars) ? maxHoldingBars : null,
    riskLimit: isFiniteNumber(riskLimit) && riskLimit > 0 ? riskLimit : null,
  });

  const rawPosition = input?.position;
  const positionPresent = rawPosition !== undefined && rawPosition !== null;
  const positionHeld = positionPresent && rawPosition!.held === true;
  const positionFlatKnown = positionPresent && rawPosition!.held === false;
  const positionInvalid =
    positionPresent && typeof rawPosition!.held !== "boolean";

  let entryBarIndex: number | null = null;
  let frozenStopPrice: number | null = null;
  let canSell = false;
  if (positionHeld) {
    const rawEntryIndex = rawPosition!.entryBarIndex;
    if (
      Number.isInteger(rawEntryIndex) &&
      (rawEntryIndex as number) >= 0 &&
      indexValid &&
      (rawEntryIndex as number) <= decisionBarIndex
    )
      entryBarIndex = rawEntryIndex as number;
    frozenStopPrice = positive(rawPosition!.frozenStopPrice);
    canSell = rawPosition!.canSell === true;
  }

  const currentClose =
    currentBarOhlcValid && decisionAfterCompletion ? currentBar!.close : null;
  const holdingBars =
    positionHeld && entryBarIndex !== null && protectionDataValid
      ? decisionBarIndex - entryBarIndex
      : null;
  const holdingExpired =
    holdingBars !== null && parameters.maxHoldingBars !== null
      ? holdingBars >= parameters.maxHoldingBars
      : null;
  // Current stop evidence needs the current valid completed close and the
  // actual frozen stop. It does not depend on the whole historical prefix;
  // holding duration still does.
  const stopBreached =
    positionHeld && frozenStopPrice !== null && currentClose !== null
      ? currentClose <= frozenStopPrice
      : null;

  const exitReasons: BearishReclaimExitReason[] = [];
  if (positionHeld) {
    if (stopBreached === true) exitReasons.push("STOP_BREACH");
    if (holdingExpired === true) exitReasons.push("HOLDING_EXPIRED");
    // A previously latched pending exit is preserved across bad or missing
    // data, but it never creates a fresh stop/time reason.
    if (input?.pendingExit === true) exitReasons.push("PENDING_EXIT");
  }
  let exitReference: BearishReclaimResult["exitReference"] = null;
  if (positionHeld && exitReasons.length > 0)
    exitReference = canSell ? "EXIT_REFERENCE" : "EXIT_PENDING";
  const nextPendingExit = positionHeld
    ? exitReasons.length > 0 || input?.pendingExit === true
    : positionFlatKnown
      ? false
      : input?.pendingExit === true;

  const held = Object.freeze({
    positionSeen: positionHeld,
    entryBarIndex,
    frozenStopPrice,
    currentClose,
    holdingBars,
    stopBreached,
    holdingExpired,
    canSell,
    pendingExit: input?.pendingExit === true,
  });

  const base = {
    timing,
    held,
    parameters,
    decisionBarIndex: indexValid ? decisionBarIndex : null,
    exitReference,
    exitReasons: Object.freeze([...exitReasons]),
    nextPendingExit,
    candidateConsumedNext: input?.candidate?.consumed === true,
  };

  if (input?.mode !== "full")
    return reclaimResult("UNKNOWN", {
      ...base,
      newEntryBlocked: "MODE_NOT_FULL",
    });
  if (positionInvalid)
    return reclaimResult("UNKNOWN", {
      ...base,
      newEntryBlocked: "INVALID_POSITION",
    });
  if (!indexValid || !currentBarOhlcValid)
    return reclaimResult("UNKNOWN", {
      ...base,
      newEntryBlocked: "INVALID_BARS",
    });
  if (!decisionAfterCompletion)
    return reclaimResult("UNKNOWN", {
      ...base,
      newEntryBlocked: "INVALID_TIMING",
    });
  if (
    parameters.volumeMultiplier === null ||
    parameters.stopBuffer === null ||
    parameters.riskLimit === null
  )
    return reclaimResult("UNKNOWN", {
      ...base,
      newEntryBlocked: "INVALID_ENTRY_PARAMETERS",
    });
  if (!entryBarsValid)
    return reclaimResult("UNKNOWN", {
      ...base,
      newEntryBlocked: "INVALID_BARS",
    });

  const rawCandidate = input?.candidate;
  if (!rawCandidate) {
    return reclaimResult("UNKNOWN", {
      ...base,
      newEntryBlocked: "NO_CANDIDATE",
    });
  }

  const dBarIndex = rawCandidate.dBarIndex;
  const dBar =
    Number.isInteger(dBarIndex) &&
    dBarIndex >= 0 &&
    dBarIndex < decisionBarIndex
      ? barsArray[dBarIndex]
      : undefined;
  const confirmedAt = confirmationEpoch(rawCandidate.confirmedAt);
  const eligibleAt = confirmationEpoch(rawCandidate.eligibleAt);
  const originalDecisionAt = confirmationEpoch(rawCandidate.originalDecisionAt);
  const consumedValid = typeof rawCandidate.consumed === "boolean";
  if (
    !dBar ||
    !validCompletedBar(dBar) ||
    confirmedAt === null ||
    eligibleAt === null ||
    originalDecisionAt === null ||
    !consumedValid
  )
    return reclaimResult("UNKNOWN", {
      ...base,
      newEntryBlocked: "INVALID_CANDIDATE",
    });

  const dDateEpoch = dailyBarEpoch(dBar.date)!;
  const eligibleBeforeOriginalDecision = eligibleAt < originalDecisionAt;
  const fresh =
    dBarIndex === decisionBarIndex - 1 &&
    confirmedAt >= dDateEpoch &&
    confirmedAt <= currentCompletedAt! &&
    confirmedAt <= originalDecisionAt &&
    originalDecisionAt >= currentCompletedAt! &&
    originalDecisionAt <= decisionAt!;
  const bearish = dBar.close < dBar.open;

  const candidateEvidence: BearishReclaimCandidateEvidence = Object.freeze({
    dBarIndex,
    high: dBar.high,
    low: dBar.low,
    volume: dBar.volume,
    bearish,
    confirmedAt,
    eligibleAt,
    originalDecisionAt,
    eligibleBeforeOriginalDecision,
    consumed: rawCandidate.consumed,
    fresh,
  });

  if (!eligibleBeforeOriginalDecision || !fresh)
    return reclaimResult("NO_SIGNAL", {
      ...base,
      candidate: candidateEvidence,
      newEntryBlocked: "STALE_CANDIDATE",
    });

  const priorVolumes = barsArray
    .slice(0, decisionBarIndex)
    .map((bar) => bar.volume);
  const priorVolumeMean =
    priorVolumes.reduce((sum, volume) => sum + volume, 0) / priorVolumes.length;
  const requiredVolume =
    parameters.volumeMultiplier === null
      ? null
      : parameters.volumeMultiplier * priorVolumeMean;
  const closeAboveDHigh = currentBar!.close > dBar.high;
  const volumeAtLeastRequired =
    requiredVolume === null ? null : currentBar!.volume >= requiredVolume;
  const signal = bearish && closeAboveDHigh && volumeAtLeastRequired === true;

  const plannedEntryPrice = positive(input?.plannedEntryPrice);
  const stopPrice =
    parameters.stopBuffer === null ? null : dBar.low - parameters.stopBuffer;
  const riskDistance =
    plannedEntryPrice !== null && stopPrice !== null
      ? plannedEntryPrice - stopPrice
      : null;
  const riskFraction =
    plannedEntryPrice !== null && plannedEntryPrice > 0 && riskDistance !== null
      ? riskDistance / plannedEntryPrice
      : null;
  const planEntryAboveStop = riskDistance !== null && riskDistance > 0;
  const riskWithinLimit =
    planEntryAboveStop && riskFraction !== null && parameters.riskLimit !== null
      ? riskFraction <= parameters.riskLimit
      : null;

  const entryEvidence: BearishReclaimEntryEvidence = Object.freeze({
    currentClose: currentBar!.close,
    currentVolume: currentBar!.volume,
    priorVolumeMean,
    requiredVolume,
    closeAboveDHigh,
    volumeAtLeastRequired,
    stopPrice,
    plannedEntryPrice,
    riskDistance,
    riskFraction,
    riskWithinLimit,
  });

  if (!signal)
    return reclaimResult("NO_SIGNAL", {
      ...base,
      candidate: candidateEvidence,
      entry: entryEvidence,
      newEntryBlocked: "NO_SIGNAL",
    });

  if (plannedEntryPrice === null)
    return reclaimResult("UNKNOWN", {
      ...base,
      candidate: candidateEvidence,
      entry: entryEvidence,
      newEntryBlocked: "MISSING_PLANNED_PRICE",
    });
  if (positionHeld)
    return reclaimResult("SIGNAL", {
      ...base,
      candidate: candidateEvidence,
      entry: entryEvidence,
      newEntryBlocked: "POSITION_HELD",
    });
  if (rawCandidate.consumed)
    return reclaimResult("SIGNAL", {
      ...base,
      candidate: candidateEvidence,
      entry: entryEvidence,
      newEntryBlocked: "CANDIDATE_CONSUMED",
    });
  if (!positionFlatKnown)
    return reclaimResult("UNKNOWN", {
      ...base,
      candidate: candidateEvidence,
      entry: entryEvidence,
      newEntryBlocked: "POSITION_UNKNOWN",
    });
  if (stopPrice === null || stopPrice <= 0)
    return reclaimResult("UNKNOWN", {
      ...base,
      candidate: candidateEvidence,
      entry: entryEvidence,
      newEntryBlocked: "INVALID_STOP",
    });
  if (!planEntryAboveStop)
    return reclaimResult("SIGNAL", {
      ...base,
      candidate: candidateEvidence,
      entry: entryEvidence,
      newEntryBlocked: "PLAN_ENTRY_NOT_ABOVE_STOP",
    });
  if (riskWithinLimit !== true)
    return reclaimResult("SIGNAL", {
      ...base,
      candidate: candidateEvidence,
      entry: entryEvidence,
      newEntryBlocked: "RISK_ABOVE_LIMIT",
    });

  return reclaimResult("SIGNAL", {
    ...base,
    candidate: candidateEvidence,
    entry: entryEvidence,
    entryReference: "ENTRY_REFERENCE",
    candidateConsumedNext: true,
  });
}
