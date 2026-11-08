import type { Bar } from "./model.js";
/** Ex-post price-index attribution at the portfolio's realized exposures.
 * Overnight and intraday are separated because trades occur at the open.
 * No claim of index tradability, cost equivalence or dividend neutrality.
 */
export function matchCsi800Exposure(input: {
  initial: number;
  curve: readonly {
    date: string;
    equity: number;
    cash: number;
    exposure: number;
  }[];
  snapshots: readonly {
    date: string;
    symbol: string;
    quantity: number;
    weight: number;
  }[];
  benchmark: readonly Bar[];
  stocks: readonly { symbol: string; bars: readonly Bar[] }[];
}) {
  const index = new Map(input.benchmark.map((b, i) => [b.date, i]));
  const quotes = new Map(
    input.stocks.map((s) => [
      s.symbol,
      new Map(s.bars.map((b) => [b.date, b.open])),
    ]),
  );
  const positions = new Map<string, (typeof input.snapshots)[number][]>();
  for (const p of input.snapshots) {
    const rows = positions.get(p.date) ?? [];
    rows.push(p);
    positions.set(p.date, rows);
  }
  let value = input.initial,
    previousExposure = 0;
  if (!(value > 0) || !Number.isFinite(value))
    throw new Error("归因初始权益非法");
  return input.curve.map((row) => {
    const i = index.get(row.date);
    if (
      i === undefined ||
      i < 1 ||
      !Number.isFinite(row.equity) ||
      !(row.equity > 0) ||
      !Number.isFinite(row.cash) ||
      row.cash < 0
    )
      throw new Error("归因日期/权益/现金非法");
    const dayPositions = positions.get(row.date) ?? [];
    if (
      dayPositions.some(
        (p) =>
          !quotes.has(p.symbol) ||
          !Number.isFinite(p.quantity) ||
          p.quantity < 0 ||
          !Number.isFinite(p.weight) ||
          p.weight < 0,
      )
    )
      throw new Error("归因持仓非法");
    if (
      Math.abs(
        row.cash +
          dayPositions.reduce((s, p) => s + p.weight * row.equity, 0) -
          row.equity,
      ) >
      Math.max(1, row.equity) * 1e-8
    )
      throw new Error("归因持仓与净资产不一致");
    // Quantities are unchanged after the single opening execution batch.
    // A suspended stock's close mark is also its carried opening mark.
    const openingValue = dayPositions.reduce((sum, p) => {
      const open = quotes.get(p.symbol)?.get(row.date);
      return (
        sum + (open === undefined ? p.weight * row.equity : p.quantity * open)
      );
    }, 0);
    const openingEquity = openingValue + row.cash;
    const openExposure = openingEquity > 0 ? openingValue / openingEquity : 0;
    if (
      !Number.isFinite(openExposure) ||
      openExposure < 0 ||
      openExposure > 1 ||
      !Number.isFinite(row.exposure) ||
      row.exposure < 0 ||
      row.exposure > 1 + 1e-12
    )
      throw new Error("归因仓位非法");
    const b = input.benchmark[i]!,
      previous = input.benchmark[i - 1]!;
    const overnight = b.open / previous.close - 1,
      intraday = b.close / b.open - 1;
    if (
      !Number.isFinite(overnight) ||
      !Number.isFinite(intraday) ||
      overnight <= -1 ||
      intraday <= -1
    )
      throw new Error("归因基准价格非法");
    value *= (1 + previousExposure * overnight) * (1 + openExposure * intraday);
    const point = {
      date: row.date,
      value,
      overnightExposure: previousExposure,
      openExposure,
      benchmarkReturn: b.close / previous.close - 1,
    };
    previousExposure = Math.min(1, row.exposure);
    return point;
  });
}
