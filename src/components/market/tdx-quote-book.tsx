"use client";
import type { ReviewValue } from "~/lib/portfolio/trade-review";
import { compactNumber } from "~/lib/market/tdx-fundamentals";
import {
  activeBuyRatio,
  orderBook,
  orderImbalance,
  quotePriceStats,
  quoteSessionLabels,
  type QuoteSession,
  type QuoteSnapshot,
} from "~/lib/market/tdx-quote-view";

const missing = (metric: ReviewValue) =>
  `不可得：${metric.reason ?? "证据不足"}`;
const percent = (metric: ReviewValue, digits = 2) =>
  metric.value === null
    ? missing(metric)
    : `${(metric.value * 100).toFixed(digits)}%`;
const signedPercent = (metric: ReviewValue) =>
  metric.value === null
    ? missing(metric)
    : `${metric.value >= 0 ? "+" : ""}${(metric.value * 100).toFixed(2)}%`;
const tone = (metric: ReviewValue) =>
  metric.value === null
    ? ""
    : metric.value > 0
      ? "up"
      : metric.value < 0
        ? "down"
        : "";

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-[1px]">
      <span className="shrink-0 text-[11px] text-nc-text-4">{label}</span>
      <span className="truncate text-right text-[12px] tabular-nums">
        {children}
      </span>
    </div>
  );
}

export function TdxQuoteBook({
  quote,
  precision,
  session,
  hasOrderBook,
}: {
  quote: QuoteSnapshot;
  precision: number;
  session: QuoteSession;
  /** 指数没有可交易盘口，协议返回空档；此时只展示价格与统计。 */
  hasOrderBook: boolean;
}) {
  const stats = quotePriceStats(quote);
  const imbalance = orderImbalance(quote);
  const rows = orderBook(quote);
  const price = (value: number | null) =>
    value === null ? "—" : value.toFixed(precision);
  // 档位价格按相对昨收着色，与通达信一致。
  const levelTone = (value: number | null) =>
    value === null || !Number.isFinite(quote.preClose)
      ? ""
      : value > quote.preClose
        ? "up"
        : value < quote.preClose
          ? "down"
          : "";
  return (
    <div className="space-y-2.5" data-testid="tdx-quote-book">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span
          className={`text-2xl font-semibold tabular-nums ${tone(stats.change)}`}
        >
          {price(Number.isFinite(quote.price) ? quote.price : null)}
        </span>
        <span className={`text-sm tabular-nums ${tone(stats.change)}`}>
          {stats.change.value === null
            ? missing(stats.change)
            : `${stats.change.value >= 0 ? "+" : ""}${stats.change.value.toFixed(precision)}`}
        </span>
        <span className={`text-sm tabular-nums ${tone(stats.changePercent)}`}>
          {signedPercent(stats.changePercent)}
        </span>
        <span className="w-full text-[11px] text-nc-text-4">
          {quoteSessionLabels[session]} · 快照时刻{" "}
          {quote.quoteTime ?? "编码未知，不能据此判断新鲜度"}
        </span>
      </div>
      {hasOrderBook ? (
        <div
          className="border-y border-nc-border-soft py-1 text-[12px]"
          role="table"
          aria-label="五档盘口（挂单量为源单位）"
        >
          <div className="flex justify-between px-1 pb-1 text-[11px] text-nc-text-4">
            <span>委比 <span className={tone(imbalance.ratio)}>{signedPercent(imbalance.ratio)}</span></span>
            <span>
              委差{" "}
              {imbalance.difference.value === null
                ? missing(imbalance.difference)
                : (compactNumber(imbalance.difference.value) ?? "—")}
            </span>
          </div>
          {rows.map((row) => (
            <div
              key={`${row.side}${row.level}`}
              role="row"
              className={`relative grid grid-cols-[3em_1fr_1fr] items-center px-1 leading-[20px] ${row.side === "bid" && row.level === 1 ? "mt-1 border-t border-nc-border-soft pt-1" : ""}`}
            >
              <span
                aria-hidden
                className={`absolute inset-y-[3px] right-0 rounded-sm opacity-15 ${row.side === "ask" ? "bg-nc-down" : "bg-nc-up"}`}
                style={{ width: `${Math.round(row.depth * 60)}%` }}
              />
              <span role="cell" className="text-nc-text-3">
                {row.side === "ask" ? "卖" : "买"}
                {row.level}
              </span>
              <span
                role="cell"
                className={`text-right tabular-nums ${levelTone(row.price)}`}
              >
                {price(row.price)}
              </span>
              <span role="cell" className="text-right tabular-nums">
                {row.volume === null ? "—" : (compactNumber(row.volume) ?? "—")}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-[12px] text-nc-text-3">
          该品种没有可交易的五档盘口（指数按协议返回空档），仅展示价格与统计。
          {imbalance.ratio.value === null && ` 委比${missing(imbalance.ratio)}`}
        </p>
      )}
      <div className="grid grid-cols-2 gap-x-4">
        <Stat label="今开">
          <span className={levelTone(quote.open)}>{price(quote.open)}</span>
        </Stat>
        <Stat label="昨收">{price(quote.preClose)}</Stat>
        <Stat label="最高">
          <span className={levelTone(quote.high)}>{price(quote.high)}</span>
        </Stat>
        <Stat label="最低">
          <span className={levelTone(quote.low)}>{price(quote.low)}</span>
        </Stat>
        <Stat label="振幅">{percent(stats.amplitude)}</Stat>
        <Stat label="涨速">
          {Number.isFinite(quote.riseSpeed)
            ? `${quote.riseSpeed.toFixed(2)}%`
            : "—"}
        </Stat>
        <Stat label="总量">
          {compactNumber(Number.isFinite(quote.volume) ? quote.volume : null) ??
            "—"}
        </Stat>
        <Stat label="金额">
          {compactNumber(Number.isFinite(quote.amount) ? quote.amount : null) ??
            "—"}
        </Stat>
        <Stat label="外盘">
          <span className="up">{compactNumber(quote.outerVolume) ?? "—"}</span>
        </Stat>
        <Stat label="内盘">
          <span className="down">{compactNumber(quote.innerVolume) ?? "—"}</span>
        </Stat>
        <Stat label="外盘占比">{percent(activeBuyRatio(quote))}</Stat>
      </div>
      <p
        className="text-[10.5px] leading-[1.5] text-nc-text-4"
        title="通达信 7709 公共服务器即时快照，只供盘中观察：快照不含日期，不能证明属于今天，也不代表成交可得性；量与额的单位未经核验，按源单位原样展示，不换算手/股、不据此推算均价。请勿与本地历史行情混用生成回测信号。"
      >
        7709 即时快照，只供盘中观察，不代表成交可得性；量、额按源单位原样展示。
      </p>
    </div>
  );
}
