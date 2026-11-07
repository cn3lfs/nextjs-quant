import { History, RefreshCw } from "lucide-react";
import { jobStatusLabel } from "~/lib/backtest/ma-workspace";
import { Button } from "../ui/button";

export type BaselineHistoryEntry = {
  id: string;
  status: string;
  symbol: string;
  createdAt: number;
};
export function MaExperimentHistory({
  entries,
  selectedId,
  disabled,
  loading,
  error,
  onSelect,
  onRefresh,
}: {
  entries: BaselineHistoryEntry[];
  selectedId: string;
  disabled: boolean;
  loading: boolean;
  error?: string;
  onSelect: (id: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section
      aria-label="最近实验"
      className="min-w-0 rounded-lg border border-nc-border bg-nc-card p-4"
    >
      <header className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <History className="size-4 text-nc-accent" aria-hidden="true" />
          <h3 className="text-base font-medium">最近实验</h3>
          <span className="text-xs text-nc-text-3">显示最近 20 个</span>
        </div>
        <Button
          variant="outline"
          className="min-h-10"
          disabled={loading || disabled}
          onClick={onRefresh}
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          刷新实验
        </Button>
      </header>
      {error ? (
        <p role="alert" className="text-sm text-nc-bad">
          {error} · 可点击刷新实验重试。
        </p>
      ) : loading && !entries.length ? (
        <p role="status" className="text-sm text-nc-text-3">
          正在读取实验历史…
        </p>
      ) : !entries.length ? (
        <p className="py-4 text-sm text-nc-text-3">
          还没有回测实验。完成左侧配置后，开始第一次规则自检。
        </p>
      ) : (
        <ul className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
          {entries.map((item) => (
            <li
              key={item.id}
              className={`min-w-0 rounded-lg border p-3 ${item.id === selectedId ? "border-nc-accent bg-nc-accent-900" : "border-nc-border-soft bg-nc-inset"}`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium tabular-nums">
                  {item.symbol?.toUpperCase() ?? "未知证券"}
                </span>
                <span
                  className={`text-xs ${item.status === "failed" ? "text-nc-bad" : item.status === "completed" ? "text-nc-ok" : "text-nc-text-3"}`}
                >
                  {jobStatusLabel(item.status)}
                </span>
              </div>
              <p className="my-2 text-xs tabular-nums text-nc-text-3">
                {new Date(item.createdAt).toLocaleString("zh-CN", {
                  timeZone: "Asia/Shanghai",
                })}
              </p>
              <p
                className="mb-3 truncate text-xs text-nc-text-3"
                title={item.id}
              >
                编号 {item.id}
              </p>
              <Button
                variant="outline"
                className="min-h-10 w-full"
                disabled={disabled}
                aria-label={`恢复实验 ${item.id}`}
                aria-pressed={item.id === selectedId}
                onClick={() => onSelect(item.id)}
              >
                {item.id === selectedId ? "当前实验" : "恢复实验"}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-nc-text-3">
        历史实验不会自动清理；可删除选中的终态实验。更多任务见任务中心。
      </p>
    </section>
  );
}
