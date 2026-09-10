import { createHash } from "node:crypto";
import type { Bar } from "~/lib/domain";
import {
  rankRps,
  rpsExclusions,
  rpsPeriods,
  rpsPolicy,
  type RpsDay,
  type RpsExclusion,
  type RpsRow,
} from "~/lib/rps";
import { adjustmentFactors } from "./tdx-gbbq";
import type { TdxXdxr } from "./tdx-wire";

export const rpsHash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type RpsSecurity = {
  symbol: string;
  name: string;
  firstDate: string;
  closes: Map<string, { close: number; volume: number }>;
  unsupportedDates: string[];
};

/** Reuse the causal GBBQ factors; unsupported categories must not silently become raw prices. */
export function prepareRpsSecurity(
  symbol: string,
  name: string,
  bars: Bar[],
  events: TdxXdxr[],
  keepFrom: string,
): RpsSecurity {
  const factors = adjustmentFactors(bars, events);
  const unsupportedDates = events
    .filter(
      (e) =>
        e.category === 11 ||
        e.category === 12 ||
        (e.category === 1 &&
          [e.dividend, e.rightsPrice, e.bonusRatio, e.rightsRatio].some(
            (v) => v !== undefined && (!Number.isFinite(v) || v < 0),
          )),
    )
    .map((e) => e.date);
  // The shared factor helper skips non-positive theoretical ex-prices; flag these instead.
  for (let i = 1; i < bars.length; i++) {
    const previous = bars[i - 1]!;
    let base = previous.close;
    for (const event of events.filter(
      (e) =>
        e.category === 1 && e.date > previous.date && e.date <= bars[i]!.date,
    )) {
      base =
        (base -
          (event.dividend ?? 0) +
          (event.rightsRatio ?? 0) * (event.rightsPrice ?? 0)) /
        (1 + (event.rightsRatio ?? 0) + (event.bonusRatio ?? 0));
      if (!(base > 0) || !Number.isFinite(base))
        unsupportedDates.push(event.date);
    }
  }
  return {
    symbol,
    name,
    firstDate: bars[0]?.date ?? "9999-12-31",
    unsupportedDates,
    closes: new Map(
      bars.flatMap((bar, i) =>
        bar.date < keepFrom
          ? []
          : [
              [
                bar.date,
                { close: bar.close * factors[i]!.factor, volume: bar.volume },
              ] as const,
            ],
      ),
    ),
  };
}

export function rpsPoolExclusion(
  stock: RpsSecurity,
  calendar: string[],
  index: number,
  longest: number,
): RpsExclusion | null {
  const date = calendar[index]!;
  if (!/^(sh(60|68)\d{4}|sz(00|30)\d{4})$/.test(stock.symbol)) return "market";
  if (!stock.name || stock.name === stock.symbol) return "nameUnknown";
  if (/^(?:S)?\*?ST/i.test(stock.name.trim())) return "st";
  // First available bar is a conservative age bound, not a claimed official listing date.
  const anniversary = `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
  if (stock.firstDate > anniversary) return "young";
  if (
    !calendar
      .slice(Math.max(0, index - rpsPolicy.suspensionSessions + 1), index + 1)
      .some((d) => (stock.closes.get(d)?.volume ?? 0) > 0)
  )
    return "suspended";
  if (
    stock.unsupportedDates.some(
      (d) => d > (calendar[index - longest] ?? "0000-01-01") && d <= date,
    )
  )
    return "unsupportedAction";
  return null;
}

export function calculateRpsDay(
  stocks: RpsSecurity[],
  calendar: string[],
  date: string,
  periods: readonly number[] = rpsPeriods,
) {
  if (
    !periods.length ||
    periods.length > 6 ||
    new Set(periods).size !== periods.length ||
    periods.some((p) => !Number.isInteger(p) || p < 1 || p > 250)
  )
    throw new Error("RPS周期无效");
  if (new Set(stocks.map((s) => s.symbol)).size !== stocks.length)
    throw new Error("RPS证券重复");
  const index = calendar.indexOf(date);
  if (index < Math.max(...periods))
    throw new Error("RPS参考日历不足，不能缩短收益窗口");
  const excluded = Object.fromEntries(
    rpsExclusions.map((key) => [key, [] as string[]]),
  ) as RpsDay["excluded"];
  const inputs = periods.map(() => [] as { symbol: string; return: number }[]);
  const missing = periods.map(() => 0);
  let pool = 0;
  const symbols: string[] = [];
  for (const stock of stocks) {
    const reason = rpsPoolExclusion(
      stock,
      calendar,
      index,
      Math.max(...periods),
    );
    if (reason) {
      excluded[reason].push(stock.symbol);
      continue;
    }
    pool++;
    symbols.push(stock.symbol);
    let valid = 0;
    periods.forEach((period, p) => {
      const current = stock.closes.get(date),
        previous = stock.closes.get(calendar[index - period]!);
      const value =
        current &&
        previous &&
        current.volume > 0 &&
        previous.volume > 0 &&
        current.close > 0 &&
        previous.close > 0
          ? current.close / previous.close - 1
          : NaN;
      if (Number.isFinite(value)) {
        inputs[p]!.push({ symbol: stock.symbol, return: value });
        valid++;
      } else missing[p] = missing[p]! + 1;
    });
    if (!valid) excluded.missingEndpoint.push(stock.symbol);
  }
  const rankings = inputs.map(rankRps);
  symbols.sort();
  const rows: RpsRow[] = symbols.map((symbol) => ({
    symbol,
    values: rankings.map((r) => r.get(symbol) ?? null),
  }));
  return {
    rows,
    pool,
    counts: inputs.map((v) => v.length),
    excluded,
    missing,
    inputHash: rpsHash(inputs),
  };
}
