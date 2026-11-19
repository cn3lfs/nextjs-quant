import type { ThsdkOrderBookItem } from "./thsdk-reference";
import {
  activeBuyRatio,
  orderBook,
  orderImbalance,
  quotePriceStats,
  quoteSessionLabels,
  type QuoteSession,
  type QuoteSnapshot,
} from "./tdx-quote-view";

/**
 * 来源无关的可空盘口展示模型。
 *
 * 三态含义固定：`quoted` 源给出了可用档位，`empty` 源明确返回空盘口，
 * `unknown` 源未返回或无法判断。缺失一律用 null 表达，不能伪装成 0。
 */
export type QuoteBookState = "quoted" | "empty" | "unknown";
export type QuoteBookMetric = { value: number | null; reason: string | null };
export type QuoteBookLevel = {
  level: number;
  price: number | null;
  volume: number | null;
  state: QuoteBookState;
  /** 相对本快照五档最大挂单量的占比，仅用于深度条宽度。 */
  depth: number;
};

export type QuoteBookDisplayModel = {
  symbol: string;
  state: QuoteBookState;
  precision: number;
  lastPrice: number | null;
  change: QuoteBookMetric;
  changePercent: QuoteBookMetric;
  amplitude: QuoteBookMetric;
  activeBuyRatio: QuoteBookMetric;
  open: number | null;
  preClose: number | null;
  high: number | null;
  low: number | null;
  riseSpeed: number | null;
  volume: number | null;
  amount: number | null;
  innerVolume: number | null;
  outerVolume: number | null;
  /** 卖五→卖一。 */
  asks: QuoteBookLevel[];
  /** 买一→买五。 */
  bids: QuoteBookLevel[];
  imbalance: { difference: QuoteBookMetric; ratio: QuoteBookMetric };
  quoteTime: string | null;
  sessionLabel: string;
  quoteTimeNote: string;
  /** 无档位可渲染时的说明，含来源给出的原因。 */
  bookNotice: string;
  volumeUnit: string | null;
  sourceLabel: string;
  sourceNote: string;
  sourceNoteTitle: string;
  delayed: "unverified" | "delayed" | "verified" | null;
};

const positive = (value: number) => Number.isFinite(value) && value > 0;
const finiteOrNull = (value: number) => (Number.isFinite(value) ? value : null);
const metric = (value: number | null, reason: string): QuoteBookMetric => ({
  value: value !== null && Number.isFinite(value) ? value : null,
  reason: value !== null && Number.isFinite(value) ? null : reason,
});

/** 按每一侧的挂单量合计比较；单位无关，但不能把未知当成 0。 */
function levelSide(
  levels: readonly {
    level: number;
    price: number | null;
    volume: number | null;
  }[],
) {
  const quoted = levels.filter(
    (level) =>
      level.price !== null &&
      positive(level.price) &&
      level.volume !== null &&
      positive(level.volume),
  );
  return {
    quoted,
    volume: quoted.length
      ? quoted.reduce((total, level) => total + (level.volume ?? 0), 0)
      : null,
  };
}

const tdxBookNotice =
  "该品种没有可交易的五档盘口（指数按协议返回空档），仅展示价格与统计。";

export function tdxQuoteToDisplayModel(
  quote: QuoteSnapshot,
  precision: number,
  options: { hasOrderBook: boolean; session: QuoteSession },
): QuoteBookDisplayModel {
  const stats = quotePriceStats(quote);
  const imbalance = orderImbalance(quote);
  const rows = orderBook(quote);
  const rowState = (price: number | null, volume: number | null) =>
    price !== null && volume !== null ? "quoted" : "empty";
  const toLevel = (row: (typeof rows)[number]): QuoteBookLevel => ({
    level: row.level,
    price: row.price,
    volume: row.volume,
    state: rowState(row.price, row.volume),
    depth: row.depth,
  });
  return {
    symbol: quote.symbol,
    state: options.hasOrderBook ? "quoted" : "empty",
    precision,
    lastPrice: finiteOrNull(quote.price),
    change: stats.change,
    changePercent: stats.changePercent,
    amplitude: stats.amplitude,
    activeBuyRatio: activeBuyRatio(quote),
    open: finiteOrNull(quote.open),
    preClose: finiteOrNull(quote.preClose),
    high: finiteOrNull(quote.high),
    low: finiteOrNull(quote.low),
    riseSpeed: finiteOrNull(quote.riseSpeed),
    volume: finiteOrNull(quote.volume),
    amount: finiteOrNull(quote.amount),
    innerVolume: finiteOrNull(quote.innerVolume),
    outerVolume: finiteOrNull(quote.outerVolume),
    asks: rows.filter((row) => row.side === "ask").map(toLevel),
    bids: rows.filter((row) => row.side === "bid").map(toLevel),
    imbalance: {
      difference: imbalance.difference,
      ratio: imbalance.ratio,
    },
    quoteTime: quote.quoteTime,
    sessionLabel: quoteSessionLabels[options.session],
    quoteTimeNote: "编码未知，不能据此判断新鲜度",
    bookNotice: tdxBookNotice,
    volumeUnit: null,
    sourceLabel: "tstdx 7709",
    sourceNote:
      "7709 即时快照，只供盘中观察，不代表成交可得性；量、额按源单位原样展示。",
    sourceNoteTitle:
      "通达信 7709 公共服务器即时快照，只供盘中观察：快照不含日期，不能证明属于今天，也不代表成交可得性；量与额的单位未经核验，按源单位原样展示，不换算手/股、不据此推算均价。请勿与本地历史行情混用生成回测信号。",
    delayed: "unverified",
  };
}

