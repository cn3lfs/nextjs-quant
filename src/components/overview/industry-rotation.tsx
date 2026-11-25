"use client";
import { formatNumber } from "trading-strategy-core/format-number";
import { ChartScatter } from "@phosphor-icons/react/ssr";
import Link from "next/link";
import { useState } from "react";
import { cn } from "~/lib/common/classnames";
import { api, type RouterOutputs } from "~/trpc/react";
import { chartSymbolHref } from "~/lib/chart/chart-symbol";
import { useScreenVisible } from "../workbench/use-task-visible";
import { Button } from "../ui/button";
import { Panel, Pill, StateBanner, signedPercent } from "../panels";
import { BrowseSource, useOpenChart } from "../market/open-chart";
import { MarketPanelBuildAction } from "./market-panel-action";

type RotationData = RouterOutputs["industryRotationRrg"];
type RotationRow = RotationData["rows"][number];
type TrailPoint = RotationRow["trail"][number];

const quadrantMeta = {
  leading: { label: "领先", tone: "ok", text: "text-nc-ok" },
  weakening: { label: "走弱", tone: "warn", text: "text-nc-warn" },
  lagging: { label: "落后", tone: "bad", text: "text-nc-bad" },
  improving: { label: "改善", tone: "accent", text: "text-nc-accent" },
} as const;
const quadrants = ["leading", "weakening", "lagging", "improving"] as const;

const WIDTH = 640;
const HEIGHT = 440;
const PAD = 44;

function validPoint(point: TrailPoint): point is TrailPoint & {
  x: number;
  y: number;
} {
  return point.x !== null && point.y !== null;
}

