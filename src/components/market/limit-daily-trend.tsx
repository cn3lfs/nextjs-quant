"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { ChartLineUp } from "@phosphor-icons/react/ssr";
import type { LimitHistoryPoint } from "~/server/market/limit-history";
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
  points: LimitHistoryPoint[];
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
  const path = (pick: (point: LimitHistoryPoint) => number | null) => {
    const parts: string[] = [];
    let open = false;
    points.forEach((point, index) => {
      const value = pick(point);
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
        d={path((point) => point.limitUp)}
        fill="none"
        className="text-nc-up"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={path((point) => point.limitDown)}
        fill="none"
        className="text-nc-down"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeDasharray="5 4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {points.map((point, index) =>
        point.limitUp == null ? null : (
          <circle
            key={`up-${point.date}`}
            cx={x(index)}
            cy={y(point.limitUp)}
            r={2.4}
            className="text-nc-up"
            fill="currentColor"
          />
        ),
      )}
      {points.map((point, index) =>
        point.limitDown == null ? null : (
          <circle
            key={`down-${point.date}`}
            cx={x(index)}
            cy={y(point.limitDown)}
            r={2.4}
            className="text-nc-down"
            fill="currentColor"
          />
        ),
      )}
    </svg>
  );
}

/**
 * 通达信本地涨跌停按日复盘。跟随「查询日期」，只读本地 SC3/SC4，
 * 与东财打板情绪四池彼此独立，重试也只重读本地文件。
 */
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
  const upDuplicates = new Set(
    (data?.duplicates ?? [])
      .filter((item) => item.field === "limitUp")
      .map((item) => item.date),
  );
  const downDuplicates = new Set(
    (data?.duplicates ?? [])
      .filter((item) => item.field === "limitDown")
      .map((item) => item.date),
  );
  const latest = data?.points.at(-1);
  const max = Math.max(
    1,
    ...(data?.points.flatMap((point) => [
      point.limitUp ?? 0,
      point.limitDown ?? 0,
    ]) ?? []),
  );
  return (
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
          <p className="m-0">读取通达信本地涨跌停失败：{query.error.message}</p>
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
      ) : data.state === "no-history" ? (
        <PanelEmpty>
          {data.warning ?? `${date} 及之前没有本地涨跌停记录。`}
        </PanelEmpty>
      ) : (
        <>
          <p
            className="mb-1 flex flex-wrap gap-x-2 text-sm text-nc-text-3"
            role="status"
          >
            <span>跟随查询日期 {date}</span>
            <span>
              · 显示 {data.window!.start} ~ {data.window!.end}
            </span>
            <span>· {data.window!.count} 个记录日</span>
            {data.sourceFirst && data.sourceLast && (
              <span>
                · 本地源覆盖 {data.sourceFirst} ~ {data.sourceLast}
              </span>
            )}
          </p>
          {data.latest && data.requestedDate > data.latest && (
            <p className="mb-2 text-[13px] text-nc-warn" role="status">
              所选日期 {date} 晚于本地最新记录日 {data.latest}，曲线与明细截至{" "}
              {data.latest}。
            </p>
          )}
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0.5 w-4 bg-nc-up" />
              涨停{" "}
              <strong className="tabular-nums">
                {count(latest?.limitUp ?? null)}
              </strong>{" "}
              家
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="inline-block w-4 border-t-2 border-dashed border-nc-down"
              />
              跌停{" "}
              <strong className="tabular-nums">
                {count(latest?.limitDown ?? null)}
              </strong>{" "}
              家
            </span>
            <span className="text-nc-text-4">纵轴 0–{max} 家</span>
          </div>
          <TrendChart
            points={data.points}
            max={max}
            label={`${data.window!.start} 至 ${data.window!.end} 通达信本地涨停与跌停家数曲线`}
          />
          <div className="mt-1 flex justify-between text-[12px] tabular-nums text-nc-text-4">
            <span>{data.window!.start}</span>
            <span>{data.window!.end}</span>
          </div>
          {data.duplicates.length > 0 && (
            <p className="mt-2 text-[13px] text-nc-warn">
              同组同日重复 {data.duplicates.length}{" "}
              处，未挑选其中一条，对应值按缺失处理：
              {data.duplicates
                .map(
                  (item) =>
                    `${item.date} ${item.field === "limitUp" ? "涨停" : "跌停"}（${item.count} 条）`,
                )
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
                aria-label="通达信本地涨跌停逐日明细"
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
                      涨停（家）
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="py-1 text-right text-nc-text-4"
                    >
                      跌停（家）
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
                        {point.limitUp == null
                          ? upDuplicates.has(point.date)
                            ? "歧义（重复）"
                            : "缺失"
                          : displayNumber(point.limitUp, 0)}
                      </TableCell>
                      <TableCell className="py-1 text-right">
                        {point.limitDown == null
                          ? downDuplicates.has(point.date)
                            ? "歧义（重复）"
                            : "缺失"
                          : displayNumber(point.limitDown, 0)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </details>
        </>
      )}
    </Panel>
  );
}
