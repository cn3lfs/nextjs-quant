"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { ChartLineUp } from "@phosphor-icons/react/ssr";
import type {
  LimitBreadthHistory,
  LimitBreadthPoint,
} from "~/server/market/limit-history";
import { api } from "~/trpc/react";
import { Panel, PanelEmpty } from "../panels";
import { Button } from "../ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";

const CHART_WIDTH = 720;
const CHART_HEIGHT = 180;
const PAD_X = 8;
const PAD_TOP = 10;
const PAD_BOTTOM = 10;

function count(value: number | null) {
  return value == null ? "缺失" : displayNumber(value, 0);
}

/** 两序列共用 0 起点纵轴；缺失值断线，孤立真实点也用圆点保留。 */
function TrendChart({
  points,
  max,
  label,
}: {
  points: LimitBreadthPoint[];
  max: number;
  label: string;
}) {
  const x = (index: number) =>
    points.length === 1
      ? CHART_WIDTH / 2
      : PAD_X + (index / (points.length - 1)) * (CHART_WIDTH - PAD_X * 2);
  const y = (value: number) =>
    CHART_HEIGHT -
    PAD_BOTTOM -
    (value / max) * (CHART_HEIGHT - PAD_TOP - PAD_BOTTOM);
  const path = (field: "up" | "down") => {
    const parts: string[] = [];
    let open = false;
    points.forEach((point, index) => {
      const value = point[field];
      if (value == null) {
        open = false;
        return;
      }
      parts.push(
        `${open ? "L" : "M"}${x(index).toFixed(1)} ${y(value).toFixed(1)}`,
      );
      open = true;
    });
    return parts.join(" ");
  };
  return (
    <svg
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      className="block h-auto max-h-56 w-full"
      role="img"
      aria-label={label}
    >
      <line
        x1={PAD_X}
        x2={CHART_WIDTH - PAD_X}
        y1={y(0)}
        y2={y(0)}
        className="text-nc-border"
        stroke="currentColor"
        strokeWidth={1}
      />
      <path
        d={path("up")}
        fill="none"
        className="text-nc-up"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={path("down")}
        fill="none"
        className="text-nc-down"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeDasharray="5 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {points.map((point, index) =>
        point.up == null ? null : (
          <circle
            key={`up-${point.date}`}
            cx={x(index)}
            cy={y(point.up)}
            r={2.4}
            className="text-nc-up"
            fill="currentColor"
          />
        ),
      )}
      {points.map((point, index) =>
        point.down == null ? null : (
          <circle
            key={`down-${point.date}`}
            cx={x(index)}
            cy={y(point.down)}
            r={2.4}
            className="text-nc-down"
            fill="currentColor"
          />
        ),
      )}
    </svg>
  );
}

type TrendDuplicate = LimitBreadthHistory["duplicates"][number] & {
  field?: "up" | "down";
};

type DailyHistory = Pick<
  LimitBreadthHistory,
  "latest" | "sourceFirst" | "sourceLast" | "points"
> & {
  window: NonNullable<LimitBreadthHistory["window"]>;
  duplicates: TrendDuplicate[];
};

