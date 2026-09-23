import { Gauge } from "@phosphor-icons/react/ssr";
import { summarizeRpsProgress, rpsLogTime } from "~/lib/rps-log";
import type { RpsProgress } from "~/lib/rps";
import { Panel, Pill } from "../panels";

const tone = {
  running: "accent",
  complete: "ok",
  failed: "bad",
  cancelled: "idle",
} as const;

function Bar({ label, percent }: { label: string; percent: number }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-[11px] text-nc-text-3 tabular-nums">
        <span>{label}</span>
        <span>{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="nc-bar-track block h-[5px]"
      >
        <div
          className="h-full rounded-full bg-nc-accent transition-[width]"
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  );
}

/**
 * Current run only. The RPS job is a singleton across 个股 / 行业 / 概念, so this
 * one box describes whatever is running now; finished batches belong to the log.
 */
export function RpsRunStatus({ progress }: { progress: RpsProgress | null }) {
  const view = summarizeRpsProgress(progress);
  return (
    <Panel
      span={6}
      aria-label="RPS运行状态"
      icon={Gauge}
      title="当前运行状态"
      tone={view?.status === "running" ? "accent" : "neutral"}
      className="h-full"
      actions={
        <Pill tone={view ? tone[view.status] : "idle"}>
          {view ? view.statusLabel : "空闲"}
        </Pill>
      }
    >
      {view && progress ? (
        <div className="space-y-3 text-[12px] text-nc-text-2" role="status">
          <p className="m-0">
            {view.target}任务 · {view.mode} · 阶段 {view.phase}
          </p>
          <Bar
            label={`读取 ${progress.scanned}/${progress.total}`}
            percent={view.scanPercent}
          />
          <Bar
            label={`提交 ${progress.completedDays}/${progress.totalDays} 日`}
            percent={view.dayPercent}
          />
          <p className="m-0 text-[11px] text-nc-text-4">
            开始 {rpsLogTime(progress.startedAt)} · 更新{" "}
            {rpsLogTime(progress.updatedAt)}
          </p>
          {view.error && (
            <p role="alert" className="m-0 text-[12px] text-nc-bad">
              {view.error}
            </p>
          )}
        </div>
      ) : (
        <p className="m-0 text-[12px] text-nc-text-3">
          尚未运行RPS任务。个股、行业、概念共用同一队列，同一时间只有一个任务在跑。
        </p>
      )}
    </Panel>
  );
}
