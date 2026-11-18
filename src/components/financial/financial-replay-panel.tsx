"use client";

import { useEffect, useState } from "react";
import { formatNumber } from "trading-strategy-core/format-number";
import { api } from "~/trpc/react";
import {
  financialReplayCostScenarios,
  financialReplayInput,
  financialReplayPresets,
  type FinancialReplayInput,
} from "~/lib/financial/financial-replay";
import { taskStatusLabels } from "~/lib/research/workflow/task-history";
import { readinessSummary } from "~/lib/research/research-readiness-labels";
import { activeJobPoll } from "../workbench/job-poll";
import { usePanelVisible } from "../workbench/keep-alive";
import { PortfolioResultView } from "../portfolio/portfolio-result-view";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { downloadFinancialJson } from "./financial-download";

const presetLabels = {
  "magic-formula": "魔法公式（EY + ROC 排名）",
  "f-score": "F-score（完整九项 ≥8）",
} as const;
const costLabels = {
  "zero-cost": "零成本",
  base: "基准成本",
  "double-cost": "双倍成本",
} as const;
const pageSize = 20;

function percent(value: number | null | undefined) {
  return value == null ? "—" : `${formatNumber(value * 100, 2)}%`;
}

type ReplayTask = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress: number;
  phase: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  input: FinancialReplayInput | null;
  reportId: string | null;
};