const thsdkStatsReason = "同花顺盘口接口不含价格统计";
const thsdkChangeReason = "同花顺盘口不提供昨收与最新价";
const thsdkQuoteTimeNote = "源未提供数据时点";
const thsdkBookNotice =
  "同花顺返回空盘口：该品种没有可交易档位，或当前时段无挂单。";
const thsdkUnknownFallback = "同花顺未返回可用盘口";

function thsdkLevels(
  levels: ThsdkOrderBookItem["bids"],
  side: "bid" | "ask",
): QuoteBookLevel[] {
  const ordered = [...levels].sort((a, b) => a.level - b.level);
  if (side === "ask") ordered.reverse();
  return ordered.slice(0, 5).map((level) => {
    const quoted =
      level.state === "quoted" &&
      level.price !== null &&
      positive(level.price) &&
      level.volume !== null &&
      positive(level.volume);
    return {
      level: level.level,
      price: quoted ? level.price : null,
      volume: quoted ? level.volume : null,
      state: quoted
        ? "quoted"
        : level.state === "quoted"
          ? "empty"
          : level.state,
      depth: 0,
    };
  });
}

/**
 * 同花顺盘口只有档位，没有最新价、昨收、内外盘等价格统计；
 * 这些字段保持 null 并写明原因，视图会隐藏整块统计而不是显示一排 0。
 */
export function thsdkOrderBookToDisplayModel(
  item: ThsdkOrderBookItem,
  precision: number,
): QuoteBookDisplayModel {
  const known = item.status === "ok" || item.status === "empty";
  const bids = thsdkLevels(item.bids, "bid");
  const asks = thsdkLevels(item.asks, "ask");
  const peak = [...bids, ...asks].reduce(
    (most, level) =>
      level.state === "quoted" && level.volume !== null
        ? Math.max(most, level.volume)
        : most,
    0,
  );
  const withDepth = (levels: QuoteBookLevel[]) =>
    levels.map((level) => ({
      ...level,
      depth:
        level.state === "quoted" && level.volume !== null && peak > 0
          ? level.volume / peak
          : 0,
    }));
  const displayBids = withDepth(bids);
  const displayAsks = withDepth(asks);
  const bidSide = levelSide(displayBids);
  const askSide = levelSide(displayAsks);
  const total =
    bidSide.volume !== null && askSide.volume !== null
      ? bidSide.volume + askSide.volume
      : null;
  const hasQuoted = bidSide.quoted.length > 0 || askSide.quoted.length > 0;
  const state: QuoteBookState = !known
    ? "unknown"
    : hasQuoted
      ? "quoted"
      : "empty";
  const anyUnknown = [...displayBids, ...displayAsks].some(
    (level) => level.state === "unknown",
  );
  const imbalanceReason =
    state === "unknown"
      ? "盘口不可得"
      : bidSide.volume === null || askSide.volume === null
        ? anyUnknown
          ? "两侧挂单未知"
          : "五档无挂单"
        : "五档无挂单";
  const difference =
    total !== null && total > 0 && bidSide.volume !== null
      ? bidSide.volume - (askSide.volume ?? 0)
      : null;
  const ratio =
    difference !== null && total !== null && total > 0
      ? difference / total
      : null;
  const notice =
    state === "unknown"
      ? `盘口不可得：${item.message?.trim() || thsdkUnknownFallback}`
      : state === "empty"
        ? thsdkBookNotice
        : "";
  return {
    symbol: item.symbol,
    state,
    precision,
    lastPrice: null,
    change: metric(null, thsdkChangeReason),
    changePercent: metric(null, thsdkChangeReason),
    amplitude: metric(null, thsdkStatsReason),
    activeBuyRatio: metric(null, "同花顺盘口不提供内外盘"),
    open: null,
    preClose: null,
    high: null,
    low: null,
    riseSpeed: null,
    volume: null,
    amount: null,
    innerVolume: null,
    outerVolume: null,
    asks: displayAsks,
    bids: displayBids,
    imbalance: {
      difference: metric(difference, imbalanceReason),
      ratio: metric(ratio, imbalanceReason),
    },
    quoteTime: item.dataAsOf,
    sessionLabel: "同花顺即时盘口",
    quoteTimeNote: thsdkQuoteTimeNote,
    bookNotice: notice,
    volumeUnit: item.volumeUnit,
    sourceLabel: "同花顺（THSDK）",
    sourceNote:
      "同花顺（THSDK）即时盘口，延迟与时点以源标注为准，不代表成交可得性；量按源单位原样展示。",
    sourceNoteTitle:
      "同花顺（THSDK）经 hq.dll 读取的即时五档盘口：延迟状态、数据时点与挂单量单位由源标注，未独立核验；不代表成交可得性，请勿与本地历史行情混用生成回测信号。",
    delayed: item.delayed,
  };
}
