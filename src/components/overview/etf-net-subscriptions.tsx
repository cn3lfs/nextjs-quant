"use client";
import { formatNumber } from "trading-strategy-core/format-number";

import { cn } from "~/lib/common/classnames";
import type {
  EtfNetSubscriptionPoint,
  EtfNetSubscriptions as EtfNetData,
} from "~/server/market/etf-net-subscriptions";
import { api } from "~/trpc/react";
import { Button } from "../ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { useTaskVisible } from "../workbench/use-task-visible";

const CHART_WIDTH = 720;
const CHART_HEIGHT = 190;
const PAD_X = 8;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;

const signedAmount = (value: number) =>
  `${value > 0 ? "+" : ""}${formatNumber(value, 2)}`;
const toneOf = (value: number | null) =>
  value === null || value === 0
    ? "text-nc-text-2"
    : value > 0
      ? "text-nc-up"
      : "text-nc-down";

/**
 * 红正绿负柱表示亿元净申赎，灰色折线表示精确同日的上证指数点数。
 * 两条序列各自缩放并各自标注单位，不混成一套双轴颜色。
 */
function TrendChart({ points }: { points: EtfNetSubscriptionPoint[] }) {
  const count = points.length;
  const x = (index: number) =>
    count === 1
      ? CHART_WIDTH / 2
      : PAD_X + (index / (count - 1)) * (CHART_WIDTH - PAD_X * 2);
  const plotHeight = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM;
  const middle = PAD_TOP + plotHeight / 2;
  const half = plotHeight / 2 - 4;
  const maxAbs = Math.max(
    1,
    ...points.map((point) => Math.abs(point.net ?? 0)),
  );
  const yNet = (value: number) => middle - (value / maxAbs) * half;
  const indexValues = points
    .map((point) => point.index)
    .filter((value): value is number => value !== null);
  const indexMin = Math.min(...indexValues);
  const indexMax = Math.max(...indexValues);
  const yIndex = (value: number) =>
    indexMax === indexMin
      ? middle
      : CHART_HEIGHT -
        PAD_BOTTOM -
        4 -
        ((value - indexMin) / (indexMax - indexMin)) * (plotHeight - 8);
  const barWidth = Math.max(
    2,
    Math.min(10, ((CHART_WIDTH - PAD_X * 2) / Math.max(1, count)) * 0.55),
  );
  let line = "";
  let open = false;
  points.forEach((point, index) => {
    if (point.index === null) {
      open = false;
      return;
    }
    line += `${open ? "L" : "M"}${x(index).toFixed(1)} ${yIndex(point.index).toFixed(1)}`;
    open = true;
  });
  return (
    <svg
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      className="block h-auto max-h-52 w-full"
      role="img"
      aria-label="ETF 全市场日度净申赎柱与上证指数折线，按记录日共用横轴"
    >
      <line
        x1={PAD_X}
        x2={CHART_WIDTH - PAD_X}
        y1={middle}
        y2={middle}
        className="text-nc-border"
        stroke="currentColor"
        strokeWidth={1}
      />
      {points.map((point, index) =>
        point.net === null ? null : (
          <rect
            key={`bar-${point.date}`}
            x={x(index) - barWidth / 2}
            y={Math.min(middle, yNet(point.net))}
            width={barWidth}
            height={Math.abs(yNet(point.net) - middle)}
            className={point.net >= 0 ? "text-nc-up" : "text-nc-down"}
            fill="currentColor"
          />
        ),
      )}
      {line && (
        <path
          d={line}
          fill="none"
          className="text-nc-text-4"
          stroke="currentColor"
          strokeWidth={1.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function Body({ data }: { data: EtfNetData }) {
  const latest = data.points.at(-1);
  const duplicateDates = new Set(data.duplicates.map((item) => item.date));
  return (
    <>
      <p
        className="mb-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px] text-nc-text-3"
        role="status"
      >
        <span>
          截至 {data.latest}（记录日） · 显示 {data.window!.start} ~{" "}
          {data.window!.end} · {data.window!.count} 个记录日
        </span>
        {data.sourceFirst && data.sourceLast && (
          <span className="text-nc-text-4">
            源整体覆盖 {data.sourceFirst} ~ {data.sourceLast}
          </span>
        )}
      </p>
      <div className="mb-2 flex flex-wrap items-baseline gap-x-5 gap-y-1.5 text-[13px]">
        <span className="inline-flex items-baseline gap-1.5">
          <span className="text-nc-text-3">最新净申赎</span>
          <strong
            className={cn(
              "text-[15px] font-medium tabular-nums",
              toneOf(latest?.net ?? null),
            )}
          >
            {latest?.net == null ? "缺失" : `${signedAmount(latest.net)} 亿元`}
          </strong>
        </span>
        <span className="inline-flex items-baseline gap-1.5">
          <span className="text-nc-text-3">区间合计</span>
          {data.summary.total === null ? (
            <span className="tabular-nums text-nc-warn">
              有效 {data.summary.valid}/{data.window!.count} 日 · 未合计
            </span>
          ) : (
            <strong className={cn("tabular-nums", toneOf(data.summary.total))}>
              {signedAmount(data.summary.total)} 亿元
            </strong>
          )}
        </span>
        <span className="inline-flex items-baseline gap-1.5">
          <span className="text-nc-text-3">{data.index.name}</span>
          {data.index.state === "unavailable" ? (
            <span className="text-nc-warn">不可用</span>
          ) : latest?.index == null ? (
            <span className="text-nc-text-4">同日无数据</span>
          ) : (
            <strong className="tabular-nums text-nc-text-2">
              {formatNumber(latest.index, 2)} 点
            </strong>
          )}
        </span>
      </div>
      <div className="flex items-center justify-between text-[12px] text-nc-text-4">
        <span>净申赎（亿元）</span>
        <span>上证指数（点，灰色折线）</span>
      </div>
      <TrendChart points={data.points} />
      <div className="mt-1 flex justify-between text-[12px] tabular-nums text-nc-text-4">
        <span>{data.window!.start}</span>
        <span>{data.window!.end}</span>
      </div>
      {data.index.state === "unavailable" && (
        <p className="mt-1 text-[13px] text-nc-warn">
          {data.index.warning}；申赎柱与合计不受影响，两个单位不互相替代。
        </p>
      )}
      {data.index.state === "ok" &&
        data.index.sourceLast &&
        data.index.matched < data.window!.count && (
          <p className="mt-1 text-[13px] text-nc-text-4">
            指数源截至 {data.index.sourceLast}；仅 {data.index.matched}/
            {data.window!.count} 个记录日有精确同日点数，其余留空，不跨日填补。
          </p>
        )}
      {data.duplicates.length > 0 && (
        <p className="mt-1 text-[13px] text-nc-warn">
          同日重复 {data.duplicates.length}{" "}
          处，未挑选其中一条，对应金额按缺失处理：
          {data.duplicates
            .map((item) => `${item.date}（${item.count} 条）`)
            .join("、")}
        </p>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer select-none text-[13px] text-nc-text-3">
          逐日明细（{data.points.length} 日，按日期倒序）
        </summary>
        <div className="mt-2 max-h-72 overflow-auto">
          <Table
            className="min-w-[360px] text-[13px]"
            aria-label="ETF 全市场日度净申赎逐日明细"
          >
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="py-1 text-nc-text-4">
                  日期
                </TableHead>
                <TableHead
                  scope="col"
                  className="py-1 text-right text-nc-text-4"
                >
                  净申赎（亿元）
                </TableHead>
                <TableHead
                  scope="col"
                  className="py-1 text-right text-nc-text-4"
                >
                  上证指数（点）
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="tabular-nums">
              {[...data.points].reverse().map((point) => (
                <TableRow key={point.date}>
                  <TableHead
                    scope="row"
                    className="bg-transparent py-1 text-left font-normal"
                  >
                    {point.date}
                  </TableHead>
                  <TableCell className="py-1 text-right">
                    {point.net === null
                      ? duplicateDates.has(point.date)
                        ? "歧义（重复）"
                        : "缺失"
                      : formatNumber(point.net, 2)}
                  </TableCell>
                  <TableCell className="py-1 text-right">
                    {point.index === null
                      ? "同日无数据"
                      : formatNumber(point.index, 2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </details>
    </>
  );
}

/**
 * 今日概况里的全市场 ETF 日度净申赎历史。只在首次显示和用户点按
 * 「重读本地记录」时读取本地 SC38 与上证日线，不访问网络、不写库、不轮询。
 * 未配置、无记录和读取失败各自可辨识，重试只重读本地文件。
 */
export function EtfNetSubscriptions() {
  const visible = useTaskVisible();
  const query = api.etfNetSubscriptions.useQuery(undefined, {
    enabled: visible,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    refetchOnMount: false,
    staleTime: Infinity,
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
      aria-label="ETF 全市场日度净申赎"
      className="rounded-lg border border-nc-border bg-nc-card p-4"
    >
      <header className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="m-0 text-[15px] font-medium text-nc-text">
          ETF 全市场日度净申赎
        </h3>
        <span className="text-[12px] text-nc-text-4">
          通达信本地 · SC38 第二列
        </span>
        {retry}
      </header>
      {query.isError ? (
        <p role="alert" className="m-0 text-[13px] text-nc-bad">
          读取失败：{query.error.message}。可点「重读本地记录」重试。
        </p>
      ) : !data ? (
        <p className="m-0 text-[13px] text-nc-text-3">
          正在读取本地 SC38 记录…
        </p>
      ) : data.state === "source-unconfigured" ? (
        <p className="m-0 text-[13px] text-nc-text-3">
          通达信本地目录尚未配置；净申赎只读本地 SC38，不访问网络。
        </p>
      ) : data.state === "no-history" ? (
        <p className="m-0 text-[13px] text-nc-text-3">
          {data.warning ?? "所选截止日及之前没有本地 SC38 记录。"}
        </p>
      ) : (
        <Body data={data} />
      )}
      <p className="mb-0 mt-2 text-[12px] leading-[1.5] text-nc-text-4">
        数据：通达信本地 gpsh999999.dat（SC38 第二列 ETF
        净申赎，亿元；第一列规模不混用）。最多 60
        个记录日，缺失不补零、同日重复按缺失、不插值；指数仅取精确同日，不跨日填补。真实单点样例：
        {data?.latest && data.points.at(-1)?.net != null
          ? `${data.latest} = ${formatNumber(data.points.at(-1)!.net!, 2)} 亿元`
          : "最新记录不可用"}
        。
      </p>
    </section>
  );
}
