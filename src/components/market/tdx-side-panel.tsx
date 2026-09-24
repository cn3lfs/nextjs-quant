"use client";
import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { ReviewValue } from "~/lib/portfolio/trade-review";
import { api } from "~/trpc/react";
import { isMarketIndex } from "~/lib/market/market-indices";
import {
  chartPricePrecision,
  isNonAShareChartSymbol,
} from "~/lib/chart/chart-symbol";
import {
  compactNumber,
  fundamentalMetrics,
} from "~/lib/market/tdx-fundamentals";
import {
  quoteRefreshInterval,
  quoteSession,
  quoteSessionLabels,
  type QuoteSession,
} from "~/lib/market/tdx-quote-view";
import { TdxQuoteBook } from "./tdx-quote-book";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

export const tradableSymbol = (symbol: string) =>
  /^(sh|sz|bj)\d{6}$/.test(symbol) && !isNonAShareChartSymbol(symbol);

/** 时段只驱动刷新节奏，所以在客户端定时重算即可，不在服务端渲染时判定。 */
function useQuoteSession() {
  const [session, setSession] = useState<QuoteSession | null>(null);
  useEffect(() => {
    const update = () => setSession(quoteSession(Date.now()));
    update();
    const timer = setInterval(update, 30000);
    return () => clearInterval(timer);
  }, []);
  return session;
}

/*
 * 与图表下方的基本面详情共用同一组查询键：这里负责轮询，下方只读缓存，
 * 两处拿到的永远是同一份快照。
 */
export const quoteQueryOptions = {
  retry: false,
  refetchOnWindowFocus: false,
} as const;
export const financeQueryOptions = {
  retry: false,
  refetchOnWindowFocus: false,
  staleTime: 3600000,
} as const;

const shown = (metric: ReviewValue, format: (value: number) => string) =>
  metric.value === null ? "—" : format(metric.value);

function Row({
  label,
  value,
  title,
}: {
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div
      className="flex items-baseline justify-between gap-2 py-[1px]"
      title={title}
    >
      <span className="shrink-0 text-[11px] text-nc-text-4">{label}</span>
      <span className="truncate text-right text-[12px] tabular-nums">
        {value}
      </span>
    </div>
  );
}