function QuadrantChart({
  rows,
  selected,
  onSelect,
}: {
  rows: RotationRow[];
  selected: string | null;
  onSelect: (code: string) => void;
}) {
  const values = rows.flatMap((row) =>
    row.trail.flatMap((point) => [point.x, point.y]),
  );
  const magnitudes = values.filter((value): value is number => value !== null);
  const span = Math.max(2, ...magnitudes.map((value) => Math.abs(value - 100)));
  const cx = WIDTH / 2;
  const cy = HEIGHT / 2;
  const unit = Math.min(cx - PAD, cy - PAD) / span;
  const px = (value: number) => cx + (value - 100) * unit;
  const py = (value: number) => cy - (value - 100) * unit;
  return (
    <svg
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="block h-auto max-h-[26rem] w-full"
      role="img"
      aria-label="30 个一级行业相对沪深300的 RRG 四象限，近 8 周轨迹与当前节点"
    >
      <rect
        x={PAD / 2}
        y={PAD / 2}
        width={WIDTH - PAD}
        height={HEIGHT - PAD}
        className="text-nc-border-soft"
        fill="none"
        stroke="currentColor"
      />
      <line
        x1={cx}
        x2={cx}
        y1={PAD / 2}
        y2={HEIGHT - PAD / 2}
        className="text-nc-border"
        stroke="currentColor"
        strokeWidth={1}
      />
      <line
        x1={PAD / 2}
        x2={WIDTH - PAD / 2}
        y1={cy}
        y2={cy}
        className="text-nc-border"
        stroke="currentColor"
        strokeWidth={1}
      />
      <text
        x={WIDTH - PAD / 2 - 6}
        y={PAD / 2 + 14}
        textAnchor="end"
        fontSize={12}
        className="text-nc-ok"
        fill="currentColor"
      >
        领先 Leading
      </text>
      <text
        x={WIDTH - PAD / 2 - 6}
        y={HEIGHT - PAD / 2 - 6}
        textAnchor="end"
        fontSize={12}
        className="text-nc-warn"
        fill="currentColor"
      >
        走弱 Weakening
      </text>
      <text
        x={PAD / 2 + 6}
        y={PAD / 2 + 14}
        fontSize={12}
        className="text-nc-accent"
        fill="currentColor"
      >
        改善 Improving
      </text>
      <text
        x={PAD / 2 + 6}
        y={HEIGHT - PAD / 2 - 6}
        fontSize={12}
        className="text-nc-bad"
        fill="currentColor"
      >
        落后 Lagging
      </text>
      <text
        x={cx + 6}
        y={cy - 6}
        fontSize={11}
        fill="currentColor"
        className="text-nc-text-4"
      >
        (100, 100)
      </text>
      <text
        x={WIDTH - PAD / 2}
        y={HEIGHT - 5}
        textAnchor="end"
        fontSize={12}
        fill="currentColor"
        className="text-nc-text-4"
      >
        X · 相对强度
      </text>
      <text
        x={PAD / 2}
        y={16}
        fontSize={12}
        fill="currentColor"
        className="text-nc-text-4"
      >
        Y · 相对动量
      </text>
      {rows.map((row) => {
        let path = "";
        let open = false;
        row.trail.forEach((point) => {
          if (!validPoint(point)) {
            open = false;
            return;
          }
          path += `${open ? "L" : "M"}${px(point.x).toFixed(1)} ${py(point.y).toFixed(1)}`;
          open = true;
        });
        const active = selected === row.code;
        return (
          <path
            key={row.code}
            d={path}
            fill="none"
            className={active ? "text-nc-accent" : "text-nc-text-5"}
            stroke="currentColor"
            strokeWidth={active ? 2 : 1}
            strokeOpacity={active ? 1 : 0.35}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        );
      })}
      {[
        ...rows.filter((row) => row.code !== selected),
        ...rows.filter((row) => row.code === selected),
      ].map((row) => {
        const end = [...row.trail].reverse().find(validPoint);
        const active = selected === row.code;
        return (
          <g key={row.code}>
            {end && (
              <circle
                cx={px(end.x)}
                cy={py(end.y)}
                r={active ? 6 : 4}
                className={cn(
                  "cursor-pointer",
                  end.quadrant
                    ? quadrantMeta[end.quadrant].text
                    : "text-nc-text-4",
                )}
                fill="currentColor"
                stroke={active ? "currentColor" : "none"}
                strokeWidth={active ? 2 : 0}
                onClick={() => onSelect(row.code)}
              >
                <title>
                  {row.name} · {end.weekEnd} ·{" "}
                  {end.quadrant ? quadrantMeta[end.quadrant].label : "待定"}
                </title>
              </circle>
            )}
            {active && end && (
              <text
                x={px(end.x) + (end.x > 100 ? -8 : 8)}
                y={py(end.y) - 8}
                textAnchor={end.x > 100 ? "end" : "start"}
                pointerEvents="none"
                fontSize={11}
                className="text-nc-text"
                fill="currentColor"
              >
                {row.name}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function LeaderLink({ symbol, label }: { symbol: string; label: string }) {
  const openChart = useOpenChart();
  return (
    <Link
      className="underline"
      href={chartSymbolHref(symbol)}
      title={`查看 ${label} 的K线`}
      prefetch={false}
      scroll={false}
      onNavigate={
        openChart
          ? (event) => {
              event.preventDefault();
              openChart(symbol);
            }
          : undefined
      }
    >
      {label}
    </Link>
  );
}

function Drilldown({ row }: { row: RotationRow }) {
  const start = row.trail[0]?.relativeClose;
  const end = row.latest?.relativeClose;
  const rsChange =
    row.trail.length === 8 && start != null && end != null
      ? (end / start - 1) * 100
      : null;
  return (
    <div className="space-y-2 rounded-lg border border-nc-border-soft bg-nc-inset p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <strong className="text-[15px] text-nc-text">{row.name}</strong>
        <span className="text-[12px] text-nc-text-4">
          {row.code} · {row.symbol}
        </span>
        {row.latest?.quadrant && (
          <Pill tone={quadrantMeta[row.latest.quadrant].tone}>
            {quadrantMeta[row.latest.quadrant].label}
          </Pill>
        )}
        <Link className="ml-auto text-[13px] underline" href="/scan?tab=rps">
          行业 RPS 排名 →
        </Link>
        <Link className="text-[13px] underline" href="/scan?tab=valuation">
          板块估值 →
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {(["5", "20", "60", "120"] as const).map((period) => (
          <div key={period}>
            <span className="block text-[11px] text-nc-text-4">
              RPS{period}
            </span>
            <strong className="tabular-nums text-nc-text">
              {formatNumber(row.rps[period]?.rps, 0)}
            </strong>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[13px]">
        <span className="text-nc-text-3">近 8 周相对强弱变化</span>
        <strong
          className={cn(
            "tabular-nums",
            rsChange === null
              ? "text-nc-text-4"
              : rsChange >= 0
                ? "text-nc-up"
                : "text-nc-down",
          )}
        >
          {rsChange === null ? "首尾周数据不足" : signedPercent(rsChange, 2)}
        </strong>
        <span className="text-[12px] text-nc-text-4">
          RS=100×行业周收盘/沪深300周收盘
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px] text-[12px] tabular-nums">
          <thead>
            <tr className="text-left text-nc-text-4">
              <th className="py-1 font-normal">周结束</th>
              <th className="py-1 text-right font-normal">RS</th>
              <th className="py-1 text-right font-normal">X</th>
              <th className="py-1 text-right font-normal">Y</th>
              <th className="py-1 text-right font-normal">象限</th>
            </tr>
          </thead>
          <tbody>
            {[...row.trail].reverse().map((point) => (
              <tr
                key={point.weekEnd}
                className="border-t border-nc-border-soft"
              >
                <td className="py-1 text-nc-text-3">{point.weekEnd}</td>
                <td className="py-1 text-right">
                  {formatNumber(point.relativeClose, 2)}
                </td>
                <td className="py-1 text-right">{formatNumber(point.x, 2)}</td>
                <td className="py-1 text-right">{formatNumber(point.y, 2)}</td>
                <td className="py-1 text-right text-nc-text-3">
                  {point.quadrant ? quadrantMeta[point.quadrant].label : "缺周"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {row.leaders && row.leaders.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px]">
          <span className="text-nc-text-3">行业成员 20 日 RPS 前 5</span>
          <BrowseSource
            label={`行业 · ${row.name}`}
            symbols={row.leaders.map((leader) => leader.symbol)}
          >
            {row.leaders.map((leader) => (
              <LeaderLink
                key={leader.symbol}
                symbol={leader.symbol}
                label={`${leader.symbol}（${formatNumber(leader.rps, 0)}）`}
              />
            ))}
          </BrowseSource>
        </div>
      )}
      {!row.leaders && (
        <p className="m-0 text-[12px] text-nc-text-4">
          行业成分未读取或成分核验日不是今日，暂不展示成员下钻。
        </p>
      )}
    </div>
  );
}

function Body({ data }: { data: RotationData }) {
  const [selected, setSelected] = useState<string | null>(null);
  const row = data.rows.find((item) => item.code === selected) ?? null;
  const counts = quadrants.map((quadrant) => ({
    quadrant,
    count: data.rows.filter((item) => item.latest?.quadrant === quadrant)
      .length,
  }));
  const withTrail = data.rows.filter((item) =>
    item.trail.some(validPoint),
  ).length;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px]">
        {counts.map(({ quadrant, count }) => (
          <span key={quadrant} className="inline-flex items-center gap-1.5">
            <i
              aria-hidden="true"
              className={cn(
                "inline-block h-2 w-2 rounded-full bg-current",
                quadrantMeta[quadrant].text,
              )}
            />
            <span className="text-nc-text-3">
              {quadrantMeta[quadrant].label}
            </span>
            <strong className="tabular-nums text-nc-text-2">{count}</strong>
          </span>
        ))}
        <span className="ml-auto text-[12px] text-nc-text-4">
          RRG 周线截至 {data.weeks.at(-1)?.end ?? "—"} · RPS 截面{" "}
          {data.rpsDate ?? "—"}
        </span>
      </div>
      {withTrail === 0 ? (
        <StateBanner state="empty" title="尚无可用行业周线">
          本地行业指数与沪深300日线不足，无法形成 RRG 轨迹。
        </StateBanner>
      ) : (
        <QuadrantChart
          rows={data.rows}
          selected={selected}
          onSelect={(code) =>
            setSelected((current) => (current === code ? null : code))
          }
        />
      )}
      <div
        role="group"
        aria-label="行业选择"
        className="flex max-h-24 flex-wrap gap-1 overflow-y-auto"
      >
        {data.rows.map((item) => {
          const active = selected === item.code;
          return (
            <Button
              key={item.code}
              type="button"
              variant="plain"
              size="sm"
              aria-pressed={active}
              title={`${item.name} · ${
                item.latest?.quadrant
                  ? quadrantMeta[item.latest.quadrant].label
                  : "缺周"
              }`}
              onClick={() =>
                setSelected((current) =>
                  current === item.code ? null : item.code,
                )
              }
              className={cn(
                "h-auto rounded-full border px-2 py-0.5 text-xs",
                active
                  ? "border-nc-accent bg-nc-card font-medium text-nc-text"
                  : "border-nc-border-soft text-nc-text-3 hover:bg-nc-card",
              )}
            >
              {item.name}
            </Button>
          );
        })}
      </div>
      {row ? (
        <Drilldown row={row} />
      ) : (
        <p className="m-0 text-[12px] text-nc-text-4">
          点击象限节点或上方行业标签，展开多周期 RPS、近 8
          周相对强弱与成员下钻。
        </p>
      )}
      {data.provenance.warnings.length > 0 && (
        <p className="m-0 text-[12px] text-nc-warn" role="status">
          {data.provenance.warnings.join("；")}
        </p>
      )}
    </div>
  );
}

/**
 * 30 个一级行业相对沪深300的周线 RRG；只读本地行业指数日线与冻结面板截面 RPS，
 * 独立于今日工作区轮询。
 */
export function IndustryRotation() {
  const visible = useScreenVisible();
  const query = api.industryRotationRrg.useQuery(undefined, {
    enabled: visible,
    retry: false,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <Panel
      icon={ChartScatter}
      title="30 行业相对轮动"
      span={7}
      meta="RRG 四象限 · 周线 · 近 8 周轨迹"
      note="X/Y 以 100 为基准归一化。缺周断线，节点日期以最后有效周为准。"
      actions={
        <>
          <MarketPanelBuildAction
            hasPanel={query.data?.provenance.snapshotId != null}
            visible={visible && !query.isPending}
          />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!visible || query.isFetching}
            onClick={() => void query.refetch()}
          >
            {query.isFetching ? "读取中…" : "重读"}
          </Button>
        </>
      }
    >
      {query.isError ? (
        <StateBanner
          state="error"
          title="行业轮动读取失败"
          action={{
            label: "重试",
            onClick: () => void query.refetch(),
          }}
        >
          {query.error.message}
        </StateBanner>
      ) : !query.data ? (
        <p className="m-0 text-[13px] text-nc-text-3">
          正在读取行业指数与 RPS 截面…
        </p>
      ) : (
        <Body data={query.data} />
      )}
    </Panel>
  );
}
