import type { Bar } from "../../domain";
export const researchLiquidityVersion = "research-liquidity-1";
export function researchLiquidity(
  bars: readonly Bar[],
  calendar: readonly string[],
  date: string,
) {
  const index = calendar.indexOf(date);
  const expected = index >= 20 ? calendar.slice(index - 20, index) : [];
  const window = bars.filter((b) => b.date < date).slice(-20);
  const ready =
    expected.length === 20 &&
    window.length === 20 &&
    window.every(
      (b, i) =>
        b.date === expected[i] &&
        Number.isFinite(b.amount) &&
        b.amount > 0 &&
        Number.isFinite(b.volume) &&
        b.volume > 0,
    );
  const meanAmount = ready
    ? window.reduce((sum, b) => sum + b.amount, 0) / 20
    : null;
  const valid =
    meanAmount != null && Number.isFinite(meanAmount) && meanAmount > 0;
  return {
    date,
    observedDate: expected.at(-1) ?? null,
    windowStart: expected[0] ?? null,
    meanAmount: valid ? meanAmount : null,
    maxPositionValue: valid ? meanAmount * 0.01 : null,
    amountUnit: "yuan" as const,
    reason: valid ? null : "缺少前20个连续交易日有效成交额，容量约束暂停买入",
  };
}
