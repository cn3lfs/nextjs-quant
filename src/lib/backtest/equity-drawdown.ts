export type EquityPoint = { date: string; value: number };

/** Percent below the running peak at each point (0 at new highs, negative otherwise). */
export function drawdownCurve(equity: readonly EquityPoint[]): EquityPoint[] {
  let peak = -Infinity;
  return equity.map(({ date, value }) => {
    peak = Math.max(peak, value);
    return { date, value: peak > 0 ? (value / peak - 1) * 100 : 0 };
  });
}

/** Percent return of each point over the curve's first value. */
export function returnCurve(equity: readonly EquityPoint[]): EquityPoint[] {
  const base = equity[0]?.value ?? 0;
  return equity.map(({ date, value }) => ({
    date,
    value: base > 0 ? (value / base - 1) * 100 : 0,
  }));
}
