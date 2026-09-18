import Big from "big.js";

/** Shared Big.js decimal arithmetic for money, fee and quantity-rounding
 * computations. Plain double arithmetic accumulates dust like
 * `1000.000000000004` over many trades (repeated +=/-= on cash, weighted
 * cost blending, bps fee math). Every money/rate computation in the
 * execution, position-book, risk and portfolio layers must route through
 * these helpers; only the final value handed back to callers/serialization
 * is a plain `number` — the wire shape and all field types are unchanged.
 *
 * DP=28 is generous headroom (inputs are at most price*quantity with a few
 * bps divisions); rounding only ever happens implicitly via IEEE754 when
 * `toNumber` converts the exact decimal result back to a double, exactly
 * once per expression instead of once per intermediate operation. */
Big.DP = 28;
Big.RM = Big.roundHalfUp;

export type Numeric = number | string | Big;

export function big(value: Numeric): Big {
  return value instanceof Big ? value : new Big(value);
}

/** Convert a Big back to a plain JS number for storage/serialization. */
export function toNumber(value: Big): number {
  return Number(value.toString());
}

/** amount * bps / 10000 computed as exact decimal arithmetic, returned as a
 * plain number. Used for commission/tax/slippage-style basis-point fees. */
export function bpsOf(amount: Numeric, bps: Numeric): number {
  return toNumber(big(amount).times(bps).div(10000));
}

/** quantity * price, exact decimal multiplication, returned as a number. */
export function moneyMul(a: Numeric, b: Numeric): number {
  return toNumber(big(a).times(b));
}

/** floor(value) via exact decimal arithmetic, matching `Math.floor` exactly.
 *
 * Big's `roundDown` truncates toward zero while `Math.floor` — which every
 * call site here replaced — goes toward negative infinity, so the two differ
 * for negatives (`Math.floor(-1.5)` is -2, truncation gives -1). A negative
 * input is reachable: `researchBuyQuantity` feeds
 * `(budget - minimumCommission) / price`, which goes negative once the budget
 * cannot even cover the minimum commission. The difference happens to be inert
 * there (both -1 and 0 fall below a positive `minimumBuy`, so both yield a
 * zero order), but implement true floor rather than leave the direction as an
 * unchecked assumption — throwing instead would turn that reachable path into
 * a crash. */
export function bigFloor(value: Numeric): number {
  const decimal = big(value);
  const truncated = decimal.round(0, Big.roundDown);
  return toNumber(
    decimal.lt(0) && !decimal.eq(truncated) ? truncated.minus(1) : truncated,
  );
}

/** Big.js has no static min/max; this mirrors Math.min semantics. */
export function bigMin(...values: Numeric[]): Big {
  return values.map(big).reduce((a, b) => (b.lt(a) ? b : a));
}
