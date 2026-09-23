import type { Bar } from "../../domain";

/** Planned second tranche, distinct from the skill's decreasing winner pyramid.
 * Confirmation clock starts at the original breakout; it is never reset by a
 * late first fill. A confirmed order has its own execution waiting deadline. */
export function researchPullbackConfirmation(input: {
  bar: Bar | undefined;
  level: number;
  age: number;
  waitBars: number;
  tolerance: number;
  requireProfit: boolean;
  quantity: number;
  cost: number;
  alreadyConfirmed: boolean;
}) {
  const { bar, level } = input;
  const valid =
    !!bar &&
    bar.volume > 0 &&
    Number.isFinite(bar.volume) &&
    [bar.open, bar.high, bar.low, bar.close, level].every(
      (x) => Number.isFinite(x) && x > 0,
    ) &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close);
  const profit = !!bar && bar.close * input.quantity > input.cost;
  const status =
    !valid || bar!.low < level
      ? "cancelled"
      : !input.alreadyConfirmed && input.age > input.waitBars
        ? "expired"
        : !input.alreadyConfirmed &&
            input.age > 0 &&
            bar!.low <= level * (1 + input.tolerance) &&
            bar!.close >= level &&
            (!input.requireProfit || profit)
          ? "confirmed"
          : "waiting";
  return {
    status,
    date: bar?.date ?? null,
    level,
    age: input.age,
    low: bar?.low ?? null,
    close: bar?.close ?? null,
    profit,
  } as const;
}
