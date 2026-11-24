import { cn } from "~/lib/common/classnames";
import { integer, num, pct, signedPct } from "./alpha-format";

type IcPoint = { date: string; value: number };

const sampleTooSmall = (
  <p className="text-xs text-nc-text-3">样本不足，图表暂不可用。</p>
);

/** Cumulative daily RankIC; a persistent sign is the signal. */
export function CumulativeRankIcChart({
  points,
}: {
  points: readonly IcPoint[];
}) {
  if (points.length < 2) return sampleTooSmall;
  let sum = 0;
  const cumulative = points.map((point) => (sum += point.value));
  const min = Math.min(0, ...cumulative);
  const max = Math.max(0, ...cumulative);
  const span = max - min || 1;
  const x = (index: number) => (index / (cumulative.length - 1)) * 300;
  const y = (value: number) => 56 - ((value - min) / span) * 52;
  return (
    <>
      <svg
        viewBox="0 0 300 60"
        className="h-20 w-full text-nc-accent"
        role="img"
        aria-label="累计 RankIC 曲线"
      >
        <line
          x1={0}
          x2={300}
          y1={y(0)}
          y2={y(0)}
          stroke="currentColor"
          opacity={0.2}
        />
        <polyline
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          points={cumulative
            .map((value, index) => `${x(index)},${y(value)}`)
            .join(" ")}
        />
      </svg>
      <p className="text-xs text-nc-text-3">
        {points[0]!.date} 至 {points.at(-1)!.date} · 累计 RankIC{" "}
        {num(cumulative.at(-1), 2)}
      </p>
    </>
  );
}

export function DailyIcChart({ points }: { points: readonly IcPoint[] }) {
  if (!points.length) return sampleTooSmall;
  const max = Math.max(...points.map((point) => Math.abs(point.value)), 1e-9);
  const width = 300 / points.length;
  const positive = points.filter((point) => point.value > 0).length;
  return (
    <>
      <svg
        viewBox="0 0 300 60"
        className="h-20 w-full"
        role="img"
        aria-label="每日 Pearson IC 柱图"
      >
        <line
          x1={0}
          x2={300}
          y1={30}
          y2={30}
          stroke="var(--nc-border)"
          strokeWidth={0.5}
        />
        {points.map((point, index) => {
          const height = (Math.abs(point.value) / max) * 28;
          return (
            <rect
              key={`${point.date}-${index}`}
              x={index * width}
              y={point.value >= 0 ? 30 - height : 30}
              width={Math.max(0.4, width - 0.2)}
              height={height}
              fill={point.value >= 0 ? "var(--nc-up)" : "var(--nc-down)"}
              opacity={0.75}
            />
          );
        })}
      </svg>
      <p className="text-xs text-nc-text-3">
        正 IC 天数占比 {pct(positive / points.length, 1)} · 共{" "}
        {integer(points.length)} 个截面
      </p>
    </>
  );
}

/** Quantile mean excess return; bar length relative to the largest absolute value. */
export function QuantileBars({
  values,
  horizon,
}: {
  values: readonly (number | null)[];
  horizon: number;
}) {
  if (!values.some((value) => value !== null)) return sampleTooSmall;
  const max = Math.max(...values.map((value) => Math.abs(value ?? 0)), 1e-12);
  return (
    <ul className="space-y-1 text-xs" aria-label={`T+${horizon} 分组超额收益`}>
      {values.map((value, index) => (
        <li key={index} className="flex items-center gap-2">
          <span className="w-8 shrink-0 text-nc-text-3">Q{index + 1}</span>
          <span className="h-2 min-w-0 flex-1 overflow-hidden rounded bg-nc-inset">
            <span
              className={cn(
                "block h-full",
                value != null && value >= 0 ? "bg-nc-up" : "bg-nc-down",
              )}
              style={{
                width: `${Math.min(100, (Math.abs(value ?? 0) / max) * 100)}%`,
              }}
            />
          </span>
          <span className="w-20 shrink-0 text-right tabular-nums">
            {signedPct(value, 3)}
          </span>
        </li>
      ))}
    </ul>
  );
}
