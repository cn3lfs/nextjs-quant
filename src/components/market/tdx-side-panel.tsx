"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { useState } from "react";
import { ArrowClockwise as RefreshCw } from "@phosphor-icons/react/ssr";
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
  quoteSessionLabels,
} from "~/lib/market/tdx-quote-view";
import { TdxQuoteBook } from "./tdx-quote-book";
import { ThsdkMarketPanels } from "./thsdk-market-panels";
import { useQuoteSession } from "./use-quote-session";
import { CapitalSection, StockEventsSection } from "./stock-side-cards";
import { Button } from "../ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import { usePanelVisible } from "../workbench/keep-alive";

export const tradableSymbol = (symbol: string) =>
  /^(sh|sz|bj)\d{6}$/.test(symbol) && !isNonAShareChartSymbol(symbol);

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
  const [bookSource, setBookSource] = useState<"tstdx" | "thsdk">("tstdx");
  const [refreshNonce, setRefreshNonce] = useState(0);
  const session = useQuoteSession();
  const quotable = tradableSymbol(symbol);
  const index = isMarketIndex(symbol);
  const interval = session === null ? null : quoteRefreshInterval(session);
  // Kept-alive but hidden panel: no polling.
  const visible = usePanelVisible();
  const thsdkStatus = api.thsdkStatus.useQuery(undefined, {
    enabled: visible && quotable,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const thsdkReady =
    thsdkStatus.data?.enabled === true &&
    thsdkStatus.data.state === "authenticated";
  const quotes = api.tdxQuotes.useQuery([symbol], {
    ...quoteQueryOptions,
    enabled: quotable,
    refetchInterval: visible && auto && interval !== null ? interval : false,
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
  // 本地财务估值固定使用 tstdx 快照价；切换盘口来源只换展示，绝不静默换基准价。
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
    shown(metric, (v) => displayNumber(v, digits));
  const ratio = (metric: ReviewValue) =>
    shown(metric, (v) => `${displayNumber(v * 100, 2)}%`);
  const amount = (metric: ReviewValue) =>
    shown(metric, (v) => compactNumber(v) ?? "—");
  return (
    <section aria-label="实时盘口与关键基本面" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={bookSource}
          onValueChange={(value) => {
            if (value === "tstdx") setBookSource("tstdx");
            else if (value === "thsdk" && thsdkReady) setBookSource("thsdk");
          }}
        >
          <SelectTrigger
            size="sm"
            aria-label="盘口来源"
            className="w-auto min-w-20"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tstdx">tstdx</SelectItem>
            <SelectItem value="thsdk" disabled={!thsdkReady}>
              同花顺{thsdkReady ? "" : "（未就绪）"}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          size="sm"
          variant="outline"
          disabled={quotes.isFetching}
          onClick={() => {
            setRefreshNonce((nonce) => nonce + 1);
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
      {bookSource === "thsdk" ? (
        thsdkReady ? (
          <ThsdkMarketPanels key={refreshNonce} symbol={symbol} auto={auto} />
        ) : (
          <div role="alert" className="space-y-1 text-[12px] text-nc-warn">
            <p>
              同花顺当前不可用（
              {thsdkStatus.error
                ? "状态读取失败"
                : thsdkStatus.data
                  ? {
                      unconfigured: "未配置",
                      disabled: "已停用",
                      logged_out: "未登录",
                      qr_pending: "扫码中",
                      authenticated: "已认证",
                      error: "异常",
                    }[thsdkStatus.data.state]
                  : "状态读取中"}
              ），未显示任何替代盘口。
            </p>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setBookSource("tstdx")}
            >
              切回 tstdx
            </Button>
          </div>
        )
      ) : quotes.error ? (
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
      {!index && <StockEventsSection symbol={symbol} />}
      {!index && <CapitalSection symbol={symbol} />}
    </section>
  );
}
