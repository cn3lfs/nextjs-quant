"use client";
import { formatNumber } from "trading-strategy-core/format-number";

import { cn } from "~/lib/common/classnames";
import type { LiveMarketBreadth } from "~/server/market/live-market-breadth";
import type {
  MarketBreadth as MarketBreadthData,
  MarketBreadthUnknown,
} from "~/server/market/market-breadth";
import { api } from "~/trpc/react";
import { useQuoteRefreshInterval } from "../market/use-quote-session";
import { Button } from "../ui/button";
import { useTaskVisible } from "../workbench/use-task-visible";

function formatClock(timestamp: number) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function BreadthValue({
  value,
  unknown,
  tone,
}: {
  value: number | null;
  unknown: MarketBreadthUnknown | null;
  tone: "up" | "down";
}) {
  if (value !== null)
    return (
      <strong
        className={cn(
          "tabular-nums",
          tone === "up" ? "text-nc-up" : "text-nc-down",
        )}
      >
        {formatNumber(value, 0)} 家
      </strong>
    );
  return (
    <strong className="tabular-nums text-nc-warn">
      未知
      {unknown === "duplicate"
        ? "（同日重复）"
        : unknown === "invalid"
          ? "（源值非法）"
          : ""}
    </strong>
  );
}

function LiveSourceLine({ data }: { data: LiveMarketBreadth }) {
  const detail = data.markets
    .map(
      (m) =>
        `${m.label} 涨${m.up}/跌${m.down}/平${m.flat} · ${formatNumber(m.amount / 1e8, 0)}亿`,
    )
    .join(" | ");
  return (
    <span className="text-nc-text-4" title={detail}>
      来源：{data.source}（沪深京）· 更新于 {formatClock(data.fetchedAt)}
    </span>
  );
}

function FallbackSourceLine({ data }: { data: MarketBreadthData }) {
  return (
    <span className="text-nc-text-4">
      实时行情暂不可用，已回退通达信本地 SC31 · 观测日 {data.date} · 剔除停牌 ·
      源无平盘字段
      {data.sourceLast && data.sourceLast !== data.date && (
        <> · 源文件最新 {data.sourceLast}</>
      )}
    </span>
  );
}

/**
 * 大盘总览市场涨跌家数与沪深京成交额。
 *
 * 默认直连东方财富实时快照（交易时段温和 15 秒刷新，盘后手动刷新），
 * 离线或限流时自动回退到通达信本地 SC31 日度记录，并显式标明口径与时点。
 */
export function MarketBreadth() {
  const visible = useTaskVisible();
  const quoteInterval = useQuoteRefreshInterval();
  const liveInterval =
    visible && quoteInterval ? Math.max(quoteInterval, 15_000) : false;

  const liveQuery = api.liveMarketBreadth.useQuery(undefined, {
    enabled: visible,
    retry: false,
    staleTime: 10_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
    refetchInterval: liveInterval,
  });

  const localQuery = api.marketBreadth.useQuery(undefined, {
    enabled: visible && liveQuery.isError,
    retry: false,
    staleTime: 60_000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const live = liveQuery.data;
  const fallback = localQuery.data;
  const refreshButton = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="ml-auto"
      disabled={liveQuery.isFetching}
      onClick={() => void liveQuery.refetch()}
    >
      {liveQuery.isError ? "重试实时" : "刷新实时"}
    </Button>
  );

  return (
    <section
      aria-label="市场涨跌家数"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-nc-border bg-nc-card px-4 py-2.5 text-[13px]"
    >
      <span className="font-medium text-nc-text">市场涨跌家数</span>
      {live ? (
        <>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-nc-text-3">上涨</span>
            <strong className="tabular-nums text-nc-up">
              {formatNumber(live.up, 0)} 家
            </strong>
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-nc-text-3">平盘</span>
            <strong className="tabular-nums text-nc-text-2">
              {formatNumber(live.flat, 0)} 家
            </strong>
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-nc-text-3">下跌</span>
            <strong className="tabular-nums text-nc-down">
              {formatNumber(live.down, 0)} 家
            </strong>
          </span>
          {live.amount > 0 && (
            <span className="inline-flex items-baseline gap-1.5">
              <span className="text-nc-text-3">沪深京成交</span>
              <strong className="tabular-nums text-nc-text">
                {formatNumber(live.amount / 1e8, 0)} 亿
              </strong>
            </span>
          )}
          <LiveSourceLine data={live} />
          {refreshButton}
        </>
      ) : !liveQuery.isError ? (
        <>
          <span className="text-nc-text-3">正在获取实时市场涨跌家数…</span>
          {refreshButton}
        </>
      ) : fallback?.state === "ok" ? (
        <>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-nc-text-3">上涨</span>
            <BreadthValue
              value={fallback.up}
              unknown={fallback.upUnknown}
              tone="up"
            />
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-nc-text-3">下跌</span>
            <BreadthValue
              value={fallback.down}
              unknown={fallback.downUnknown}
              tone="down"
            />
          </span>
          <FallbackSourceLine data={fallback} />
          {refreshButton}
        </>
      ) : localQuery.isLoading ? (
        <>
          <span className="text-nc-text-3">
            实时行情暂不可用，正在读取本地 SC31 回退记录…
          </span>
          {refreshButton}
        </>
      ) : (
        <>
          <span role="alert" className="text-nc-bad">
            实时市场涨跌获取失败：{liveQuery.error.message}
            {fallback?.warning ? `（${fallback.warning}）` : ""}
          </span>
          {refreshButton}
        </>
      )}
    </section>
  );
}
