"use client";
import { formatNumber } from "trading-strategy-core/format-number";

import { cn } from "~/lib/common/classnames";
import type {
  MarketBreadth as MarketBreadthData,
  MarketBreadthUnknown,
} from "~/server/market/market-breadth";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import { useTaskVisible } from "../workbench/use-task-visible";

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

function SourceLine({ data }: { data: MarketBreadthData }) {
  return (
    <span className="text-nc-text-4">
      来源：通达信本地 SC31 日度记录 · SC31 观测日 {data.date} · 剔除停牌 ·
      源无平盘字段
      {data.sourceLast && data.sourceLast !== data.date && (
        <> · 源文件最新 {data.sourceLast}</>
      )}
    </span>
  );
}

/**
 * 今日概况的本地市场宽度。上涨与下跌家数取自同一条 SC31 日度记录；
 * 未取到记录时不补造，也不借用今日指数报价的日期。保留有限新鲜期：
 * 重新进入或焦点返回时若已超过 60 秒，会重读本地记录；不轮询。
 */
export function MarketBreadth() {
  const visible = useTaskVisible();
  const query = api.marketBreadth.useQuery(undefined, {
    enabled: visible,
    retry: false,
    staleTime: 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
    refetchOnReconnect: false,
  });
  const data = query.data;
  const retry = (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="ml-auto"
      disabled={query.isFetching}
      onClick={() => void query.refetch()}
    >
      重读本地记录
    </Button>
  );

  return (
    <section
      aria-label="市场涨跌家数"
      className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border border-nc-border bg-nc-card px-4 py-2.5 text-[13px]"
    >
      <span className="font-medium text-nc-text">市场涨跌家数</span>
      {query.isError ? (
        <>
          <span role="alert" className="text-nc-bad">
            读取失败：{query.error.message}
          </span>
          {retry}
        </>
      ) : !data ? (
        <>
          <span className="text-nc-text-3">正在读取本地 SC31 记录…</span>
          {retry}
        </>
      ) : data.state === "source-unconfigured" ? (
        <>
          <span className="text-nc-text-3">
            通达信本地目录尚未配置，无法读取 SC31 记录。
          </span>
          {retry}
        </>
      ) : data.state === "no-record" ? (
        <>
          <span className="text-nc-text-3">
            {data.warning ?? "所选截止日及之前没有本地 SC31 记录。"}
          </span>
          {retry}
        </>
      ) : (
        <>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-nc-text-3">上涨</span>
            <BreadthValue value={data.up} unknown={data.upUnknown} tone="up" />
          </span>
          <span className="inline-flex items-baseline gap-1.5">
            <span className="text-nc-text-3">下跌</span>
            <BreadthValue
              value={data.down}
              unknown={data.downUnknown}
              tone="down"
            />
          </span>
          <SourceLine data={data} />
          {retry}
        </>
      )}
    </section>
  );
}
