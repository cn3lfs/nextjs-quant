import { FlaskConical, FolderSearch, Play, Square } from "lucide-react";
import { costFields, type MaDraft } from "~/lib/backtest/ma-workspace";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export type BaselineCoverage = {
  symbol: string;
  start: string;
  end: string;
  bars: number;
};
export function MaExperimentConfig({
  draft,
  onChange,
  reading,
  running,
  coverage,
  coverageError,
  validationError,
  onReadCoverage,
  onRun,
  onCancel,
  cancelling,
  startDisabled = false,
}: {
  draft: MaDraft;
  onChange: (draft: MaDraft) => void;
  reading: boolean;
  running: boolean;
  coverage: BaselineCoverage | null;
  coverageError: string;
  validationError: string | null;
  onReadCoverage: () => void;
  onRun: () => void;
  onCancel: () => void;
  cancelling: boolean;
  startDisabled?: boolean;
}) {
  const locked = reading || running;
  return (
    <section
      className="min-w-0 rounded-lg border border-nc-border bg-nc-card p-4"
      aria-label="实验配置"
    >
      <header className="mb-4 flex items-center gap-2">
        <FlaskConical className="size-4 text-nc-accent" aria-hidden="true" />
        <h3 className="text-base font-medium">实验配置</h3>
      </header>
      <div className="mb-4 space-y-2 rounded-lg border border-nc-border bg-nc-inset p-3 text-sm">
        <p className="font-medium text-nc-accent-light">双均线 SMA 5 / 20</p>
        <p className="text-nc-text-2">
          金叉买入，死叉退出。收盘确认，下一根开盘尝试成交。
        </p>
        <p className="text-xs text-nc-text-3">
          5分钟 · 主板单标的 · 100股整手 · T+1
        </p>
      </div>
      <div className="space-y-4">
        <label className="grid gap-2 text-sm">
          证券代码
          <Input
            aria-label="基线证券代码"
            value={draft.symbol}
            disabled={locked}
            autoComplete="off"
            placeholder="sz000001"
            onChange={(e) =>
              onChange({
                ...draft,
                symbol: e.target.value.trim().toLowerCase(),
              })
            }
          />
        </label>
        <Button
          variant="outline"
          className="min-h-10 w-full"
          onClick={onReadCoverage}
          disabled={locked || !/^(sh60|sz00)\d{4}$/.test(draft.symbol)}
        >
          <FolderSearch className="size-4" aria-hidden="true" />
          {reading ? "正在读取覆盖…" : "读取本地覆盖"}
        </Button>
        {coverage && (
          <div
            role="status"
            className="rounded-lg border border-nc-ok-edge p-3 text-xs leading-relaxed text-nc-text-2"
          >
            <p className="font-medium text-nc-ok">
              {coverage.symbol.toUpperCase()} · 本地数据可读取
            </p>
            <p className="mt-1 tabular-nums">
              {coverage.start} 至 {coverage.end}
            </p>
            <p>
              共 {coverage.bars.toLocaleString("zh-CN")} 根 · 默认选末尾约一个月
            </p>
          </div>
        )}
        {coverageError && (
          <p role="alert" className="break-words text-sm text-nc-bad">
            {coverageError}
          </p>
        )}
        <div className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
          <label className="grid min-w-0 gap-2 text-sm">
            开始日期
            <Input
              className="min-w-0 w-full"
              type="date"
              aria-label="基线开始日期"
              value={draft.start}
              disabled={locked}
              onChange={(e) => onChange({ ...draft, start: e.target.value })}
            />
          </label>
          <label className="grid min-w-0 gap-2 text-sm">
            结束日期
            <Input
              className="min-w-0 w-full"
              type="date"
              aria-label="基线结束日期"
              value={draft.end}
              disabled={locked}
              onChange={(e) => onChange({ ...draft, end: e.target.value })}
            />
          </label>
        </div>
        <label className="grid gap-2 text-sm">
          初始资金（元）
          <Input
            type="number"
            min={1000}
            max={1e9}
            aria-label="基线初始资金"
            value={draft.initial}
            disabled={locked}
            onChange={(e) => onChange({ ...draft, initial: e.target.value })}
          />
        </label>
        <details className="rounded-lg border border-nc-border p-3">
          <summary className="min-h-6 cursor-pointer text-sm text-nc-text-2">
            费用与滑点
          </summary>
          <p className="mt-2 text-xs text-nc-text-3">
            固定实验参数，不代表历史实际费率。1 万分之 = 0.01%。
          </p>
          <div className="mt-3 grid gap-3">
            {costFields.map(([key, label]) => (
              <label key={key} className="grid gap-1 text-xs">
                {label}
                <Input
                  aria-label={`基线${label}`}
                  type="number"
                  min={0}
                  step="0.1"
                  value={draft.costs[key]}
                  disabled={locked}
                  onChange={(e) =>
                    onChange({
                      ...draft,
                      costs: { ...draft.costs, [key]: e.target.value },
                    })
                  }
                />
              </label>
            ))}
          </div>
        </details>
        <p className="text-xs leading-relaxed text-nc-text-3">
          本地覆盖不代表完整性已通过。开始后将核对时段、预热、交易日历和已知公司行动。
        </p>
        {validationError && !running && (
          <p id="ma-validation" className="text-xs text-nc-warn">
            {validationError}
          </p>
        )}
        <Button
          className="min-h-10 w-full"
          disabled={locked || startDisabled || !!validationError}
          aria-describedby={validationError ? "ma-validation" : undefined}
          onClick={onRun}
        >
          <Play className="size-4" aria-hidden="true" />
          {running ? "实验运行中" : "开始回测"}
        </Button>
        {running && (
          <Button
            variant="outline"
            className="min-h-10 w-full"
            disabled={cancelling}
            onClick={onCancel}
          >
            <Square className="size-4" aria-hidden="true" />
            {cancelling ? "正在取消…" : "取消任务"}
          </Button>
        )}
      </div>
    </section>
  );
}
