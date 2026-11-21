export type Market = "cn-equity" | "crypto" | "futures";
export type Atoms = bigint;

export const atomScales: Readonly<
  Record<Market, { money: number; quantity: number; price: number }>
> = {
  "cn-equity": { money: 2, quantity: 0, price: 8 },
  crypto: { money: 8, quantity: 8, price: 8 },
  futures: { money: 2, quantity: 0, price: 8 },
};

const pow10 = (digits: number) => 10n ** BigInt(digits);

export function parseDecimal(value: string | number, digits: number): Atoms {
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("数值必须有限");
  const text = typeof value === "number" ? value.toString() : value.trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text))
    throw new Error(`非法十进制数值：${text}`);
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  if (fraction.length > digits)
    throw new Error(`小数位超过 ${digits} 位：${text}`);
  const atoms =
    BigInt(whole) * pow10(digits) +
    BigInt((fraction + "0".repeat(digits)).slice(0, digits) || "0");
  return negative ? -atoms : atoms;
}

export function formatDecimal(value: Atoms, digits: number): string {
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  const scale = pow10(digits);
  const whole = unsigned / scale;
  const fraction = (unsigned % scale)
    .toString()
    .padStart(digits, "0")
    .replace(/0+$/, "");
  const body = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative ? `-${body}` : body;
}

/** Half-up division at the destination atom scale. */
function divHalfUp(numerator: Atoms, denominator: Atoms): Atoms {
  if (denominator <= 0n) throw new Error("除数必须为正");
  const negative = numerator < 0n;
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / 2n) / denominator;
  return negative ? -rounded : rounded;
}

export function bpsOf(amount: Atoms, bps: number): Atoms {
  if (!Number.isFinite(bps) || bps < 0)
    throw new Error("费用基点必须为非负有限数");
  return divHalfUp(
    amount * BigInt(Math.round(bps * 10_000)),
    10_000n * 10_000n,
  );
}

/** quantity × price → money at the market money scale. */
export function notional(quantity: Atoms, price: Atoms, market: Market): Atoms {
  const scale = atomScales[market];
  const product = quantity * price;
  const denominator = pow10(scale.quantity + scale.price - scale.money);
  return denominator === 1n ? product : divHalfUp(product, denominator);
}

/** price × (1 ± slippageBps/10000) at the price scale. */
export function slippedPrice(
  price: Atoms,
  side: "buy" | "sell",
  slippageBps: number,
): Atoms {
  const sign = side === "buy" ? 1n : -1n;
  const delta = sign * BigInt(Math.round(slippageBps * 10_000));
  return divHalfUp(price * (10_000n * 10_000n + delta), 10_000n * 10_000n);
}

export function sum(values: readonly Atoms[]): Atoms {
  return values.reduce((total, value) => total + value, 0n);
}

/** quantity × per-share cash amount → money at the market money scale. */
export function mulQuantity(
  quantity: Atoms,
  perShare: Atoms,
  market: Market,
): Atoms {
  return divHalfUp(quantity * perShare, pow10(atomScales[market].quantity));
}

export function scaleAtoms(
  value: Atoms,
  factor: number,
  mode: "half-up" | "floor" = "half-up",
): Atoms {
  if (!Number.isFinite(factor) || factor < 0)
    throw new Error("比例必须为非负有限数");
  const numerator = value * BigInt(Math.round(factor * 100_000_000));
  const denominator = 100_000_000n;
  if (mode === "floor") return numerator / denominator;
  return divHalfUp(numerator, denominator);
}
