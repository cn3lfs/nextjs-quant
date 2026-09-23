import Big from "big.js";

/** Shared Big.js decimal arithmetic for strategy money and quantity paths. */
Big.DP = 28;
Big.RM = Big.roundHalfUp;

export type Numeric = number | string | Big;

export function big(value: Numeric): Big {
  return value instanceof Big ? value : new Big(value);
}

export function toNumber(value: Big): number {
  return Number(value.toString());
}

export function bpsOf(amount: Numeric, bps: Numeric): number {
  return toNumber(big(amount).times(bps).div(10000));
}

export function moneyMul(a: Numeric, b: Numeric): number {
  return toNumber(big(a).times(b));
}

export function bigFloor(value: Numeric): number {
  const decimal = big(value);
  const truncated = decimal.round(0, Big.roundDown);
  return toNumber(
    decimal.lt(0) && !decimal.eq(truncated) ? truncated.minus(1) : truncated,
  );
}

export function bigMin(...values: Numeric[]): Big {
  return values.map(big).reduce((a, b) => (b.lt(a) ? b : a));
}