/** 行情图表右栏：通达信式的即时盘口 + 关键基本面，详细报表在图表下方。 */
export function TdxSidePanel({ symbol }: { symbol: string }) {
  const [auto, setAuto] = useState(false);
  const session = useQuoteSession();
  const quotable = tradableSymbol(symbol);
  const index = isMarketIndex(symbol);
  const interval = session === null ? null : quoteRefreshInterval(session);
  const quotes = api.tdxQuotes.useQuery([symbol], {
    ...quoteQueryOptions,
    enabled: quotable,
    refetchInterval: auto && interval !== null ? interval : false,
  });
  const local = api.tdxLocalFinancials.useQuery(symbol, {
    ...financeQueryOptions,
    enabled: quotable && !index,
  });
  const finance = api.tdxFinance.useQuery(symbol, {
    ...financeQueryOptions,
    enabled: quotable && !index,
  });
  if (!quotable)
    return (
      <p className="text-[12px] text-nc-text-3">
        板块与自定义指数没有通达信实时盘口与财务快照。
      </p>
    );
  const quote = quotes.data?.[0];
  const price =
    quote && Number.isFinite(quote.price) && quote.price > 0
      ? quote.price
      : null;
  const report = local.data?.financials;
  const overlay = finance.data?.finance ?? null;
  const metrics =
    report &&
    fundamentalMetrics({
      report: report.fields,
      reportDate: report.reportDate,
      latestShares: overlay
        ? { totalShares: overlay.totalShares, floatShares: overlay.floatShares }
        : null,
      price,
    });
  const fixed = (metric: ReviewValue, digits = 2) =>
    shown(metric, (v) => v.toFixed(digits));
  const ratio = (metric: ReviewValue) =>
    shown(metric, (v) => `${(v * 100).toFixed(2)}%`);
  const amount = (metric: ReviewValue) =>
    shown(metric, (v) => compactNumber(v) ?? "—");
  return (
    <section aria-label="实时盘口与关键基本面" className="space-y-3">
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={quotes.isFetching}
          onClick={() => {
            void quotes.refetch();
            void finance.refetch();
          }}
        >
          <RefreshCw size={12} />
          刷新
        </Button>
        <label
          htmlFor="tdx-quote-auto"
          className="flex items-center gap-1.5 text-[11px] text-nc-text-3"
        >
          <Switch
            id="tdx-quote-auto"
            checked={auto}
            onCheckedChange={setAuto}
          />
          自动
        </label>
        <span
          role="status"
          className="ml-auto truncate text-[11px] text-nc-text-4"
          title="时段按北京时间星期与钟点判定，不含节假日日历"
        >
          {session === null
            ? "判定时段…"
            : interval === null
              ? `${quoteSessionLabels[session]} · 不自动刷新`
              : auto
                ? `每 ${interval / 1000} 秒刷新`
                : quoteSessionLabels[session]}
        </span>
      </div>
      {quotes.error ? (
        <div role="alert" className="text-[12px] text-nc-bad">
          盘口读取失败：{quotes.error.message}
          <Button
            size="sm"
            variant="outline"
            className="ml-2"
            onClick={() => void quotes.refetch()}
          >
            重试
          </Button>
        </div>
      ) : quote ? (
        <TdxQuoteBook
          quote={quote}
          precision={chartPricePrecision(symbol)}
          session={session ?? "post"}
          hasOrderBook={quote.bids.length > 0 || quote.asks.length > 0}
        />
      ) : (
        <p role="status" className="text-[12px] text-nc-text-3">
          {quotes.isFetching ? "正在读取五档盘口…" : "尚无盘口快照"}
        </p>
      )}
      {!index && (
        <div className="border-t border-nc-border-soft pt-2">
          <div className="mb-1 flex items-baseline justify-between">
            <span className="text-[12px] font-medium">基本面</span>
            <span className="text-[10.5px] text-nc-text-4">
              {report ? `报告期 ${report.reportDate}` : ""}
            </span>
          </div>
          {local.error ? (
            <p role="alert" className="text-[12px] text-nc-bad">
              本地财务包读取失败：{local.error.message}
            </p>
          ) : !local.data ? (
            <p role="status" className="text-[12px] text-nc-text-3">
              正在读取本地财务包…
            </p>
          ) : !metrics || !report ? (
            <p role="status" className="text-[12px] text-nc-text-3">
              本地没有该证券的财务数据：{local.data.reason}
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-x-4">
              <Row label="总市值" value={amount(metrics.marketCap)} />
              <Row label="流通值" value={amount(metrics.floatMarketCap)} />
              <Row
                label="市盈(年化)"
                value={fixed(metrics.annualizedPe)}
                title="报告期累计 × 季度倍数，不是 TTM"
              />
              <Row label="市净率" value={fixed(metrics.priceToBook)} />
              <Row
                label="每股收益"
                value={fixed(metrics.reportedEps, 3)}
                title="报告期累计"
              />
              <Row
                label="每股净资产"
                value={fixed(metrics.bookValuePerShare, 3)}
              />
              <Row label="净资产收益" value={ratio(metrics.reportedRoe)} />
              <Row label="净利率" value={ratio(metrics.netMargin)} />
              <Row label="流通占比" value={ratio(metrics.floatRatio)} />
              <Row
                label="股东户数"
                value={compactNumber(report.fields.shareholders) ?? "—"}
              />
            </div>
          )}
          {report && (
            <p className="mt-1.5 text-[10.5px] text-nc-text-4">
              口径与完整报表见图表下方「基本面详情」。
            </p>
          )}
        </div>
      )}
    </section>
  );
}
