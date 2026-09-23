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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";

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
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm tabular-nums">{children}</span>
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
  precision: 2 | 3;
  session: QuoteSession;
  /** 指数没有可交易盘口，协议返回空档；此时只展示价格与统计。 */
  hasOrderBook: boolean;
}) {
  const stats = quotePriceStats(quote);
  const imbalance = orderImbalance(quote);
  const rows = orderBook(quote);
  const price = (value: number | null) =>
    value === null ? "—" : value.toFixed(precision);
  return (
    <div className="space-y-3" data-testid="tdx-quote-book">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
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
        <span className="text-xs text-muted-foreground">
          {quoteSessionLabels[session]} · 快照时刻{" "}
          {quote.quoteTime ?? "编码未知，不能据此判断新鲜度"}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-4">
        <Stat label="今开">{price(quote.open)}</Stat>
        <Stat label="最高">{price(quote.high)}</Stat>
        <Stat label="最低">{price(quote.low)}</Stat>
        <Stat label="昨收">{price(quote.preClose)}</Stat>
        <Stat label="振幅">{percent(stats.amplitude)}</Stat>
        <Stat label="涨速">
          {Number.isFinite(quote.riseSpeed)
            ? `${quote.riseSpeed.toFixed(2)}%`
            : "—"}
        </Stat>
        <Stat label="外盘占比">{percent(activeBuyRatio(quote))}</Stat>
        <Stat label="委比">
          <span className={tone(imbalance.ratio)}>
            {signedPercent(imbalance.ratio)}
          </span>
        </Stat>
        <Stat label="成交量（源单位）">
          {compactNumber(Number.isFinite(quote.volume) ? quote.volume : null) ??
            "—"}
        </Stat>
        <Stat label="成交额（源单位）">
          {compactNumber(Number.isFinite(quote.amount) ? quote.amount : null) ??
            "—"}
        </Stat>
        <Stat label="内盘 / 外盘（源单位）">
          {`${compactNumber(quote.innerVolume) ?? "—"} / ${compactNumber(quote.outerVolume) ?? "—"}`}
        </Stat>
        <Stat label="委差（源单位）">
          {imbalance.difference.value === null
            ? missing(imbalance.difference)
            : (compactNumber(imbalance.difference.value) ?? "—")}
        </Stat>
      </div>
      {hasOrderBook ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>档位</TableHead>
              <TableHead className="text-right">价格</TableHead>
              <TableHead className="text-right">挂单量（源单位）</TableHead>
              <TableHead>相对深度</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.side}${row.level}`}>
                <TableCell className={row.side === "ask" ? "down" : "up"}>
                  {row.side === "ask" ? "卖" : "买"}
                  {row.level}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {price(row.price)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {row.volume === null
                    ? "—"
                    : (compactNumber(row.volume) ?? "—")}
                </TableCell>
                <TableCell>
                  <span
                    aria-hidden
                    className="block h-2 rounded-sm bg-muted"
                    style={{ width: `${Math.round(row.depth * 100)}%` }}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="text-sm">
          该品种没有可交易的五档盘口（指数按协议返回空档），仅展示价格与统计。
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        通达信 7709
        公共服务器即时快照，只供盘中观察：快照不含日期，不能证明属于今天，
        也不代表成交可得性；量与额的单位未经核验，按源单位原样展示，不换算手/股、不据此推算均价。
        请勿与本地历史行情混用生成回测信号。
      </p>
    </div>
  );
}
