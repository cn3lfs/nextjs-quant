export const rpsPeriods = [1, 3, 5, 10, 20, 50, 120] as const;
export const isRpsMarketSymbol = (symbol: string) =>
  /^(sh(60|68)\d{4}|sz(00|30)\d{4})$/.test(symbol);
export const rpsPolicy = {
  version: "rps-1",
  adjustment: "backward",
  minimumListingYears: 1,
  suspensionSessions: 20,
  retentionDays: 750,
  maxSymbols: 10000,
  tie: "average-one-based",
  description:
    "后复权；仅沪深A股；首条本地日线满一年（保守上市年龄代理）；排除ST/*ST及名称未知；连续20个参考交易日无成交视为长期停牌；收益两端必须有成交，不补价；并列取1起始平均名次，RPS=(1-名次/有效总数)×100。",
  backfillWarning:
    "回填使用当前存活证券及当前名称，存在生存者偏差和历史ST状态偏差；不能视为当时可得证券池。",
} as const;

export type RpsValue = { return: number; rank: number; rps: number };
export type RpsRow = { symbol: string; values: (RpsValue | null)[] };
export const rpsExclusions = [
  "market",
  "nameUnknown",
  "st",
  "young",
  "suspended",
  "unsupportedAction",
  "missingEndpoint",
] as const;
export type RpsExclusion = (typeof rpsExclusions)[number];
export const rpsExclusionLabels: Record<RpsExclusion, string> = {
  market: "非沪深A股（含北交所）",
  nameUnknown: "名称未知",
  st: "ST/*ST",
  young: "本地历史未满一年",
  suspended: "连续20日无成交",
  unsupportedAction: "不支持的扩缩股/无效除权",
  missingEndpoint: "全部周期收益端点不足",
};

export type RpsSecurity = {
  symbol: string;
  name: string;
  firstDate: string;
  closes: Map<string, { close: number; volume: number }>;
  unsupportedDates: string[];
};

/** docs/screening-rps/2026-09-10-rps-plan.md: ranks start at 1; ties share their occupied ranks' mean. */
export function rankRps(values: { symbol: string; return: number }[]) {
  const sorted = [...values].sort(
    (a, b) => b.return - a.return || a.symbol.localeCompare(b.symbol),
  );
  if (
    sorted.some((v) => !Number.isFinite(v.return)) ||
    new Set(sorted.map((v) => v.symbol)).size !== sorted.length
  )
    throw new Error("RPS收益无效或证券重复");
  const result = new Map<string, RpsValue>();
  for (let start = 0; start < sorted.length;) {
    let end = start + 1;
    while (end < sorted.length && sorted[end]!.return === sorted[start]!.return)
      end++;
    const rank = (start + 1 + end) / 2;
    for (let i = start; i < end; i++)
      result.set(sorted[i]!.symbol, {
        return: sorted[i]!.return,
        rank,
        rps: (1 - rank / sorted.length) * 100,
      });
    start = end;
  }
  return result;
}

export function rpsPoolExclusion(
  stock: RpsSecurity,
  calendar: string[],
  index: number,
  longest: number,
): RpsExclusion | null {
  const date = calendar[index]!;
  if (!isRpsMarketSymbol(stock.symbol)) return "market";
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

export function calculateRps(
  stocks: RpsSecurity[],
  calendar: string[],
  date: string,
  periods: readonly number[] = rpsPeriods,
) {
  return calculateRpsAtIndex(stocks, calendar, calendar.indexOf(date), periods);
}

/** Use a known calendar position, optionally checking its expected trading date. */
export function calculateRpsAtIndex(
  stocks: RpsSecurity[],
  calendar: string[],
  index: number,
  periods: readonly number[] = rpsPeriods,
  expectedDate?: string,
) {
  if (
    !periods.length ||
    periods.length > rpsPeriods.length ||
    new Set(periods).size !== periods.length ||
    periods.some((p) => !(rpsPeriods as readonly number[]).includes(p))
  )
    throw new Error("RPS周期无效");
  if (new Set(stocks.map((s) => s.symbol)).size !== stocks.length)
    throw new Error("RPS证券重复");
  const longest = Math.max(...periods);
  if (!Number.isInteger(index) || index < longest || index >= calendar.length)
    throw new Error("RPS参考日历不足，不能缩短收益窗口");
  const date = calendar[index];
  if (
    date === undefined ||
    (expectedDate !== undefined && date !== expectedDate)
  )
    throw new Error("RPS参考日历索引与日期不匹配");
  // calculateRps(date) resolves the first occurrence; keep the indexed entry
  // equivalent instead of silently computing at a later duplicate.
  if (index > 0 && calendar[index - 1] === date)
    throw new Error("RPS参考日历索引必须是该交易日的首次出现位置");
  const excluded = Object.fromEntries(
    rpsExclusions.map((key) => [key, [] as string[]]),
  ) as Record<RpsExclusion, string[]>;
  const inputs = periods.map(() => [] as { symbol: string; return: number }[]);
  const missing = periods.map(() => 0);
  let pool = 0;
  const symbols: string[] = [];
  for (const stock of stocks) {
    const reason = rpsPoolExclusion(stock, calendar, index, longest);
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
    inputs,
  };
}
