import type { ReviewValue } from "../portfolio/trade-review";

/**
 * 五档快照的结构最小集，字段来自 tstdx `securityQuotes`。
 * 量与额的单位未经核验（见 packages/tstdx/README.md），展示层必须按源单位披露，
 * 不能换算成手或股，也不能用额除以量当作均价。
 */
export type QuoteLevel = { price: number; volume: number };
export type QuoteSnapshot = {
  symbol: string;
  quoteTime: string | null;
  price: number;
  preClose: number;
  open: number;
  high: number;
  low: number;
  volume: number;
  amount: number;
  innerVolume: number;
  outerVolume: number;
  riseSpeed: number;
  bids: readonly QuoteLevel[];
  asks: readonly QuoteLevel[];
};

const positive = (n: number) => Number.isFinite(n) && n > 0;
const measure = (n: number | null, reason: string): ReviewValue =>
  n !== null && Number.isFinite(n)
    ? { value: n, reason: null }
    : { value: null, reason };

export function quotePriceStats(quote: QuoteSnapshot) {
  const base = positive(quote.preClose) ? quote.preClose : null;
  const last = positive(quote.price) ? quote.price : null;
  const range =
    positive(quote.high) && positive(quote.low) && quote.high >= quote.low
      ? quote.high - quote.low
      : null;
  const move = base !== null && last !== null ? last - base : null;
  return {
    change: measure(move, "昨收价或最新价不可得"),
    changePercent: measure(
      move !== null && base !== null ? move / base : null,
      "昨收价或最新价不可得",
    ),
    amplitude: measure(
      range !== null && base !== null ? range / base : null,
      "昨收价或最高最低价不可得",
    ),
  };
}

export type OrderBookRow = {
  side: "ask" | "bid";
  level: number;
  price: number | null;
  volume: number | null;
  /** 相对本快照五档最大挂单量的占比，仅用于深度条宽度。 */
  depth: number;
};

const usable = (level: QuoteLevel) =>
  positive(level.price) && Number.isFinite(level.volume) && level.volume > 0;

/**
 * 卖五→卖一、买一→买五的展示顺序。协议会用 0 价 0 量补满缺档，
 * 这些档位保留位置但价量留空，不能当成真实挂单。
 */
export function orderBook(quote: QuoteSnapshot): OrderBookRow[] {
  const asks = quote.asks.slice(0, 5),
    bids = quote.bids.slice(0, 5);
  const peak = [...asks, ...bids].reduce(
    (most, level) => (usable(level) ? Math.max(most, level.volume) : most),
    0,
  );
  const row = (
    side: OrderBookRow["side"],
    level: number,
    quoted: QuoteLevel,
  ): OrderBookRow => ({
    side,
    level,
    price: usable(quoted) ? quoted.price : null,
    volume: usable(quoted) ? quoted.volume : null,
    depth: usable(quoted) && peak > 0 ? quoted.volume / peak : 0,
  });
  return [
    ...asks.map((level, i) => row("ask", i + 1, level)).reverse(),
    ...bids.map((level, i) => row("bid", i + 1, level)),
  ];
}

const sideVolume = (levels: readonly QuoteLevel[]) =>
  levels
    .slice(0, 5)
    .reduce((total, level) => total + (usable(level) ? level.volume : 0), 0);

/** 委比与委差只比较同一快照的挂单量，与量的单位无关。 */
export function orderImbalance(quote: QuoteSnapshot) {
  const bidVolume = sideVolume(quote.bids),
    askVolume = sideVolume(quote.asks);
  const total = bidVolume + askVolume;
  return {
    bidVolume,
    askVolume,
    difference: measure(total > 0 ? bidVolume - askVolume : null, "五档无挂单"),
    ratio: measure(
      total > 0 ? (bidVolume - askVolume) / total : null,
      "五档无挂单",
    ),
  };
}

/** 外盘占内外盘合计的比例；两者同源同单位，比值可用。 */
export function activeBuyRatio(quote: QuoteSnapshot): ReviewValue {
  const inner = Number.isFinite(quote.innerVolume) ? quote.innerVolume : null;
  const outer = Number.isFinite(quote.outerVolume) ? quote.outerVolume : null;
  const total = inner !== null && outer !== null ? inner + outer : null;
  return measure(
    total !== null && total > 0 && outer !== null ? outer / total : null,
    "内外盘量不可得",
  );
}

export const quoteSessions = [
  "pre",
  "auction",
  "continuous",
  "break",
  "post",
  "weekend",
] as const;
export type QuoteSession = (typeof quoteSessions)[number];
export const quoteSessionLabels: Record<QuoteSession, string> = {
  pre: "盘前",
  auction: "集合竞价",
  continuous: "连续竞价",
  break: "午间休市",
  post: "已收盘",
  weekend: "非交易日（周末）",
};

/**
 * 只按北京时间的星期与时段判断，用途仅限决定自动刷新频率。
 * 这里没有交易日历，法定休市日仍会判成交易时段；任何数据口径都不得依赖它。
 */
export function quoteSession(now: number): QuoteSession {
  if (!Number.isFinite(now)) throw new Error("快照时间无效");
  const beijing = new Date(now + 8 * 3600000);
  const weekday = beijing.getUTCDay();
  if (weekday === 0 || weekday === 6) return "weekend";
  const minute = beijing.getUTCHours() * 60 + beijing.getUTCMinutes();
  if (minute < 9 * 60 + 15) return "pre";
  if (minute < 9 * 60 + 30) return "auction";
  if (minute < 11 * 60 + 30) return "continuous";
  if (minute < 13 * 60) return "break";
  if (minute < 14 * 60 + 57) return "continuous";
  if (minute < 15 * 60) return "auction";
  return "post";
}

/** 自动刷新间隔；收盘与周末返回 null，表示只允许手动刷新。 */
export function quoteRefreshInterval(session: QuoteSession): number | null {
  if (session === "continuous" || session === "auction") return 3000;
  if (session === "break" || session === "pre") return 30000;
  return null;
}
