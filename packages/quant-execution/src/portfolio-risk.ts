import { big } from "trading-strategy-core/money";
import { resolveInstrumentRule } from "./instrument-rules.js";

/** All percentages are fractions of equity; ATR and stops use fill-price units. */
export type PortfolioRiskPolicy = {
  reduceThreshold: number;
  pauseThreshold: number;
  recoverThreshold: number;
  recoverConsecutiveDays: number;
  reducedScale: number;
  maxTotalStopRisk: number;
  maxIndustryWeight: number;
  maxSingleInstrumentWeight: number;
  /** Null inherits the single-instrument limit. */
  maxEtfWeight: number | null;
  riskPerTrade: number;
  atrStopMultiple: number;
  /** Applied to marked holdings with no stop. Null blocks additional entries. */
  missingStopFraction: number | null;
};
export const defaultPortfolioRiskPolicy: Readonly<PortfolioRiskPolicy> =
  Object.freeze({
    reduceThreshold: 0.05,
    pauseThreshold: 0.08,
    recoverThreshold: 0.03,
    recoverConsecutiveDays: 3,
    reducedScale: 0.5,
    maxTotalStopRisk: 0.05,
    maxIndustryWeight: 0.25,
    maxSingleInstrumentWeight: 0.1,
    maxEtfWeight: null,
    riskPerTrade: 0.005,
    atrStopMultiple: 2,
    missingStopFraction: 0.1,
  });

const positive = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v) && v > 0;
const fraction = (v: number) => Number.isFinite(v) && v >= 0 && v <= 1;

function policyFor(overrides?: Partial<PortfolioRiskPolicy>) {
  const p = { ...defaultPortfolioRiskPolicy, ...overrides };
  if (
    ![
      p.reduceThreshold,
      p.pauseThreshold,
      p.recoverThreshold,
      p.reducedScale,
      p.maxTotalStopRisk,
      p.maxIndustryWeight,
      p.maxSingleInstrumentWeight,
      p.riskPerTrade,
    ].every(fraction) ||
    !(
      p.recoverThreshold < p.reduceThreshold &&
      p.reduceThreshold < p.pauseThreshold
    ) ||
    !Number.isSafeInteger(p.recoverConsecutiveDays) ||
    p.recoverConsecutiveDays < 1 ||
    !positive(p.atrStopMultiple) ||
    (p.maxEtfWeight !== null && !fraction(p.maxEtfWeight)) ||
    (p.missingStopFraction !== null &&
      !(positive(p.missingStopFraction) && fraction(p.missingStopFraction)))
  )
    throw new RangeError("Invalid portfolio risk policy");
  return p;
}

export type PortfolioRiskState = {
  date: string;
  unitNav: number;
  peakUnitNav: number;
  drawdown: number;
  mode: "normal" | "reduced" | "paused";
  scale: number;
  recoveryCloses: number;
};
function validCloseDate(date: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date
  );
}
function validState(s: PortfolioRiskState) {
  return (
    validCloseDate(s.date) &&
    Number.isFinite(s.unitNav) &&
    s.unitNav >= 0 &&
    positive(s.peakUnitNav) &&
    s.peakUnitNav >= Math.max(1, s.unitNav) &&
    fraction(s.drawdown) &&
    Math.abs(1 - s.unitNav / s.peakUnitNav - s.drawdown) <= 1e-12 &&
    Number.isSafeInteger(s.recoveryCloses) &&
    s.recoveryCloses >= 0 &&
    ((s.mode === "normal" && s.scale === 1 && s.recoveryCloses === 0) ||
      (s.mode === "reduced" && fraction(s.scale)) ||
      (s.mode === "paused" && s.scale === 0))
  );
}

/** Advance once per completed exchange session, in chronological order.
 * The caller supplies cash-flow-adjusted NAV with an inception value of 1. */
export function evaluatePortfolioRisk(input: {
  date: string;
  unitNav: number;
  previous?: PortfolioRiskState | null;
  /** Optional exchange-calendar predecessor. Skipped sessions break a recovery streak. */
  previousSessionDate?: string;
  policy?: Partial<PortfolioRiskPolicy>;
}): PortfolioRiskState {
  const { date, unitNav, previous } = input;
  if (!validCloseDate(date) || !Number.isFinite(unitNav) || unitNav < 0)
    throw new RangeError("Invalid completed close or adjusted unit NAV");
  if (previous && !validState(previous))
    throw new RangeError("Invalid previous portfolio risk close");
  if (previous && date <= previous.date) {
    if (date === previous.date && unitNav === previous.unitNav) return previous;
    throw new RangeError("Conflicting or out-of-order portfolio risk close");
  }
  const p = policyFor(input.policy);
  const peakUnitNav = Math.max(previous?.peakUnitNav ?? 1, unitNav);
  const drawdown = big(peakUnitNav).minus(unitNav).div(peakUnitNav).toNumber();
  let mode = previous?.mode ?? "normal";
  let recoveryCloses = 0;
  if (drawdown >= p.pauseThreshold) mode = "paused";
  else if (drawdown >= p.reduceThreshold && mode === "normal") mode = "reduced";
  else if (mode !== "normal" && drawdown <= p.recoverThreshold) {
    const consecutive =
      input.previousSessionDate === undefined ||
      previous?.date === input.previousSessionDate;
    recoveryCloses = (consecutive ? (previous?.recoveryCloses ?? 0) : 0) + 1;
    if (recoveryCloses >= p.recoverConsecutiveDays) {
      mode = "normal";
      recoveryCloses = 0;
    }
  }
  return {
    date,
    unitNav,
    peakUnitNav,
    drawdown,
    mode,
    scale: mode === "normal" ? 1 : mode === "reduced" ? p.reducedScale : 0,
    recoveryCloses,
  };
}

