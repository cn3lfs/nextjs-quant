import { classifyCode } from "./delivery-import";
import type { ReviewValue } from "./trade-review";
import type { NavDay } from "./trade-review-nav";

export type CorrelationValue = ReviewValue & { overlapDays: number };
export type HoldingsCorrelationInput = {
  days: readonly Pick<NavDay, "date" | "positions">[];
  tradingDays: readonly string[];
  bars: Readonly<Record<string, readonly { date: string; close: number }[]>>;
};
export const correlationMinimumDays = 20;

/** invariants §1 U5：数量只决定证券集合，收益严格来自相邻交易日收盘价。 */
export function holdingsCorrelation(input: HoldingsCorrelationInput) {
  const symbols = [
    ...new Set(
      input.days.flatMap((day) =>
        Object.entries(day.positions)
          .filter(
            ([symbol, quantity]) =>
              quantity !== 0 &&
              classifyCode(symbol).instrument !== "reverseRepo",
          )
          .map(([symbol]) => symbol),
      ),
    ),
  ].sort();
  const calendar = [...new Set(input.tradingDays)].sort();
  const start = input.days[0]?.date;
  const end = input.days.at(-1)?.date;
  const returns = symbols.map((symbol) => {
    const closes = new Map<string, number>();
    for (const bar of input.bars[symbol] ?? []) {
      // 重复日期也不能任取一条制造可得收益。
      closes.set(bar.date, closes.has(bar.date) ? NaN : bar.close);
    }
    const series = new Map<string, number>();
    for (let i = 1; i < calendar.length; i++) {
      const date = calendar[i]!;
      if (!start || !end || date < start || date > end) continue;
      const previous = closes.get(calendar[i - 1]!) ?? NaN;
      const close = closes.get(date) ?? NaN;
      const value = close / previous - 1;
      if (
        previous > 0 &&
        close > 0 &&
        Number.isFinite(previous) &&
        Number.isFinite(close) &&
        Number.isFinite(value)
      )
        series.set(date, value);
    }
    return series;
  });
  const matrix: CorrelationValue[][] = symbols.map(() => []);
  let total = 0;
  const pairCount = { available: 0, insufficient: 0 };
  for (let i = 0; i < symbols.length; i++) {
    for (let j = i; j < symbols.length; j++) {
      const pairs = [...returns[i]!].flatMap(([date, x]) => {
        const y = returns[j]!.get(date);
        return y === undefined ? [] : [[x, y] as const];
      });
      const overlapDays = pairs.length;
      let reason: string | null =
        overlapDays < correlationMinimumDays
          ? "重叠交易日不足 20，相关性不可靠"
          : null;
      let value: number | null = null;
      if (!reason) {
        const mx = pairs.reduce((s, p) => s + p[0], 0) / overlapDays;
        const my = pairs.reduce((s, p) => s + p[1], 0) / overlapDays;
        let xx = 0,
          yy = 0,
          xy = 0;
        for (const [x, y] of pairs) {
          xx += (x - mx) ** 2;
          yy += (y - my) ** 2;
          xy += (x - mx) * (y - my);
        }
        if (![xx, yy, xy].every(Number.isFinite)) reason = "相关性计算溢出";
        else if (xx === 0 || yy === 0)
          reason = "日价格收益零方差，Pearson 相关性无定义";
        else {
          value = i === j ? 1 : xy / Math.sqrt(xx) / Math.sqrt(yy);
          if (!Number.isFinite(value)) {
            value = null;
            reason = "相关性计算溢出";
          }
        }
      }
      const cell = { value, reason, overlapDays };
      matrix[i]![j] = cell;
      matrix[j]![i] = cell;
      if (i !== j) {
        if (value === null) pairCount.insufficient++;
        else {
          pairCount.available++;
          total += value;
        }
      }
    }
  }
  return {
    symbols,
    matrix,
    pairCount,
    averagePairwise: {
      value: pairCount.available ? total / pairCount.available : null,
      reason: pairCount.available ? null : "无可得证券对",
    } satisfies ReviewValue,
  };
}