export function FinancialReplayPanel({
  symbol,
  defaultSymbols,
  initialReportId = "",
}: {
  symbol: string;
  defaultSymbols?: readonly string[];
  /** Explicit initial selection only; the app normally starts empty. */
  initialReportId?: string;
}) {
  const visible = usePanelVisible();
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const currentYear = Number(today.slice(0, 4));
  const [symbolsText, setSymbolsText] = useState(
      (defaultSymbols?.length ? defaultSymbols : [symbol]).join(" "),
    ),
    [firstYear, setFirstYear] = useState(currentYear - 4),
    [lastYear, setLastYear] = useState(currentYear - 1),
    [endDate, setEndDate] = useState(today),
    [initial, setInitial] = useState(1000000),
    [costScenario, setCostScenario] =
      useState<(typeof financialReplayCostScenarios)[number]>("base"),
    [preset, setPreset] =
      useState<(typeof financialReplayPresets)[number]>("magic-formula"),
    [jobId, setJobId] = useState(""),
    [reportId, setReportId] = useState(initialReportId),
    [selectedTaskId, setSelectedTaskId] = useState(""),
    [fillPage, setFillPage] = useState(0),
    [rejectionPage, setRejectionPage] = useState(0),
    [error, setError] = useState("");
  const utils = api.useUtils(),
    history = api.financialReplayHistory.useQuery(undefined, {
      enabled: visible,
    }),
    tasks = api.financialReplayTasks.useQuery(undefined, {
      enabled: visible,
    });
  const start = api.financialReplayStart.useMutation({
      onSuccess: (job) => {
        setError("");
        setJobId(job.id);
        setReportId("");
        setSelectedTaskId("");
        setFillPage(0);
        setRejectionPage(0);
      },
    }),
    cancel = api.cancel.useMutation();
  const job = api.job.useQuery(
    { id: jobId },
    {
      enabled: visible && !!jobId,
      refetchInterval: (query) =>
        visible ? activeJobPoll(query.state.data) : false,
    },
  );
  const busy =
    start.isPending || ["queued", "running"].includes(job.data?.status ?? "");
  useEffect(() => {
    if (job.data?.status !== "completed") return;
    const result = job.data.result as { reportId?: string } | undefined;
    if (result?.reportId) setReportId(result.reportId);
    void utils.financialReplayHistory.invalidate();
    void utils.financialReplayTasks.invalidate();
  }, [job.data?.status, job.data?.result, utils]);
  const result = api.financialReplayResult.useQuery(
    reportId || `financial-replay-${"0".repeat(64)}`,
    { enabled: visible && !!reportId, retry: false },
  );
  const activity = api.financialReplayActivity.useQuery(
    {
      id: reportId || `financial-replay-${"0".repeat(64)}`,
      fillPage,
      rejectionPage,
      pageSize,
    },
    {
      enabled: visible && !!reportId && result.data?.status === "completed",
      retry: false,
    },
  );
  const [exporting, setExporting] = useState(false);
  const resetPages = () => {
    setFillPage(0);
    setRejectionPage(0);
  };
  const run = () => {
    const parsed = financialReplayInput.safeParse({
      symbols: symbolsText.split(/[\s,，;；]+/).filter(Boolean),
      firstYear,
      lastYear,
      endDate,
      initial,
      costScenario,
      preset,
    });
    if (!parsed.success) {
      setError(parsed.error.issues.map((issue) => issue.message).join("；"));
      return;
    }
    setError("");
    start.mutate(parsed.data);
  };
  const restoreTask = (task: ReplayTask) => {
    setSelectedTaskId(task.id);
    setError("");
    resetPages();
    if (task.input) {
      setSymbolsText(task.input.symbols.join(" "));
      setFirstYear(task.input.firstYear);
      setLastYear(task.input.lastYear);
      setEndDate(task.input.endDate);
      setInitial(task.input.initial);
      setCostScenario(task.input.costScenario);
      setPreset(task.input.preset);
    }
    setJobId(["queued", "running"].includes(task.status) ? task.id : "");
    setReportId(task.reportId ?? "");
  };
  const exportReplay = () => {
    setExporting(true);
    void utils.financialReplayExport
      .fetch(reportId)
      .then((data) => {
        if (data) downloadFinancialJson(data, data.id);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "导出失败"),
      )
      .finally(() => setExporting(false));
  };
  return (
    <section
      aria-label="多年财务组合回放"
      className="space-y-4 rounded-lg border border-border p-3"
    >
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">多年财务组合回放（规则自检）</h3>
        <p className="text-xs text-muted-foreground">
          冻结当前明确A股名单，逐年使用前一完成交易日已披露财报，下一合法开盘调仓。仅规则自检：当前成分、历史ST/IPO/排队/到账日与修订版财报未认证，不构成可信策略业绩。年度缺少完整事实声明、可见年报，或所选方法没有任何完整记录时阻断；其余仅基于完整事实子集筛选，该子集无合格候选时可为全现金，不代表原始全池事实完整。
        </p>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="grid min-w-64 flex-1 gap-1 text-xs text-muted-foreground">
          冻结证券名单（sh/sz）
          <Input
            disabled={busy}
            aria-label="财务回放证券名单"
            value={symbolsText}
            onChange={(event) => setSymbolsText(event.target.value)}
            placeholder="sh600519 sz000001"
          />
        </label>
        {defaultSymbols && defaultSymbols.length > 0 && (
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setSymbolsText(defaultSymbols.join(" "))}
          >
            带入当前筛选 {defaultSymbols.length} 只
          </Button>
        )}
        <label className="grid gap-1 text-xs text-muted-foreground">
          开始年度
          <Input
            disabled={busy}
            type="number"
            aria-label="回放开始年度"
            min={1991}
            max={2100}
            value={firstYear}
            onChange={(event) => setFirstYear(Number(event.target.value))}
            className="w-28"
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          结束年度
          <Input
            disabled={busy}
            type="number"
            aria-label="回放结束年度"
            min={1991}
            max={2100}
            value={lastYear}
            onChange={(event) => setLastYear(Number(event.target.value))}
            className="w-28"
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          结束日期
          <Input
            disabled={busy}
            type="date"
            aria-label="回放结束日期"
            value={endDate}
            onChange={(event) => setEndDate(event.target.value)}
            className="w-40"
          />
        </label>
        <label className="grid gap-1 text-xs text-muted-foreground">
          初始资金
          <Input
            disabled={busy}
            type="number"
            aria-label="回放初始资金"
            min={1}
            value={initial}
            onChange={(event) => setInitial(Number(event.target.value))}
            className="w-36"
          />
        </label>
        <Select
          disabled={busy}
          value={preset}
          onValueChange={(value) => setPreset(value as typeof preset)}
        >
          <SelectTrigger aria-label="财务回放预设">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {financialReplayPresets.map((value) => (
              <SelectItem key={value} value={value}>
                {presetLabels[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          disabled={busy}
          value={costScenario}
          onValueChange={(value) =>
            setCostScenario(value as typeof costScenario)
          }
        >
          <SelectTrigger aria-label="财务回放成本情景">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {financialReplayCostScenarios.map((value) => (
              <SelectItem key={value} value={value}>
                {costLabels[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={busy} onClick={run}>
          运行多年财务回放
        </Button>
        {busy && jobId && (
          <Button variant="outline" onClick={() => cancel.mutate(jobId)}>
            取消回放
          </Button>
        )}
        <Select
          value={selectedTaskId || "none"}
          onValueChange={(value) => {
            if (value === "none") {
              setSelectedTaskId("");
              return;
            }
            const task = tasks.data?.find((item) => item.id === value);
            if (task) restoreTask(task as ReplayTask);
          }}
        >
          <SelectTrigger aria-label="财务回放任务">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">选择任务（刷新后仍可恢复）</SelectItem>
            {tasks.data?.map((task) => (
              <SelectItem key={task.id} value={task.id}>
                {new Date(task.createdAt).toLocaleString("zh-CN")} ·{" "}
                {taskStatusLabels[task.status]} · {task.progress}%
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={reportId || "none"}
          onValueChange={(value) => {
            setSelectedTaskId("");
            setReportId(value === "none" ? "" : value);
            resetPages();
          }}
        >
          <SelectTrigger aria-label="财务回放历史">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">选择历史回放结果</SelectItem>
            {history.data?.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {new Date(item.createdAt).toLocaleString("zh-CN")} ·{" "}
                {item.status === "completed" ? "完成" : "阻断"} ·{" "}
                {item.symbolCount}只 · {item.firstYear}–{item.lastYear}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {reportId && result.data && (
          <Button variant="outline" disabled={exporting} onClick={exportReplay}>
            导出完整冻结回放
          </Button>
        )}
      </div>
      {selectedTaskId && (
        <p className="text-xs text-muted-foreground">
          已恢复该任务的冻结输入；点击“运行多年财务回放”才会重新执行，不会静默自动启动。
        </p>
      )}
      {job.data && (
        <p role="status" className="text-xs">
          {job.data.phase} {job.data.progress}% {job.data.error}
        </p>
      )}
      {(error ||
        start.error ||
        cancel.error ||
        result.error ||
        history.error ||
        tasks.error ||
        job.error ||
        activity.error) && (
        <p role="alert">
          {error ||
            start.error?.message ||
            cancel.error?.message ||
            result.error?.message ||
            history.error?.message ||
            tasks.error?.message ||
            job.error?.message ||
            activity.error?.message}
        </p>
      )}
      {reportId && result.data && (
        <div className="space-y-3 text-sm">
          <p>
            状态：
            {result.data.status === "completed"
              ? "规则自检完成（非可信业绩）"
              : "证据不足，已阻断"}
          </p>
          <p className="text-xs text-muted-foreground">
            {result.data.boundary}
          </p>
          {result.data.blockedReason && (
            <p role="status" className="text-sm">
              {result.data.blockedReason}
            </p>
          )}
          {result.data.warnings.length > 0 && (
            <details className="text-xs">
              <summary className="cursor-pointer">
                来源与覆盖警告 {result.data.warnings.length} 条
              </summary>
              <ul className="list-inside list-disc">
                {result.data.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </details>
          )}
          <div className="space-y-1">
            <h4 className="text-xs font-medium">年度目标与证据</h4>
            <ul className="space-y-1 text-xs">
              {result.data.years.map((year) => (
                <li key={year.year}>
                  {year.year}：信号 {year.asOf} → 执行 {year.executeAt} ·{" "}
                  {year.status === "ready" ? "可执行" : "阻断"} · 候选{" "}
                  {year.positions} · 现金 {percent(year.cashWeight)} ·{" "}
                  {year.complete
                    ? `完整事实 F-score ${year.complete.fScore}/${year.counts.total} · 魔法 ${year.complete.magic}/${year.counts.total}`
                    : "完整事实未声明"}
                  {year.reason ? ` · ${year.reason}` : ""}
                </li>
              ))}
            </ul>
          </div>
          {result.data.readinessByInstrument.length > 0 && (
            <div className="space-y-1 text-xs">
              <h4 className="text-sm font-medium">逐标的研究就绪</h4>
              <p className="text-muted-foreground">
                {(() => {
                  const counts = new Map<string, number>();
                  for (const item of result.data.readinessByInstrument) {
                    const label = readinessSummary(
                      item.readiness,
                    ).dataQualification;
                    counts.set(label, (counts.get(label) ?? 0) + 1);
                  }
                  return [...counts]
                    .map(([label, count]) => `${label} ${count}只`)
                    .join(" · ");
                })()}
              </p>
              <details>
                <summary className="cursor-pointer">
                  展开 {result.data.readinessByInstrument.length}{" "}
                  只标的的规则与数据依据
                </summary>
                <ul className="mt-1 space-y-1">
                  {result.data.readinessByInstrument.map((item) => {
                    const labels = readinessSummary(item.readiness);
                    return (
                      <li key={item.symbol}>
                        {item.symbol} · 工程 {labels.engineering} · 规则{" "}
                        {labels.ruleCheck} · 数据 {labels.dataQualification} ·
                        独立验证 {labels.independentValidation} · 前向{" "}
                        {labels.forwardObservation}
                        {item.readiness.dataQualification.reasons.length > 0
                          ? ` · ${item.readiness.dataQualification.reasons.join("；")}`
                          : ""}
                      </li>
                    );
                  })}
                </ul>
              </details>
              <p className="text-muted-foreground">
                数据资格受限：当前成分与当前下载修订版财报；未认证首次披露版本或历史时点成分。
              </p>
            </div>
          )}
          <details className="text-xs">
            <summary className="cursor-pointer">冻结身份与运行诊断</summary>
            <p className="break-all">
              结果身份 {result.data.identity} · 年度身份{" "}
              {result.data.annualIdentity} · 内容哈希 {result.data.hash}
            </p>
            <p className="break-all">
              日历 {result.data.config.calendarHash} · 证券池{" "}
              {result.data.config.poolHash} · 研究代码{" "}
              {result.data.config.researchCodeHash} · 财务源{" "}
              {result.data.config.financialSourceHash}
            </p>
            <p>
              实际年度计算 {result.data.diagnostics.actualCalls} · 恢复检查点{" "}
              {result.data.diagnostics.restoredCheckpoints} · 完成时间{" "}
              {new Date(result.data.diagnostics.checkedAt).toLocaleString(
                "zh-CN",
              )}
            </p>
          </details>
          {result.data.status === "completed" && activity.data && (
            <PortfolioResultView
              equity={activity.data.equity}
              initial={activity.data.initial}
              summary={activity.data.summary}
              fills={activity.data.fills}
              rejections={activity.data.rejections}
              fillPage={fillPage}
              rejectionPage={rejectionPage}
              pageSize={pageSize}
              onFillPage={setFillPage}
              onRejectionPage={setRejectionPage}
            />
          )}
        </div>
      )}
    </section>
  );
}