/** Freeze the retained exposure only when a newly completed close enters reduced mode. */
export function drawdownReductionScale(
  previous: PortfolioRiskState | undefined,
  current: PortfolioRiskState,
): number | null {
  return (previous?.mode ?? "normal") === "normal" &&
    current.mode === "reduced" &&
    current.scale < 1
    ? current.scale
    : null;
}

export type PortfolioRiskHolding = {
  symbol: string;
  quantity: number;
  mark: number;
  stopPrice?: number | null;
  industry?: string | null;
};
export type EntryRiskRule = {
  kind: "etf" | "stock" | "crypto";
  minimumBuyQuantity: number;
  buyQuantityStep: number;
};
export type PortfolioRiskEntry = {
  /** Pre-order net liquidation value, marked with information available at entry. */
  equity: number;
  cash: number;
  positions: readonly PortfolioRiskHolding[];
  symbol: string;
  date: string;
  price: number;
  industry?: string | null;
  stopPrice?: number | null;
  atr?: number | null;
  requestedQuantity?: number;
  state?: PortfolioRiskState | null;
  policy?: Partial<PortfolioRiskPolicy>;
  rule?: EntryRiskRule;
  /** Monotonically increasing all-in cost of a buy, including notional and fees. */
  cashCost?: (quantity: number) => number;
};
export type PortfolioRiskReason =
  | "drawdown_paused"
  | "drawdown_reduced"
  | "total_stop_risk_cap"
  | "industry_cap"
  | "instrument_cap"
  | "trade_risk_cap"
  | "cash_cap"
  | "missing_stop"
  | "stop_already_triggered"
  | "invalid_position"
  | "invalid_entry"
  | "lot_rounded_zero";
export type PortfolioRiskDecision = {
  quantity: number;
  stopPrice: number | null;
  reasons: PortfolioRiskReason[];
  existingStopRisk: number | null;
  stopRiskAfter: number | null;
};

function exposure(input: PortfolioRiskEntry, p: PortfolioRiskPolicy) {
  let risk = big(0),
    industryValue = big(0),
    instrumentValue = big(0);
  const industry = input.industry?.trim() || "unknown";
  for (const held of input.positions) {
    if (held.quantity === 0) continue;
    if (
      !positive(held.quantity) ||
      !positive(held.mark) ||
      (held.stopPrice != null && !positive(held.stopPrice))
    )
      return "invalid_position";
    if (held.stopPrice == null && p.missingStopFraction === null)
      return "missing_stop";
    const value = big(held.mark).times(held.quantity);
    const distance =
      held.stopPrice == null
        ? big(held.mark).times(p.missingStopFraction!)
        : big(held.mark).minus(held.stopPrice);
    if (distance.gt(0)) risk = risk.plus(distance.times(held.quantity));
    if (held.symbol === input.symbol)
      instrumentValue = instrumentValue.plus(value);
    if ((held.industry?.trim() || "unknown") === industry)
      industryValue = industryValue.plus(value);
  }
  return { risk, industryValue, instrumentValue };
}

/** Intersect risk limits in share units, then apply drawdown scaling and
 * round down to a legal buy. No sale, liquidation or order is generated. */
