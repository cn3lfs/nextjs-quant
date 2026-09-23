import { ClockCounterClockwise } from "@phosphor-icons/react/ssr";
import {
  rpsLogTime,
  rpsPhaseLabel,
  rpsStatusLabel,
  type RpsLogEntry,
} from "~/lib/rps-log";
import { Panel, Pill } from "../panels";
import { Button } from "../ui/button";

const tone = {
  running: "accent",
  complete: "ok",
  failed: "bad",
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
    <Panel
      span={6}
      aria-label="RPS历史日志"
      icon={ClockCounterClockwise}
      title="历史日志"
      meta={`自动批次记录 ${entries.length} 条`}
      className="h-full"
    >
      {error ? (
        <p role="alert" className="m-0 mb-2 text-[12px] text-nc-bad">
          读取失败：{error}
          {onRetry && (
            <Button
              size="sm"
              variant="outline"
              className="ml-2"
              onClick={onRetry}
            >
              重试
            </Button>
          )}
        </p>
      ) : null}
      <div className="max-h-64 overflow-y-auto rounded-lg border border-nc-border-soft bg-nc-inset">
        {loading && !entries.length ? (
          <p role="status" className="nc-panel-empty">
            读取历史日志…
          </p>
        ) : entries.length ? (
          <ul className="m-0 list-none divide-y divide-nc-border-soft p-0 text-[12px]">
            {entries.map((entry) => (
              <li
                key={entry.id}
                role={entry.status === "failed" ? "alert" : undefined}
                className="flex flex-wrap items-center gap-2 px-3 py-2"
              >
                <span className="text-[11px] text-nc-text-4 tabular-nums">
                  {rpsLogTime(entry.at)}
                </span>
                <span>
                  {entry.date} · {rpsPhaseLabel(entry.phase)}批次
                </span>
                <Pill tone={tone[entry.status as keyof typeof tone] ?? "idle"}>
                  {rpsStatusLabel(entry.status)}
                </Pill>
                {entry.error && (
                  <span className="w-full text-[11px] text-nc-bad">
                    {entry.error}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p role="status" className="nc-panel-empty">
            暂无RPS批次记录。手工回填不写入自动批次日志。
          </p>
        )}
      </div>
    </Panel>
  );
}
