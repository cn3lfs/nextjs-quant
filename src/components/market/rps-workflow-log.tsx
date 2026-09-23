import {
  rpsLogTime,
  rpsPhaseLabel,
  rpsStatusLabel,
  type RpsLogEntry,
} from "~/lib/rps-log";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";

const tone = {
  running: "default",
  complete: "secondary",
  failed: "destructive",
} as const;

/**
 * Finished and failed RPS batches, newest first, in one scrollable box. CLS
 * review batches are deliberately absent: this page only manages RPS.
 */
export function RpsWorkflowLog({
  entries,
  loading = false,
  error,
  onRetry,
}: {
  entries: RpsLogEntry[];
  loading?: boolean;
  error?: string;
  onRetry?: () => void;
}) {
  return (
    <section
      aria-label="RPS历史日志"
      className="flex h-full flex-col gap-3 rounded-lg border border-border bg-card p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h3 className="font-semibold">历史日志</h3>
        <span className="text-xs text-muted-foreground">
          自动批次记录 {entries.length} 条
        </span>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          读取失败：{error}
          {onRetry && (
            <Button variant="outline" onClick={onRetry}>
              重试
            </Button>
          )}
        </p>
      ) : null}
      <div className="max-h-64 overflow-y-auto rounded-md border border-border/60">
        {loading && !entries.length ? (
          <p role="status" className="px-3 py-6 text-center text-sm">
            读取历史日志…
          </p>
        ) : entries.length ? (
          <ul className="divide-y divide-border text-sm">
            {entries.map((entry) => (
              <li
                key={entry.id}
                role={entry.status === "failed" ? "alert" : undefined}
                className="flex flex-wrap items-center gap-2 px-3 py-2"
              >
                <span className="font-mono text-xs text-muted-foreground">
                  {rpsLogTime(entry.at)}
                </span>
                <span>
                  {entry.date} · {rpsPhaseLabel(entry.phase)}批次
                </span>
                <Badge
                  variant={tone[entry.status as keyof typeof tone] ?? "outline"}
                >
                  {rpsStatusLabel(entry.status)}
                </Badge>
                {entry.error && (
                  <span className="w-full text-xs text-destructive">
                    {entry.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p role="status" className="px-3 py-6 text-center text-sm">
            暂无RPS批次记录。手工回填不写入自动批次日志。
          </p>
        )}
      </div>
    </section>
  );
}
