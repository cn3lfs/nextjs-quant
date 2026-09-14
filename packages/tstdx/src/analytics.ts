import { dateNumber, FLOW_FIELDS, type FlowAmounts } from "./catalog-wire.js";
import {
  splitSymbol,
  type TdxBar,
  type TdxQuote,
  type TdxTransaction,
  type TdxXdxr,
} from "./wire.js";

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
export function marketStatistics(quote: TdxQuote) {
  if (quote.symbol !== "sh880005") throw new Error("市场统计证券身份不符");
  const values = [quote.price, quote.preClose, quote.low, quote.high];
  if (values.some((n) => !Number.isSafeInteger(n) || n < 0))
    throw new Error("市场统计家数非法");
  const [up, down, neutral, total] = values as [number, number, number, number];
  if (up + down + neutral > total) throw new Error("市场统计家数不守恒");
  return {
    up,
    down,
    neutral,
    total,
    unclassified: total - up - down - neutral,
    unclassifiedMeaning: "residual-not-confirmed-suspended" as const,
    amount: quote.amount,
    volume: quote.volume,
    quoteTime: quote.quoteTime,
  };
}
export type TdxFundFlow = FlowAmounts & {
  mainNetInflow: number;
  totalNetInflow: number;
  neutralAmount: number;
  unknownAmount: number;
  volume: number;
  records: number;
  lotSize: number;
  source: "transactions";
};
export function classifyFundFlow(
  records: readonly TdxTransaction[],
  lotSize = 100,
): TdxFundFlow {
  if (!Number.isFinite(lotSize) || lotSize <= 0)
    throw new Error("lotSize 必须为正数");
  const row = Object.fromEntries(FLOW_FIELDS.map((f) => [f, 0])) as FlowAmounts;
  let neutralAmount = 0,
    unknownAmount = 0,
    volume = 0;
  for (const item of records) {
    if (
      !Number.isFinite(item.price) ||
      item.price <= 0 ||
      !Number.isFinite(item.volume) ||
      item.volume < 0
    )
      throw new Error("成交价格/量非法");
    const amount = item.price * item.volume * lotSize;
    volume += item.volume;
    if (!Number.isFinite(amount) || !Number.isFinite(volume))
      throw new Error("资金流数值溢出");
    if (item.direction === 2) {
      neutralAmount += amount;
      continue;
    }
    if (item.direction !== 0 && item.direction !== 1) {
      unknownAmount += amount;
      continue;
    }
    const size =
      amount > 1e6
        ? "super"
        : amount > 2e5
          ? "large"
          : amount > 4e4
            ? "medium"
            : "small";
    row[`${size}${item.direction === 0 ? "In" : "Out"}`] += amount;
  }
  return {
    ...row,
    mainNetInflow: row.superIn + row.largeIn - row.superOut - row.largeOut,
    totalNetInflow:
      row.superIn +
      row.largeIn +
      row.mediumIn +
      row.smallIn -
      row.superOut -
      row.largeOut -
      row.mediumOut -
      row.smallOut,
    neutralAmount,
    unknownAmount,
    volume,
    records: records.length,
    lotSize,
    source: "transactions",
  };
}
export function assertVolumeCoverage(
  records: readonly TdxTransaction[],
  expected: number,
) {
  if (!Number.isFinite(expected) || expected < 0)
    throw new Error("成交量参照非法");
  const actual = records.reduce((n, r) => n + r.volume, 0);
  if (!Number.isFinite(actual) || actual + 1e-6 < expected)
    throw new Error(`成交覆盖不完整：${actual}/${expected}`);
}
export type TdxAdjustedBar = TdxBar & {
  adjustment: "qfq" | "hfq";
  adjustmentFactor: number;
};
export function adjustBars(
  bars: readonly TdxBar[],
  events: readonly TdxXdxr[],
  mode: "qfq" | "hfq",
): TdxAdjustedBar[] {
  if (mode !== "qfq" && mode !== "hfq") throw new Error("未知复权模式");
  const sorted = [...bars].sort((a, b) => a.date.localeCompare(b.date));
  if (!sorted.length) return [];
  if (
    sorted.some(
      (b, i) =>
        !Number.isFinite(b.close) ||
        b.close <= 0 ||
        b.date === sorted[i - 1]?.date,
    )
  )
    throw new Error("复权 K 线非法或重复");
  const actions = events
    .filter((e) => e.category === 1)
    .sort((a, b) => a.date.localeCompare(b.date));
  const scales: number[] = [];
  let scale = 1,
    at = 0;
  for (let i = 0; i < sorted.length; i++) {
    const bar = sorted[i]!,
      previous = sorted[i - 1];
    let referenceClose = previous?.close;
    while (at < actions.length && actions[at]!.date <= bar.date.slice(0, 10)) {
      const first = actions[at]!,
        day = first.date;
      let dividend = 0,
        bonus = 0,
        rights = 0,
        rightsCost = 0;
      while (at < actions.length && actions[at]!.date === day) {
        const e = actions[at++]!;
        const fields = [e.dividend, e.bonusRatio, e.rightsRatio, e.rightsPrice];
        if (fields.some((v) => v === undefined || !Number.isFinite(v) || v < 0))
          throw new Error("除权事件字段缺失或非法");
        dividend += e.dividend!;
        bonus += e.bonusRatio!;
        rights += e.rightsRatio!;
        rightsCost += e.rightsRatio! * e.rightsPrice!;
      }
      if (!previous) continue;
      const reference =
        (referenceClose! - dividend + rightsCost) / (1 + bonus + rights);
      if (!(reference > 0) || !Number.isFinite(reference))
        throw new Error("除权参考价非法");
      scale *= reference / referenceClose!;
      referenceClose = reference;
    }
    if (!(scale > 0) || !Number.isFinite(scale))
      throw new Error("复权因子非法");
    scales.push(scale);
  }
  return sorted.map((bar, i) => {
    const factor =
      mode === "qfq" ? scales.at(-1)! / scales[i]! : 1 / scales[i]!;
    const values = [bar.open, bar.high, bar.low, bar.close].map(
      (p) => p * factor,
    );
    if (values.some((p) => !Number.isFinite(p) || p <= 0))
      throw new Error("复权价格非法");
    return {
      ...bar,
      open: values[0]!,
      high: values[1]!,
      low: values[2]!,
      close: values[3]!,
      adjustment: mode,
      adjustmentFactor: factor,
    };
  });
}
