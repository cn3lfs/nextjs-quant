"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { ChartLineUp } from "@phosphor-icons/react/ssr";
import type { LimitSentimentIntraday } from "~/server/market/limit-sentiment";
import type { LimitObservation } from "~/server/market/limit-sentiment-observations";
import { Panel, PanelEmpty } from "../panels";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { splitIntradaySegments } from "./limit-intraday-series";

const WIDTH = 720;
const HEIGHT = 210;
const PAD_X = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;
const DAY_START = 9 * 60 + 30;
const DAY_END = 15 * 60;
const MORNING_END = 11 * 60 + 30;
const AFTERNOON_START = 13 * 60;

const minuteOfDay = (minute: string) => {
  const [hour, rest] = minute.split(":");
  return Number(hour) * 60 + Number(rest);
};

const xMinute = (minute: number) =>
  PAD_X +
  ((Math.min(DAY_END, Math.max(DAY_START, minute)) - DAY_START) /
    (DAY_END - DAY_START)) *
    (WIDTH - PAD_X * 2);

const xPoint = (point: LimitObservation) => xMinute(minuteOfDay(point.minute));

const yValue = (value: number, max: number) =>
  HEIGHT - PAD_BOTTOM - (value / max) * (HEIGHT - PAD_TOP - PAD_BOTTOM);

function pathFor(
  points: LimitObservation[],
  max: number,
  pick: (point: LimitObservation) => number,
) {
  if (points.length < 2) return "";
  return points
    .map(
      (point, index) =>
        `${index ? "L" : "M"}${xPoint(point).toFixed(1)} ${yValue(pick(point), max).toFixed(1)}`,
    )
    .join(" ");
}

