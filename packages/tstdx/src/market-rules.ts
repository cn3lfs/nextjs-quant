/** Pure market identity, date validation and board limits; safe in browsers. */
export const MARKET = { sz: 0, sh: 1, bj: 2 } as const;
export function splitSymbol(symbol: string) {
  if (typeof symbol !== "string" || !/^(sh|sz|bj)\d{6}$/.test(symbol))
    throw new Error("证券代码须为 sh/sz/bj 加六位数字");
  const market = MARKET[symbol.slice(0, 2) as keyof typeof MARKET];
  return { market, code: symbol.slice(2) };
}
export function uint(value: number, name: string, max = 65535, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error(`${name} 必须在 ${min}..${max} 范围内`);
  return value;
}
export function dateNumber(date: number): string {
  uint(date, "date", 21001231, 19900101);
  const s = String(date),
    iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== iso
  )
    throw new Error("非法交易日期");
  return iso;
}
export function isIndexSymbol(symbol: string) {
  const { market, code } = splitSymbol(symbol);
  return market === 1
    ? /^(000|880|881|882|883|884|885|999)/.test(code)
    : market === 0 && /^(395|399)/.test(code);
}
export function isAStock(symbol: string) {
  const { market, code } = splitSymbol(symbol);
  return market === 1
    ? /^(60|68)/.test(code)
    : market === 0
      ? /^(00|30)/.test(code)
      : /^(43|83|87|92)/.test(code);
}
export type PriceLimitInput = {
  listedDays?: number;
  ruleDate?: number;
  name?: string;
  tickSize?: number;
};
export function computePriceLimits(
  symbol: string,
  preClose: number,
  options: PriceLimitInput = {},
) {
  const { market, code } = splitSymbol(symbol),
    date =
      options.ruleDate ??
      Number(
        new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Shanghai",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
          .format(new Date())
          .replaceAll("-", ""),
      );
  dateNumber(date);
  const empty = (reason: string) => ({
    up: null,
    down: null,
    percent: null,
    reason,
    ruleDate: date,
  });
  if (date < 20230410) return empty("unsupported-historical-rule");
  if (!Number.isFinite(preClose) || preClose <= 0)
    return empty("invalid-price");
  if (!isAStock(symbol) || isIndexSymbol(symbol)) return empty("not-a-share");
  if (
    options.listedDays !== undefined &&
    (!Number.isInteger(options.listedDays) || options.listedDays < 1)
  )
    throw new Error("listedDays 必须为正整数");
  const window = market === 2 ? 1 : 5;
  if (options.listedDays !== undefined && options.listedDays <= window)
    return empty("initial-listing-window");
  const boardPercent = market === 2 ? 30 : /^(68|30)/.test(code) ? 20 : 10;
  const percent =
    boardPercent === 10 && /ST/i.test(options.name ?? "") && date < 20260706
      ? 5
      : boardPercent;
  const tick = options.tickSize ?? 0.01;
  if (!Number.isFinite(tick) || tick <= 0)
    throw new Error("tickSize 必须为正数");
  const round = (v: number) =>
    Number(
      (Math.round((v + Number.EPSILON * v) / tick) * tick).toPrecision(12),
    );
  return {
    up: round(preClose * (1 + percent / 100)),
    down: round(preClose * (1 - percent / 100)),
    percent,
    reason: "board-rule",
    ruleDate: date,
  };
}
