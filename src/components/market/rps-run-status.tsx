import { summarizeRpsProgress, rpsLogTime } from "~/lib/rps-log";
import type { RpsProgress } from "~/lib/rps";
import { Badge } from "../ui/badge";

const tone = {
  running: "default",
  complete: "secondary",
  failed: "destructive",
  cancelled: "outline",
} as const;

function Bar({ label, percent }: { label: string; percent: number }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span>{percent}%</span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className="h-full rounded-full bg-primary transition-[width]"
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
    <section
      aria-label="RPS运行状态"
      className="flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">当前运行状态</h3>
        <Badge variant={view ? tone[view.status] : "outline"}>
          {view ? view.statusLabel : "空闲"}
        </Badge>
      </header>
      {view && progress ? (
        <div className="space-y-3 text-sm" role="status">
          <p>
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
          <p className="text-xs text-muted-foreground">
            开始 {rpsLogTime(progress.startedAt)} · 更新{" "}
            {rpsLogTime(progress.updatedAt)}
          </p>
          {view.error && (
            <p role="alert" className="text-sm text-destructive">
              {view.error}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          尚未运行RPS任务。个股、行业、概念共用同一队列，同一时间只有一个任务在跑。
        </p>
      )}
    </section>
  );
}