function IntradayChart({
  points,
  max,
}: {
  points: LimitObservation[];
  max: number;
}) {
  const segments = splitIntradaySegments(points);
  const label = `${points[0]!.date} 本机盘中打板情绪：涨停、炸板、跌停家数，共 ${points.length} 个分钟点`;
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="block h-auto max-h-60 w-full"
      role="img"
      aria-label={label}
    >
      <rect
        x={xMinute(MORNING_END)}
        y={PAD_TOP}
        width={xMinute(AFTERNOON_START) - xMinute(MORNING_END)}
        height={HEIGHT - PAD_TOP - PAD_BOTTOM}
        className="text-nc-border-soft"
        fill="currentColor"
        opacity={0.45}
      />
      <line
        x1={PAD_X}
        x2={WIDTH - PAD_X}
        y1={yValue(0, max)}
        y2={yValue(0, max)}
        className="text-nc-border"
        stroke="currentColor"
        strokeWidth={1}
      />
      {[MORNING_END, AFTERNOON_START].map((minute) => (
        <line
          key={minute}
          x1={xMinute(minute)}
          x2={xMinute(minute)}
          y1={PAD_TOP}
          y2={HEIGHT - PAD_BOTTOM}
          className="text-nc-border"
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="3 4"
        />
      ))}
      {segments.map((segment, index) => (
        <g key={`${segment.session}-${segment.points[0]!.at}-${index}`}>
          <path
            d={pathFor(segment.points, max, (point) => point.limitUp)}
            fill="none"
            className="text-nc-up"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={pathFor(segment.points, max, (point) => point.broken)}
            fill="none"
            className="text-nc-warn"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <path
            d={pathFor(segment.points, max, (point) => point.limitDown)}
            fill="none"
            className="text-nc-down"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeDasharray="5 4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      ))}
      {points.map((point) => (
        <g key={`${point.date}-${point.minute}`}>
          <circle
            cx={xPoint(point)}
            cy={yValue(point.limitUp, max)}
            r={2.2}
            className="text-nc-up"
            fill="currentColor"
          />
          <circle
            cx={xPoint(point)}
            cy={yValue(point.broken, max)}
            r={2.2}
            className="text-nc-warn"
            fill="currentColor"
          />
          <circle
            cx={xPoint(point)}
            cy={yValue(point.limitDown, max)}
            r={2.2}
            className="text-nc-down"
            fill="currentColor"
          />
        </g>
      ))}
      {(
        [
          { minute: DAY_START, label: "09:30", anchor: "start" },
          { minute: MORNING_END, label: "11:30", anchor: "middle" },
          { minute: AFTERNOON_START, label: "13:00", anchor: "middle" },
          { minute: DAY_END, label: "15:00", anchor: "end" },
        ] as const
      ).map((tick) => (
        <text
          key={tick.label}
          x={xMinute(tick.minute)}
          y={HEIGHT - 6}
          textAnchor={tick.anchor}
          className="text-nc-text-4"
          fill="currentColor"
          fontSize={11}
        >
          {tick.label}
        </text>
      ))}
    </svg>
  );
}

/**
 * 打板情绪盘中观测走势。数据由现有 `limitSentiment` 响应附带，不新增请求或
 * 定时器；只展示页面实际成功刷新后积累的本机分钟点。
 */
export function LimitIntradayTrend({
  date,
  intraday,
}: {
  date: string;
  intraday: LimitSentimentIntraday;
}) {
  const points = intraday.date === date ? intraday.points : [];
  const first = points[0];
  const last = points.at(-1);
  const observed = first
    ? first.minute === last!.minute
      ? first.minute
      : `${first.minute}–${last!.minute}`
    : null;
  const max = Math.max(
    1,
    ...points.flatMap((point) => [
      point.limitUp,
      point.broken,
      point.limitDown,
    ]),
  );
  return (
    <Panel
      span={12}
      icon={ChartLineUp}
      title="盘中观测走势"
      tag="东方财富四池 · 本机分钟采样"
      note="数据：东方财富涨停板行情中心四池。仅本机页面实际成功刷新且四池全部返回时，于工作日 09:30–11:30、13:00–15:00（北京时间）按分钟采样；记录时间为四池请求完成时间，不是交易所同秒快照。单位为家；上午/下午及显著间隔断线。"
    >
      {intraday.error && (
        <p role="alert" className="mb-2 text-[13px] text-nc-bad">
          本机观测读取或保存失败：{intraday.error}；上方四池数据不受影响。
        </p>
      )}
      {points.length === 0 ? (
        <PanelEmpty>
          {intraday.error
            ? "本机观测读取失败，暂无可显示的观测点。"
            : "该日暂无本机盘中观测。只有页面实际成功刷新并拿到四池数据时才会积累，不做事后补采。"}
        </PanelEmpty>
      ) : (
        <>
          <p
            className="mb-2 flex flex-wrap gap-x-2 text-sm text-nc-text-3"
            role="status"
          >
            <span>采样窗口 09:30–11:30、13:00–15:00（北京时间）</span>
            <span>· 本日已观测 {observed}</span>
            <span>· {points.length} 个分钟点</span>
            <span>· 单位：家</span>
          </p>
          <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0.5 w-4 bg-nc-up" />
              涨停{" "}
              <strong className="tabular-nums">
                {displayNumber(last!.limitUp, 0)}
              </strong>{" "}
              家
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span aria-hidden className="inline-block h-0.5 w-4 bg-nc-warn" />
              炸板{" "}
              <strong className="tabular-nums">
                {displayNumber(last!.broken, 0)}
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
                {displayNumber(last!.limitDown, 0)}
              </strong>{" "}
              家
            </span>
            <span className="text-nc-text-4">纵轴 0–{max} 家</span>
          </div>
          <IntradayChart points={points} max={max} />
          <details className="mt-3">
            <summary className="cursor-pointer select-none text-[13px] text-nc-text-3">
              逐分钟明细（{points.length} 条，按时间升序）
            </summary>
            <div className="mt-2 max-h-72 overflow-auto">
              <Table
                className="min-w-[360px] text-[13px]"
                aria-label="本机盘中打板情绪逐分钟明细"
              >
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col" className="py-1 text-nc-text-4">
                      时间
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
                      炸板（家）
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
                  {points.map((point) => (
                    <TableRow key={`${point.date}-${point.minute}`}>
                      <TableHead
                        scope="row"
                        className="bg-transparent py-1 text-left font-normal"
                      >
                        {point.minute}
                      </TableHead>
                      <TableCell className="py-1 text-right">
                        {displayNumber(point.limitUp, 0)}
                      </TableCell>
                      <TableCell className="py-1 text-right">
                        {displayNumber(point.broken, 0)}
                      </TableCell>
                      <TableCell className="py-1 text-right">
                        {displayNumber(point.limitDown, 0)}
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
