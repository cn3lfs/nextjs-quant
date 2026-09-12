import type { BacktestCosts } from "./backtest-costs";
import type { Bar } from "./domain";
import type { researchPortfolio } from "../server/research-portfolio";

export type WeightRow = { dt: string; symbol: string; weight: number | null };
export type ReturnRow = { dt: string; symbol: string; value: number | null };

/** Full close snapshots; omitted symbols are cash (zero), not forward-filled.
 * Null weights mean unknown. Calendar is explicit; never bridge missing bars.
 * U7a / invariants §3: only yesterday's snapshot earns today's price return.
 * The symmetric single-side rate is commissionBps; minimum commission,
 * sell tax and execution-price slippage cannot be represented by that rate.
 */
export function weightBacktest(
  calendar: readonly string[],
  weights: readonly WeightRow[],
  returns: readonly ReturnRow[],
  costs: BacktestCosts,
) {
  if (calendar.some((dt, i) => i > 0 && dt <= calendar[i - 1]!))
    throw new Error("交易日历必须严格递增");
  if (!Number.isFinite(costs.commissionBps) || costs.commissionBps < 0)
    throw new Error("费率无效");
  const days = new Set(calendar);
  const snapshots = new Map<string, Map<string, number | null>>();
  const prices = new Map<string, Map<string, number | null>>();
  for (const row of weights) {
    if (
      !days.has(row.dt) ||
      !row.symbol ||
      (row.weight !== null &&
        (!Number.isFinite(row.weight) || row.weight < 0 || row.weight > 1))
    )
      throw new Error("权重无效");
    const snapshot = snapshots.get(row.dt) ?? new Map<string, number | null>();
    if (snapshot.has(row.symbol)) throw new Error("重复权重");
    snapshot.set(row.symbol, row.weight);
    snapshots.set(row.dt, snapshot);
  }
  for (const snapshot of snapshots.values())
    if (
      [...snapshot.values()].reduce<number>((sum, w) => sum + (w ?? 0), 0) >
      1 + 1e-10
    )
      throw new Error("权重合计超过一");
  for (const row of returns) {
    if (
      !days.has(row.dt) ||
      !row.symbol ||
      (row.value !== null && (!Number.isFinite(row.value) || row.value < -1))
    )
      throw new Error("收益无效");
    const daily = prices.get(row.dt) ?? new Map<string, number | null>();
    if (daily.has(row.symbol)) throw new Error("重复收益");
    daily.set(row.symbol, row.value);
    prices.set(row.dt, daily);
  }
  let previous = new Map<string, number | null>();
  return calendar.map((dt) => {
    const current = snapshots.get(dt) ?? new Map<string, number | null>();
    let grossReturn: number | null = 0,
      turnover: number | null = 0;
    for (const symbol of new Set([...previous.keys(), ...current.keys()])) {
      const before = previous.has(symbol) ? previous.get(symbol)! : 0;
      const after = current.has(symbol) ? current.get(symbol)! : 0;
      const value = prices.get(dt)?.get(symbol);
      if (before === null || (before !== 0 && value == null))
        grossReturn = null;
      else if (grossReturn !== null) grossReturn += before * (value ?? 0);
      if (before === null || after === null) turnover = null;
      else if (turnover !== null) turnover += Math.abs(after - before);
    }
    const cost =
      costs.commissionBps === 0
        ? 0
        : turnover === null
          ? null
          : (turnover * costs.commissionBps) / 10000;
    previous = current;
    return {
      dt,
      grossReturn,
      turnover,
      cost,
      netReturn:
        grossReturn === null || cost === null ? null : grossReturn - cost,
    };
  });
}

/** E3 trades do not retain historical marks: bars are required, lastPrice is
 * only the final mark and must never be backfilled into historical weights.
 */
export function projectResearchWeights(
  simulation: Pick<ReturnType<typeof researchPortfolio>, "trades" | "nav">,
  series: ReadonlyMap<string, readonly Bar[]>,
) {
  const symbols = [
    ...new Set(simulation.trades.map((trade) => trade.event.symbol)),
  ];
  const marks = new Map(
    [...series].map(([symbol, bars]) => {
      const indexed = new Map<string, number | null>();
      for (const bar of bars)
        indexed.set(bar.date, indexed.has(bar.date) ? null : bar.close);
      return [symbol, indexed] as const;
    }),
  );
  const rows: WeightRow[] = [];
  const unavailable: { dt: string; symbol: string; reason: string }[] = [];
  for (const point of simulation.nav) {
    for (const symbol of symbols) {
      const held = simulation.trades.filter(
        (trade) =>
          trade.event.symbol === symbol &&
          trade.entryDate <= point.date &&
          (!trade.exitDate || trade.exitDate > point.date),
      );
      const quantity = held.reduce((sum, trade) => sum + trade.quantity, 0);
      const close = marks.get(symbol)?.get(point.date);
      const valid =
        Number.isFinite(point.value) &&
        point.value > 0 &&
        !point.stale.length &&
        (quantity === 0 ||
          (close != null && Number.isFinite(close) && close > 0));
      if (!valid)
        unavailable.push({
          dt: point.date,
          symbol,
          reason: "净值或当日持仓价格不可得",
        });
      rows.push({
        dt: point.date,
        symbol,
        weight: valid
          ? quantity === 0
            ? 0
            : (quantity * close!) / point.value
          : null,
      });
    }
  }
  return { rows, unavailable };
}

export function closeReturns(
  calendar: readonly string[],
  series: ReadonlyMap<string, readonly Bar[]>,
) {
  return [...series].flatMap(([symbol, bars]) => {
    const indexed = new Map<string, number | null>();
    for (const bar of bars)
      indexed.set(bar.date, indexed.has(bar.date) ? null : bar.close);
    return calendar.map((dt, i): ReturnRow => {
      const before = i ? indexed.get(calendar[i - 1]!) : null;
      const after = indexed.get(dt);
      return {
        dt,
        symbol,
        value:
          before != null &&
          after != null &&
          Number.isFinite(before) &&
          Number.isFinite(after) &&
          before > 0 &&
          after > 0
            ? after / before - 1
            : null,
      };
    });
  });
}