function DailyTrendContent({
  history,
  date,
  upLabel,
  downLabel,
  chartLabel,
  tableLabel,
}: {
  history: DailyHistory;
  date: string;
  upLabel: string;
  downLabel: string;
  chartLabel: string;
  tableLabel: string;
}) {
  const { window, points, duplicates, latest, sourceFirst, sourceLast } =
    history;
  const latestPoint = points.at(-1);
  const max = Math.max(
    1,
    ...points.flatMap((point) => [point.up ?? 0, point.down ?? 0]),
  );
  // SC3 / SC4 分列记录重复，SC31 整行重复时两列都歧义。
  const upDuplicates = new Set<string>();
  const downDuplicates = new Set<string>();
  for (const { date, field } of duplicates) {
    if (field !== "down") upDuplicates.add(date);
    if (field !== "up") downDuplicates.add(date);
  }

  return (
    <>
      <p
        className="mb-1 flex flex-wrap gap-x-2 text-sm text-nc-text-3"
        role="status"
      >
        <span>跟随查询日期 {date}</span>
        <span>
          · 显示 {window.start} ~ {window.end}
        </span>
        <span>· {window.count} 个记录日</span>
        {sourceFirst && sourceLast && (
          <span>
            · 本地源覆盖 {sourceFirst} ~ {sourceLast}
          </span>
        )}
      </p>
      {latest && date > latest && (
        <p className="mb-2 text-[13px] text-nc-warn" role="status">
          所选日期 {date} 晚于本地最新记录日 {latest}，曲线与明细截至 {latest}。
        </p>
      )}
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-4 bg-nc-up" />
          {upLabel}{" "}
          <strong className="tabular-nums">
            {count(latestPoint?.up ?? null)}
          </strong>{" "}
          家
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block w-4 border-t-2 border-dashed border-nc-down"
          />
          {downLabel}{" "}
          <strong className="tabular-nums">
            {count(latestPoint?.down ?? null)}
          </strong>{" "}
          家
        </span>
        <span className="text-nc-text-4">纵轴 0–{max} 家</span>
      </div>
      <TrendChart
        points={points}
        max={max}
        label={`${window.start} 至 ${window.end} ${chartLabel}`}
      />
      <div className="mt-1 flex justify-between text-[12px] tabular-nums text-nc-text-4">
        <span>{window.start}</span>
        <span>{window.end}</span>
      </div>
      {duplicates.length > 0 && (
        <p className="mt-2 text-[13px] text-nc-warn">
          同组同日重复 {duplicates.length}{" "}
          处，未挑选其中一条，对应值按缺失处理：
          {duplicates
            .map(({ date, field, count }) => {
              const label = field === "up" ? upLabel : downLabel;
              return `${date}${field ? ` ${label}` : ""}（${count} 条）`;
            })
            .join("、")}
        </p>
      )}
      <details className="mt-3">
        <summary className="cursor-pointer select-none text-[13px] text-nc-text-3">
          逐日明细（{points.length} 日，按日期倒序）
        </summary>
        <div className="mt-2 max-h-72 overflow-auto">
          <Table className="min-w-[360px] text-[13px]" aria-label={tableLabel}>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="py-1 text-nc-text-4">
                  日期
                </TableHead>
                <TableHead
                  scope="col"
                  className="py-1 text-right text-nc-text-4"
                >
                  {upLabel}（家）
                </TableHead>
                <TableHead
                  scope="col"
                  className="py-1 text-right text-nc-text-4"
                >
                  {downLabel}（家）
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="tabular-nums">
              {[...points].reverse().map((point) => (
                <TableRow key={point.date}>
                  <TableHead
                    scope="row"
                    className="bg-transparent py-1 text-left font-normal"
                  >
                    {point.date}
                  </TableHead>
                  <TableCell className="py-1 text-right">
                    {point.up == null && upDuplicates.has(point.date)
                      ? "歧义（重复）"
                      : count(point.up)}
                  </TableCell>
                  <TableCell className="py-1 text-right">
                    {point.down == null && downDuplicates.has(point.date)
                      ? "歧义（重复）"
                      : count(point.down)}
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

/** 涨跌停与涨跌家数共用一次通达信本地查询，各用自己的记录窗口。 */
export function LimitDailyTrend({
  date,
  visible,
}: {
  date: string;
  visible: boolean;
}) {
  const query = api.limitHistory.useQuery(
    { date },
    { enabled: visible && !!date, retry: false, staleTime: 60000 },
  );
  // 切日时宁可显示加载，也不能把上一个日期的曲线当成当前数据。
  const data = query.data?.requestedDate === date ? query.data : undefined;
  const breadth = data?.breadth;

  return (
    <>
      <Panel
        span={12}
        icon={ChartLineUp}
        title="涨跌停按日"
        tag="通达信本地 · 沪深京日度家数"
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            重试本地读取
          </Button>
        }
        note="数据：通达信本地 gpsh999999.dat（SC3 第一列涨停家数、SC4 第一列跌停家数）。最多 60 个记录日；缺失不补零、不插值；与东财打板情绪四池各自独立，重试只重读本地文件。"
      >
        {query.isError ? (
          <div role="alert" className="text-[13px] text-nc-bad">
            <p className="m-0">
              读取通达信本地涨跌停失败：{query.error.message}
            </p>
            <p className="mb-0 mt-1">
              可点右上方「重试本地读取」重新读取本地文件。
            </p>
          </div>
        ) : !data ? (
          <PanelEmpty>正在读取通达信本地涨跌停记录…</PanelEmpty>
        ) : data.state === "source-unconfigured" ? (
          <PanelEmpty>
            通达信本地目录尚未配置。按日复盘只读本地
            SC3/SC4，未读取东财或其他网络数据。
          </PanelEmpty>
        ) : data.state === "no-history" || !data.window ? (
          <PanelEmpty>
            {data.warning ?? `${date} 及之前没有本地涨跌停记录。`}
          </PanelEmpty>
        ) : (
          <DailyTrendContent
            date={date}
            history={{
              ...data,
              window: data.window,
              points: data.points.map(({ date, limitUp, limitDown }) => ({
                date,
                up: limitUp,
                down: limitDown,
              })),
              duplicates: data.duplicates.map(({ date, field, count }) => ({
                date,
                field: field === "limitUp" ? "up" : "down",
                count,
              })),
            }}
            upLabel="涨停"
            downLabel="跌停"
            chartLabel="通达信本地涨停与跌停家数曲线"
            tableLabel="通达信本地涨跌停逐日明细"
          />
        )}
      </Panel>
      <Panel
        span={12}
        icon={ChartLineUp}
        title="涨跌家数按日"
        tag="通达信本地 · SC31 日度家数"
        note="数据：通达信本地 gpsh999999.dat（SC31 第一列上涨家数、第二列下跌家数，剔除停牌，源无平盘字段）。最多 60 个记录日；缺失不补零、不插值。"
      >
        {query.isError ? (
          <PanelEmpty>读取通达信本地涨跌家数失败，可在上方重试。</PanelEmpty>
        ) : !data ? (
          <PanelEmpty>正在读取通达信本地涨跌家数记录…</PanelEmpty>
        ) : !breadth || breadth.state === "no-history" || !breadth.window ? (
          <PanelEmpty>
            {breadth?.warning ?? `${date} 及之前没有本地涨跌家数记录。`}
          </PanelEmpty>
        ) : (
          <DailyTrendContent
            date={date}
            history={{ ...breadth, window: breadth.window }}
            upLabel="上涨"
            downLabel="下跌"
            chartLabel="通达信本地上涨与下跌家数曲线"
            tableLabel="通达信本地涨跌家数逐日明细"
          />
        )}
      </Panel>
    </>
  );
}