export function sizeEntryWithRisk(
  input: PortfolioRiskEntry,
): PortfolioRiskDecision {
  const p = policyFor(input.policy);
  const reasons: PortfolioRiskReason[] = [];
  const result: PortfolioRiskDecision = {
    quantity: 0,
    stopPrice: null,
    reasons,
    existingStopRisk: null,
    stopRiskAfter: null,
  };
  const reject = (reason: PortfolioRiskReason) => {
    reasons.push(reason);
    return result;
  };
  if (
    !positive(input.equity) ||
    !(Number.isFinite(input.cash) && input.cash >= 0) ||
    !positive(input.price) ||
    (input.state &&
      (!validState(input.state) ||
        input.state.date > input.date.slice(0, 10))) ||
    (input.requestedQuantity !== undefined &&
      !(
        Number.isFinite(input.requestedQuantity) && input.requestedQuantity >= 0
      ))
  )
    return reject("invalid_entry");
  const held = exposure(input, p);
  if (typeof held === "string") return reject(held);
  result.existingStopRisk = result.stopRiskAfter = held.risk.toNumber();
  if (input.state?.mode === "paused") return reject("drawdown_paused");
  const stop =
    input.stopPrice ??
    (positive(input.atr)
      ? big(input.price)
          .minus(big(input.atr).times(p.atrStopMultiple))
          .toNumber()
      : null);
  if (!positive(stop)) return reject("missing_stop");
  if (stop >= input.price)
    return reject(
      input.stopPrice == null ? "missing_stop" : "stop_already_triggered",
    );
  result.stopPrice = stop;
  const rule = input.rule ?? resolveInstrumentRule(input.symbol, input.date);
  const { minimumBuyQuantity: minimum, buyQuantityStep: step } = rule;
  if (!positive(minimum) || !positive(step)) return reject("invalid_entry");
  const equity = big(input.equity),
    riskPerShare = big(input.price).minus(stop);
  const cap =
    rule.kind === "etf"
      ? (p.maxEtfWeight ?? p.maxSingleInstrumentWeight)
      : p.maxSingleInstrumentWeight;
  const limits: [PortfolioRiskReason, ReturnType<typeof big>][] = [
    ["cash_cap", big(input.cash).div(input.price)],
    ["trade_risk_cap", equity.times(p.riskPerTrade).div(riskPerShare)],
    [
      "total_stop_risk_cap",
      equity.times(p.maxTotalStopRisk).minus(held.risk).div(riskPerShare),
    ],
    [
      "industry_cap",
      equity
        .times(p.maxIndustryWeight)
        .minus(held.industryValue)
        .div(input.price),
    ],
    [
      "instrument_cap",
      equity.times(cap).minus(held.instrumentValue).div(input.price),
    ],
  ];
  let base = big(input.requestedQuantity ?? limits[0]![1]);
  for (const [, limit] of limits) if (limit.lt(base)) base = limit;
  for (const [reason, limit] of limits) {
    if (
      limit.eq(base) &&
      (input.requestedQuantity === undefined ||
        base.lt(input.requestedQuantity))
    )
      reasons.push(reason);
  }
  if (input.cashCost && base.gte(minimum)) {
    const breached = (q: number): PortfolioRiskReason | null => {
      const allIn = input.cashCost!(q);
      const value = big(input.price).times(q);
      if (!Number.isFinite(allIn) || allIn < value.toNumber() - 1e-8)
        throw new RangeError("Invalid all-in entry cost");
      if (allIn > input.cash) return "cash_cap";
      const netEquity = equity.minus(big(allIn).minus(value));
      if (
        held.risk
          .plus(riskPerShare.times(q))
          .gt(netEquity.times(p.maxTotalStopRisk))
      )
        return "total_stop_risk_cap";
      if (
        held.industryValue.plus(value).gt(netEquity.times(p.maxIndustryWeight))
      )
        return "industry_cap";
      if (held.instrumentValue.plus(value).gt(netEquity.times(cap)))
        return "instrument_cap";
      return null;
    };
    // Fees reduce both available cash and the equity supporting hard exposure limits.
    const steps = base.minus(minimum).div(step).round(0, 0).toNumber();
    if (!Number.isSafeInteger(steps)) return reject("invalid_entry");
    const lot = (index: number) =>
      big(minimum).plus(big(step).times(index)).toNumber();
    const violation = breached(lot(steps));
    if (violation) {
      if (!reasons.includes(violation)) reasons.push(violation);
      let lo = -1,
        hi = steps;
      while (hi - lo > 1) {
        const mid = lo + Math.floor((hi - lo) / 2);
        if (!breached(lot(mid))) lo = mid;
        else hi = mid;
      }
      base = big(lo < 0 ? 0 : lot(lo));
    }
  }
  if (input.state?.mode === "reduced") {
    reasons.push("drawdown_reduced");
    base = base.times(input.state.scale);
  }
  if (base.lt(minimum)) return reject("lot_rounded_zero");
  result.quantity = base
    .minus(minimum)
    .div(step)
    .round(0, 0)
    .times(step)
    .plus(minimum)
    .toNumber();
  result.stopRiskAfter = held.risk
    .plus(riskPerShare.times(result.quantity))
    .toNumber();
  return result;
}

type RangeBar = { high: number; low: number; close: number };
/** Fourteen full true ranges seed Wilder's recurrence. Each TR requires the
 * prior close. A bad observation breaks the series and forces a fresh seed. */
export function wilderAtr14Series(
  bars: readonly RangeBar[],
): (number | null)[] {
  let previousClose: number | null = null,
    value: number | null = null,
    count = 0,
    sum = 0;
  return bars.map(({ high, low, close }) => {
    if (![high, low, close].every(positive) || low > close || close > high) {
      previousClose = value = null;
      count = sum = 0;
      return null;
    }
    if (previousClose !== null) {
      const tr = Math.max(
        high - low,
        Math.abs(high - previousClose),
        Math.abs(low - previousClose),
      );
      if (value !== null) value = (13 * value + tr) / 14;
      else {
        sum += tr;
        if (++count === 14) value = sum / 14;
      }
    }
    previousClose = close;
    return value;
  });
}
export function wilderAtr14(bars: readonly RangeBar[]): number | null {
  return wilderAtr14Series(bars).at(-1) ?? null;
}
