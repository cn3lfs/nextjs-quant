"use client";
import { formatNumber } from "trading-strategy-core/format-number";
import { Thermometer } from "@phosphor-icons/react/ssr";
import { api, type RouterOutputs } from "~/trpc/react";
import { useScreenVisible } from "../workbench/use-task-visible";
import { Button } from "../ui/button";
import { Panel, Pill, StateBanner } from "../panels";
import { MarketPanelBuildAction } from "./market-panel-action";

type TemperatureData = RouterOutputs["marketTemperature"];
type TemperaturePoint = TemperatureData["history"][number];
type DimensionKey = keyof TemperaturePoint["dimensions"];

const regimeMeta = {
  offensive: { label: "进攻", tone: "ok" },
  neutral: { label: "中性", tone: "idle" },
  defensive: { label: "防守", tone: "warn" },
} as const;

const dimensions = [
  ["breadth", "市场宽度"],
  ["trend", "趋势"],
  ["limits", "连板情绪"],
  ["turnover", "成交额"],
  ["etf", "宽基 ETF 净申赎"],
] as const satisfies readonly (readonly [DimensionKey, string])[];

const CHART_WIDTH = 720;
const CHART_HEIGHT = 190;
const PAD_X = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;

/** 0–100 历史分位曲线；缺失值与中断点断开，不插值补线。 */
function TemperatureChart({ points }: { points: TemperaturePoint[] }) {
  const count = points.length;
  const x = (index: number) =>
    count <= 1
      ? CHART_WIDTH / 2
      : PAD_X + (index / (count - 1)) * (CHART_WIDTH - PAD_X * 2);
  const y = (value: number) =>
    PAD_TOP + (1 - value / 100) * (CHART_HEIGHT - PAD_TOP - PAD_BOTTOM);
  let path = "";
  let open = false;
  points.forEach((point, index) => {
    if (point.score === null) {
      open = false;
      return;
    }
    path += `${open && !point.gapBefore ? "L" : "M"}${x(index).toFixed(1)} ${y(point.score).toFixed(1)}`;
    open = true;
  });
  let lastIndex = -1;
  points.forEach((point, index) => {
    if (point.score !== null) lastIndex = index;
  });
  const last = lastIndex >= 0 ? points[lastIndex] : undefined;
  return (
    <svg
      viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
      className="block h-auto max-h-52 w-full"
      role="img"
      aria-label="0–100 市场温度历史曲线，含 35/65 滞回参考线，缺失段断开"
    >
      {[35, 65].map((line) => (
        <g key={line}>
          <line
            x1={PAD_X}
            x2={CHART_WIDTH - PAD_X}
            y1={y(line)}
            y2={y(line)}
            className="text-nc-border"
            stroke="currentColor"
            strokeWidth={1}
            strokeDasharray="4 3"
          />
          <text
            x={CHART_WIDTH - PAD_X}
            y={y(line) - 3}
            textAnchor="end"
            fontSize={10}
            className="text-nc-text-4"
            fill="currentColor"
          >
            {line}
          </text>
        </g>
      ))}
      <line
        x1={PAD_X}
        x2={CHART_WIDTH - PAD_X}
        y1={y(0)}
        y2={y(0)}
        className="text-nc-border-soft"
        stroke="currentColor"
        strokeWidth={1}
      />
      <line
        x1={PAD_X}
        x2={CHART_WIDTH - PAD_X}
        y1={y(100)}
        y2={y(100)}
        className="text-nc-border-soft"
        stroke="currentColor"
        strokeWidth={1}
      />
      {path && (
        <path
          d={path}
          fill="none"
          className="text-nc-accent"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {last?.score != null && (
        <circle
          cx={x(lastIndex)}
          cy={y(last.score)}
          r={3}
          className="text-nc-accent"
          fill="currentColor"
        />
      )}
    </svg>
  );
}

function Body({ data }: { data: TemperatureData }) {
  const latest = data.latest ?? data.history.at(-1) ?? null;
  const { weights, minimumWeight, regime: regimeRule } = data.policy;
  const regime = latest?.regime
    ? regimeMeta[latest.regime]
    : { label: "状态待确认", tone: "idle" as const };
  const warnings = data.provenance.warnings;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-2">
        <span className="inline-flex items-baseline gap-2">
          <span className="text-[13px] text-nc-text-3">当前温度</span>
          <strong className="text-[length:var(--nc-font-size-kpi)] leading-none tabular-nums text-nc-text">
            {latest?.score == null ? "—" : formatNumber(latest.score, 0)}
          </strong>
          <span className="text-[13px] text-nc-text-4">/ 100</span>
        </span>
        <Pill tone={regime.tone}>{regime.label}</Pill>
        <span className="text-[13px] text-nc-text-4">
          {latest ? `最近记录 · ${latest.date}` : "暂无温度记录"}
        </span>
        <span className="ml-auto text-[12px] text-nc-text-4" title={regimeRule}>
          进攻 ≥65 · 防守 ≤35
        </span>
      </div>
      <div className="grid gap-x-6 gap-y-1.5 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
        {dimensions.map(([key, label]) => {
          const value = latest?.dimensions[key].score ?? null;
          return (
            <div key={key} className="min-w-0">
              <div className="flex items-baseline justify-between gap-2 text-[13px]">
                <span className="text-nc-text-3">
                  {label}
                  <span className="ml-1 text-[11px] text-nc-text-4">
                    权重 {weights[key]}%
                  </span>
                </span>
                <span className="tabular-nums text-nc-text-2">
                  {value === null ? "缺失" : formatNumber(value, 1)}
                </span>
              </div>
              <div
                className="mt-1 h-1.5 overflow-hidden rounded-full bg-nc-inset"
                role="presentation"
              >
                <div
                  className="h-full rounded-full bg-nc-accent"
                  style={{
                    width: `${value === null ? 0 : Math.max(0, Math.min(100, value))}%`,
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <p className="m-0 text-[12px] text-nc-text-4">
        有效权重 {latest ? formatNumber(latest.coverageWeight, 0) : "—"}
        /100。收盘后达到 {minimumWeight} 才计算有效维度的加权平均。
      </p>
      <TemperatureChart points={data.history} />
      <div className="flex justify-between text-[12px] tabular-nums text-nc-text-4">
        <span>{data.history[0]?.date ?? "—"}</span>
        <span>{data.history.at(-1)?.date ?? "—"}</span>
      </div>
      {warnings.length > 0 && (
        <p className="m-0 text-[12px] text-nc-warn" role="status">
          {warnings.join("；")}
        </p>
      )}
    </div>
  );
}

/**
 * 0–100 历史市场温度计：只读本地冻结面板与国家队指标缓存，
 * 独立于今日工作区 30 秒轮询，未接入自动策略门控。
 */
export function MarketTemperature() {
  const visible = useScreenVisible();
  const query = api.marketTemperature.useQuery(undefined, {
    enabled: visible,
    retry: false,
    staleTime: 300_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  return (
    <Panel
      icon={Thermometer}
      title="市场温度计"
      span={5}
      meta="0–100 历史分位 · 252 日窗口"
      note="仅作展示与仓位参考，未接入自动策略门控。"
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
          title="市场温度读取失败"
          action={{
            label: "重试",
            onClick: () => void query.refetch(),
          }}
        >
          {query.error.message}
        </StateBanner>
      ) : !query.data ? (
        <p className="m-0 text-[13px] text-nc-text-3">正在读取本地温度历史…</p>
      ) : (
        <Body data={query.data} />
      )}
    </Panel>
  );
}
