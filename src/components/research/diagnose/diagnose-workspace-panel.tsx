"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "~/trpc/react";
import {
  DIAGNOSE_SCENARIO_PRESETS,
  labDiagnoseRunInputSchema,
  type DiagnoseArchiveSummary,
  type DiagnoseScenarioId,
} from "~/lib/research/diagnose-contract";
import { taskHistoryHref } from "~/lib/research/workflow/task-history-location";
import { usePanelVisible } from "../../workbench/keep-alive";
import { DiagnosticTaskIndicator } from "../../workbench/task-evidence";
import { Pill } from "../../panels";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../ui/tabs";
import { DiagnoseComparePanel } from "./diagnose-compare-panel";
import { DiagnoseDetailView, DiagnosePagination } from "./diagnose-detail-view";
import { boundaryLabels, formatCount } from "./format";

const sourceOptions = [
  { value: "all", label: "全部来源" },
  { value: "lab-archive", label: "Lab 诊断运行" },
  { value: "cli-report", label: "CLI 诊断报告" },
] as const;
type SourceFilter = (typeof sourceOptions)[number]["value"];

const scenarioOptions = Object.values(DIAGNOSE_SCENARIO_PRESETS);
const archivePageSize = 10;

const costScenarioOptions = [
  { value: "fixed", label: "fixed · 固定费率" },
  { value: "base", label: "base · 历史印花税" },
  { value: "double-cost", label: "double-cost · 双倍成本" },
] as const;
type CostScenario = (typeof costScenarioOptions)[number]["value"];

const runModeOptions = [
  { value: "per-symbol", label: "单策略诊断（逐标的）" },
  { value: "portfolio", label: "单策略组合诊断" },
  { value: "core-4", label: "四策略核心组合 (core-4)" },
] as const;
type RunMode = (typeof runModeOptions)[number]["value"];

const symbolPattern = /^(sh|sz|bj)\d{6}$/;
const splitSymbols = (value: string) =>
  value
    .split(/[\s,，、]+/)
    .map((item) => item.trim())
    .filter(Boolean);

function ArchiveRow({
  archive,
  selected,
  onSelect,
  compareChecked,
  compareDisabled,
  onToggleCompare,
}: {
  archive: DiagnoseArchiveSummary;
  selected: boolean;
  onSelect: () => void;
  compareChecked: boolean;
  compareDisabled: boolean;
  onToggleCompare: (next: boolean) => void;
}) {
  const boundary = archive.missingFiles.length
    ? "missing-files"
    : archive.statusCounts.blocked ||
        archive.statusCounts.failed ||
        !archive.statusCounts.ok
      ? "blocked"
      : archive.statusCounts.ok > 0 &&
          archive.statusCounts.ok === archive.statusCounts.zeroSignal
        ? "zero-signal"
        : "ok";
  return (
    <li
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 ${
        selected
          ? "border-nc-accent bg-nc-inset"
          : "border-nc-border-soft bg-nc-card"
      }`}
    >
      <Checkbox
        data-testid={`diagnose-compare-toggle-${archive.id}`}
        aria-label={`勾选归档 ${archive.title} 用于并排对比`}
        className="mt-1"
        checked={compareChecked}
        disabled={compareDisabled}
        onCheckedChange={(value) => onToggleCompare(value === true)}
      />
      <Button
        type="button"
        variant="plain"
        aria-pressed={selected}
        onClick={onSelect}
        className="w-full flex-col items-start gap-1 text-left"
      >
        <span className="flex w-full flex-wrap items-baseline gap-2">
          <span className="text-sm font-medium text-nc-text">
            {archive.title}
          </span>
          <Pill
            tone={
              boundary === "ok"
                ? "ok"
                : boundary === "zero-signal"
                  ? "warn"
                  : "bad"
            }
          >
            {boundaryLabels[boundary]}
          </Pill>
          <Pill tone="neutral">
            {archive.source === "cli-report" ? "CLI" : "Lab"}
          </Pill>
          <span className="text-sub text-nc-text-3">{archive.generatedAt}</span>
        </span>
        <span className="text-sub text-nc-text-3">
          {archive.strategyKeys.join("、") || "—"} ·{" "}
          {archive.symbols.join("、") || "—"} · 正常{" "}
          {formatCount(archive.statusCounts.ok)} · 零信号{" "}
          {formatCount(archive.statusCounts.zeroSignal)}
          {archive.driftWarnings.length
            ? ` · 漂移 ${archive.driftWarnings.length}`
            : ""}
          {archive.missingFiles.length
            ? ` · 缺文件 ${archive.missingFiles.length}`
            : ""}
        </span>
      </Button>
    </li>
  );
}

type ArchiveFilters = {
  source: SourceFilter;
  strategyKey: string;
  symbol: string;
};
const initialFilters: ArchiveFilters = {
  source: "all",
  strategyKey: "",
  symbol: "",
};

type ArchiveRequest = { id: string };

function ArchiveBrowser({
  active,
  archiveRequest,
}: {
  active: boolean;
  archiveRequest: ArchiveRequest | null;
}) {
  const visible = usePanelVisible();
  const [draft, setDraft] = useState<ArchiveFilters>(initialFilters);
  // Applied explicitly: reading archives touches the filesystem on every key.
  const [applied, setApplied] = useState<ArchiveFilters>(initialFilters);
  const [selectedId, setSelectedId] = useState<string | null>(
    archiveRequest?.id ?? null,
  );
  const [page, setPage] = useState(1);
  const [listPage, setListPage] = useState(1);
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  const [appliedArchive, setAppliedArchive] = useState(archiveRequest);
  const detailRef = useRef<HTMLDivElement>(null);
  const focusedArchive = useRef<ArchiveRequest | null>(null);
  if (archiveRequest !== appliedArchive) {
    setAppliedArchive(archiveRequest);
    if (archiveRequest) {
      setSelectedId(archiveRequest.id);
      setPage(1);
      setCompareOpen(false);
    }
  }
  const symbolInput = applied.symbol.trim();
  const validSymbol = symbolPattern.test(symbolInput) ? symbolInput : undefined;
  const dirty =
    draft.source !== applied.source ||
    draft.strategyKey !== applied.strategyKey ||
    draft.symbol !== applied.symbol;
  const filtered =
    applied.source !== "all" ||
    applied.strategyKey.trim() !== "" ||
    applied.symbol.trim() !== "";
  const archives = api.strategyLabDiagnoseArchives.useQuery(
    {
      page: listPage,
      pageSize: archivePageSize,
      ...(applied.source === "all" ? {} : { source: applied.source }),
      ...(applied.strategyKey.trim()
        ? { strategyKey: applied.strategyKey.trim() }
        : {}),
      ...(validSymbol ? { symbol: validSymbol } : {}),
    },
    { enabled: visible && active },
  );
  const detail = api.strategyLabDiagnoseArchiveDetail.useQuery(
    { id: selectedId ?? "", page, pageSize: 10 },
    { enabled: visible && active && selectedId !== null },
  );
  const comparison = api.strategyLabDiagnoseCompare.useQuery(
    {
      leftId: compareIds[0] ?? "",
      rightId: compareIds[1] ?? "",
    },
    {
      enabled: visible && active && compareOpen && compareIds.length === 2,
    },
  );
  useEffect(() => {
    if (!archiveRequest || !visible || !active || detail.isPending) return;
    if (focusedArchive.current === archiveRequest || !detailRef.current) return;
    focusedArchive.current = archiveRequest;
    detailRef.current.focus({ preventScroll: true });
    detailRef.current.scrollIntoView({ block: "nearest" });
  }, [archiveRequest, visible, active, detail.isPending]);
  const setField = <K extends keyof ArchiveFilters>(
    key: K,
    value: ArchiveFilters[K],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const toggleCompare = (id: string, next: boolean) => {
    setCompareOpen(false);
    setCompareIds((current) => {
      if (!next) return current.filter((value) => value !== id);
      if (current.includes(id) || current.length >= 2) return current;
      return [...current, id];
    });
  };
  return (
    <div className="space-y-3">
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(draft);
          setListPage(1);
          setSelectedId(null);
        }}
      >
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="block text-sm">
            来源
            <Select
              value={draft.source}
              onValueChange={(value) => {
                if (
                  value === "all" ||
                  value === "lab-archive" ||
                  value === "cli-report"
                )
                  setField("source", value);
              }}
            >
              <SelectTrigger
                aria-label="诊断归档来源"
                className="mt-1 max-w-full"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {sourceOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className="block text-sm">
            策略键
            <Input
              aria-label="按策略键筛选"
              className="mt-1"
              value={draft.strategyKey}
              maxLength={100}
              placeholder="例如 research-chan-third"
              onChange={(event) => setField("strategyKey", event.target.value)}
            />
          </label>
          <label className="block text-sm">
            标的
            <Input
              aria-label="按标的筛选"
              className="mt-1"
              value={draft.symbol}
              placeholder="例如 sz300750"
              onChange={(event) => setField("symbol", event.target.value)}
            />
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" variant="outline" disabled={!dirty}>
            应用筛选
          </Button>
          <Button
            type="button"
            size="sm"
            variant="plain"
            disabled={!dirty && !filtered}
            onClick={() => {
              setDraft(initialFilters);
              setApplied(initialFilters);
              setListPage(1);
              setSelectedId(null);
            }}
          >
            清空
          </Button>
          {dirty && (
            <span role="status" className="text-sub text-nc-text-3">
              筛选已修改，尚未应用。
            </span>
          )}
        </div>
      </form>
      {symbolInput && !validSymbol && (
        <p role="status" className="text-sub text-nc-warn">
          标的需为 sh/sz/bj + 6 位数字；当前输入未参与筛选。
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-nc-text-3">
          对比勾选 {compareIds.length}/2（最多两份）
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="diagnose-compare-open"
          disabled={compareIds.length !== 2}
          onClick={() => {
            if (!selectedId) {
              setSelectedId(compareIds[0] ?? null);
              setPage(1);
            }
            setCompareOpen(true);
          }}
        >
          并排对比
        </Button>
        {(compareIds.length > 0 || compareOpen) && (
          <Button
            type="button"
            size="sm"
            variant="plain"
            onClick={() => {
              setCompareIds([]);
              setCompareOpen(false);
            }}
          >
            清除对比
          </Button>
        )}
      </div>

      {archives.isError && (
        <div role="alert" className="space-y-2 text-sm text-nc-warn">
          <p>读取诊断归档失败：{archives.error.message}</p>
          <Button
            type="button"
            variant="outline"
            onClick={() => void archives.refetch()}
          >
            重试
          </Button>
        </div>
      )}
      {archives.isPending && (
        <p role="status" className="text-sm text-nc-text-3">
          正在读取诊断归档…
        </p>
      )}
      {archives.data?.length === 0 && (
        <p className="text-sm text-nc-text-3">
          {listPage === 1
            ? "没有匹配的诊断归档。可新建诊断运行或调整筛选条件。"
            : "此页没有更多归档。"}
        </p>
      )}
      {archives.data &&
        (listPage > 1 || archives.data.length === archivePageSize) && (
          <DiagnosePagination
            page={listPage}
            hasNext={archives.data.length === archivePageSize}
            onPageChange={setListPage}
          />
        )}
      {archives.data && archives.data.length > 0 && (
        <ul className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
          {archives.data.map((archive) => (
            <ArchiveRow
              key={archive.id}
              archive={archive}
              selected={archive.id === selectedId}
              onSelect={() => {
                setCompareOpen(false);
                setSelectedId(archive.id);
                setPage(1);
              }}
              compareChecked={compareIds.includes(archive.id)}
              compareDisabled={
                compareIds.length === 2 && !compareIds.includes(archive.id)
              }
              onToggleCompare={(next) => toggleCompare(archive.id, next)}
            />
          ))}
        </ul>
      )}

      {compareOpen && (
        <>
          {comparison.isError && (
            <div role="alert" className="space-y-2 text-sm text-nc-warn">
              <p>读取归档对比失败：{comparison.error.message}</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => void comparison.refetch()}
              >
                重试
              </Button>
            </div>
          )}
          {comparison.isPending && compareIds.length === 2 && (
            <p role="status" className="text-sm text-nc-text-3">
              正在读取两份诊断归档…
            </p>
          )}
          {comparison.data && (
            <DiagnoseComparePanel
              left={comparison.data.left}
              right={comparison.data.right}
              onClose={() => setCompareOpen(false)}
            />
          )}
        </>
      )}

      <div ref={detailRef} tabIndex={-1} hidden={compareOpen}>
        {selectedId && detail.isError && (
          <div role="alert" className="space-y-2 text-sm text-nc-warn">
            <p>读取归档明细失败：{detail.error.message}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => void detail.refetch()}
            >
              重试
            </Button>
          </div>
        )}
        {selectedId && detail.isPending && (
          <p role="status" className="text-sm text-nc-text-3">
            正在读取归档明细…
          </p>
        )}
        {detail.data && (
          <DiagnoseDetailView
            key={`${detail.data.summary.id}:${detail.data.pagination.page}`}
            detail={detail.data}
            active={visible && active && !compareOpen}
            onPageChange={setPage}
          />
        )}
        {selectedId && detail.isSuccess && detail.data === null && (
          <p role="status" className="text-sm text-nc-text-3">
            此诊断归档尚不可查看。
          </p>
        )}
        {!selectedId && (
          <p className="text-sm text-nc-text-3">
            选择一个归档以查看执行情景对比、15 项检查与理论口径披露。
          </p>
        )}
      </div>
    </div>
  );
}

export type DiagnoseRunPrefill = {
  symbol?: string;
  symbols?: string[];
  mode?: "per-symbol" | "portfolio";
  strategyKey?: string;
  bookPreset?: "core-4";
  start?: string;
  end?: string;
};

const defaultHoldoutStart = "2023-01-01";

function prefillSymbolText(prefill: DiagnoseRunPrefill | null) {
  if (!prefill) return "";
  if (prefill.symbols?.length) return prefill.symbols.join(", ");
  return prefill.symbol ?? "";
}

function prefillRunMode(prefill: DiagnoseRunPrefill | null): RunMode {
  if (prefill?.bookPreset === "core-4") return "core-4";
  return prefill?.mode ?? "per-symbol";
}

function RunForm({
  prefill,
  active,
  onViewArchive,
}: {
  prefill: DiagnoseRunPrefill | null;
  active: boolean;
  onViewArchive: (archiveId: string) => void;
}) {
  const visible = usePanelVisible();
  const [symbols, setSymbols] = useState(prefillSymbolText(prefill));
  const [runMode, setRunMode] = useState<RunMode>(prefillRunMode(prefill));
  const [strategyKey, setStrategyKey] = useState(prefill?.strategyKey ?? "");
  const [autoStart, setAutoStart] = useState(false);
  const [start, setStart] = useState(prefill?.start ?? "");
  const [end, setEnd] = useState(prefill?.end ?? "");
  const [initial, setInitial] = useState(1_000_000);
  const [costScenario, setCostScenario] = useState<CostScenario>("fixed");
  const [includeHoldout, setIncludeHoldout] = useState(false);
  const [holdoutStart, setHoldoutStart] = useState(defaultHoldoutStart);
  const [chosen, setChosen] = useState<DiagnoseScenarioId[]>([
    "strict",
    "clamp",
    "cap-0.5-clip",
  ]);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [appliedPrefill, setAppliedPrefill] = useState(prefill);
  const [jobId, setJobId] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const submitting = useRef(false);
  if (prefill !== appliedPrefill) {
    setAppliedPrefill(prefill);
    if (prefill) {
      setSymbols(prefillSymbolText(prefill));
      setRunMode(prefillRunMode(prefill));
      setStrategyKey(prefill.strategyKey ?? "");
      setAutoStart(false);
      setStart(prefill.start ?? "");
      setEnd(prefill.end ?? "");
      setConfirmed(false);
      setError("");
    }
  }
  const utils = api.useUtils();
  const run = api.strategyLabDiagnoseRun.useMutation();
  const result = api.strategyLabDiagnoseResult.useQuery(
    { jobId: jobId ?? "" },
    {
      enabled: visible && jobId !== null,
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status && (status === "queued" || status === "running")
          ? 400
          : false;
      },
    },
  );
  const completedArchiveId =
    result.data?.status === "completed"
      ? (result.data.detail?.summary.id ?? null)
      : null;
  const seenArchive = useRef<string | null>(null);
  useEffect(() => {
    if (!completedArchiveId || seenArchive.current === completedArchiveId)
      return;
    seenArchive.current = completedArchiveId;
    void utils.strategyLabDiagnoseArchives.invalidate();
  }, [completedArchiveId, utils]);

  const toggleScenario = (id: DiagnoseScenarioId, next: boolean) =>
    setChosen((current) =>
      next
        ? current.includes(id)
          ? current
          : [...current, id]
        : current.filter((value) => value !== id),
    );

  const submit = () => {
    if (submitting.current || awaitingResult) return;
    setError("");
    setCopyStatus("");
    const parsed = labDiagnoseRunInputSchema.safeParse({
      symbols: splitSymbols(symbols),
      mode: runMode === "core-4" ? "portfolio" : runMode,
      ...(runMode === "core-4"
        ? { bookPreset: "core-4" as const }
        : { strategyKey }),
      includeHoldout,
      ...(includeHoldout && holdoutStart ? { holdoutStart } : {}),
      start: autoStart ? "auto" : start,
      end,
      initial,
      costScenario,
      scenarios: chosen,
      confirmed,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path[0];
      const message =
        field === "symbols"
          ? "请输入 1 至 12 个不重复的标的（sh/sz/bj + 6 位数字）。"
          : field === "strategyKey"
            ? "请输入策略键（最多 100 字）；四策略组合请选择 core-4 预设。"
            : field === "bookPreset"
              ? "四策略核心组合须指定 core-4 预设。"
              : field === "mode"
                ? "四策略核心组合须使用组合模式。"
                : field === "start" || field === "end"
                  ? "请选择有效的历史日期范围，或使用自动起始。"
                  : field === "initial"
                    ? "独立本金须大于 0 且不超过 10 亿元。"
                    : field === "holdoutStart"
                      ? "留出切点须晚于开始日期且不晚于结束日期。"
                      : field === "scenarios"
                        ? "至少选择一个执行情景。"
                        : field === "confirmed"
                          ? "请先确认诊断运行口径。"
                          : (issue?.message ?? "请检查诊断参数。");
      setError(message);
      return;
    }
    submitting.current = true;
    run.mutate(parsed.data, {
      onSuccess: (job) => setJobId(job.id),
      onSettled: () => {
        submitting.current = false;
      },
    });
  };

  const running =
    result.data?.status === "queued" || result.data?.status === "running";
  const awaitingResult = jobId !== null && (running || !result.data);

  async function copyArchiveLink(archiveId: string) {
    const path = `/lab/backtest?archive=${encodeURIComponent(archiveId)}`;
    const href =
      typeof window === "undefined"
        ? path
        : new URL(path, window.location.origin).toString();
    try {
      if (!navigator.clipboard) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(href);
      setCopyStatus("已复制");
    } catch {
      setCopyStatus(`复制失败，请手动复制：${href}`);
    }
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p className="text-sm text-nc-text-3">
        所选执行情景共用同一份冻结行情样本。
      </p>
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        <label className="block text-sm">
          标的（最多 12 个）
          <Input
            data-testid="diagnose-run-symbols"
            aria-label="诊断标的"
            className="mt-1"
            value={symbols}
            placeholder="sz300750, sh600000"
            onChange={(event) => setSymbols(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          诊断模式
          <Select
            value={runMode}
            onValueChange={(value) => {
              if (
                value === "per-symbol" ||
                value === "portfolio" ||
                value === "core-4"
              ) {
                setRunMode(value);
              }
            }}
          >
            <SelectTrigger aria-label="诊断模式" className="mt-1 max-w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {runModeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="block text-sm">
          策略键
          <Input
            aria-label="诊断策略键"
            className="mt-1"
            value={runMode === "core-4" ? "core-4" : strategyKey}
            maxLength={100}
            disabled={runMode === "core-4"}
            placeholder="例如 research-chan-third"
            onChange={(event) => setStrategyKey(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          独立本金
          <Input
            aria-label="诊断独立本金"
            type="number"
            min={0}
            max={1e9}
            step="any"
            className="mt-1"
            value={initial}
            onChange={(event) => setInitial(Number(event.target.value))}
          />
        </label>
        <label className="block text-sm">
          开始日期
          <Input
            aria-label="诊断开始日期"
            type="date"
            className="mt-1"
            value={start}
            disabled={autoStart}
            onChange={(event) => setStart(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          结束日期
          <Input
            aria-label="诊断结束日期"
            type="date"
            className="mt-1"
            value={end}
            onChange={(event) => setEnd(event.target.value)}
          />
        </label>
        <label className="block text-sm">
          成本情景
          <Select
            value={costScenario}
            onValueChange={(value) => {
              if (
                value === "fixed" ||
                value === "base" ||
                value === "double-cost"
              )
                setCostScenario(value);
            }}
          >
            <SelectTrigger
              aria-label="诊断成本情景"
              className="mt-1 max-w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {costScenarioOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </div>

      {runMode === "core-4" && (
        <div className="rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2 text-sm">
          <p className="font-medium text-nc-text">四策略核心组合 (core-4)</p>
          <p className="mt-1 text-nc-text-3">
            组合模式固定为 4 分仓等权、跨分仓合计最多 10 个持仓、单票上限
            10%。「0.5% 容量裁剪」情景按日成交额在分仓间共享容量。
          </p>
        </div>
      )}

      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={autoStart}
          onCheckedChange={(value) => setAutoStart(value === true)}
        />
        自动起始（auto，使用最早可用数据）
      </label>

      <fieldset className="space-y-1.5 rounded-lg border border-nc-border-soft px-3 py-2">
        <legend className="px-1 text-sm text-nc-text-3">时间留出验证</legend>
        <label className="flex items-start gap-2 text-sm">
          <Checkbox
            checked={includeHoldout}
            onCheckedChange={(value) => setIncludeHoldout(value === true)}
            className="mt-0.5"
          />
          包含历史留出复核（includeHoldout）
        </label>
        <label className="block text-sm">
          留出切点 holdoutStart
          <Input
            aria-label="留出切点"
            type="date"
            className="mt-1 max-w-56"
            value={holdoutStart}
            disabled={!includeHoldout}
            onChange={(event) => setHoldoutStart(event.target.value)}
          />
        </label>
        <p className="text-sub text-nc-text-4">
          历史留出复核，不宣称新鲜样本外收益；默认切点 {defaultHoldoutStart}。
        </p>
      </fieldset>

      <fieldset className="space-y-1.5">
        <legend className="text-sm text-nc-text-3">执行情景</legend>
        <div className="flex flex-wrap gap-3">
          {scenarioOptions.map((option) => (
            <label key={option.id} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={chosen.includes(option.id)}
                onCheckedChange={(value) =>
                  toggleScenario(option.id, value === true)
                }
              />
              {option.label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="flex items-start gap-2 text-sm">
        <Checkbox
          checked={confirmed}
          onCheckedChange={(value) => setConfirmed(value === true)}
          className="mt-0.5"
        />
        确认以诊断专用只读/记录口径运行（不影响常规回测默认）
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          disabled={run.isPending || awaitingResult || !confirmed}
          aria-busy={run.isPending || (awaitingResult && !result.isError)}
        >
          {run.isPending
            ? "正在创建诊断任务…"
            : running
              ? "诊断运行中…"
              : awaitingResult
                ? "等待诊断状态"
                : "运行成组情景诊断"}
        </Button>
        {jobId && <DiagnosticTaskIndicator />}
        {result.data && (
          <span role="status" className="text-sub text-nc-text-3">
            {result.data.status}
            {result.data.phase ? ` · ${result.data.phase}` : ""}
            {result.data.progress !== null
              ? ` · ${formatCount(result.data.progress)}%`
              : ""}
          </span>
        )}
      </div>

      {(error || run.error || result.error) && (
        <p role="alert" className="text-sm text-nc-warn">
          {error || run.error?.message || result.error?.message}
        </p>
      )}
      {result.isError && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void result.refetch()}
        >
          重新读取诊断状态
        </Button>
      )}
      {result.data?.status === "failed" && (
        <p role="alert" className="text-sm text-nc-warn">
          诊断任务失败：{result.data.error ?? "未返回错误信息"}
        </p>
      )}

      {completedArchiveId && (
        <div
          data-testid="diagnose-run-receipt"
          role="status"
          className="space-y-2 rounded-lg border border-nc-border bg-nc-inset px-3 py-2 text-sm"
        >
          <div className="flex flex-wrap items-baseline gap-2">
            <Pill tone="ok">诊断完成</Pill>
            <span className="text-nc-text">归档 {completedArchiveId}</span>
            {result.data?.progress !== null &&
              result.data?.progress !== undefined && (
                <span className="text-sub text-nc-text-3">
                  {formatCount(result.data.progress)}%
                </span>
              )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => onViewArchive(completedArchiveId)}
            >
              查看归档
            </Button>
            {jobId && (
              <Button asChild size="sm" variant="outline">
                <Link href={taskHistoryHref({ id: jobId })}>
                  在任务中心查看
                </Link>
              </Button>
            )}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void copyArchiveLink(completedArchiveId)}
            >
              复制归档链接
            </Button>
            {copyStatus && (
              <span role="status" className="text-sub text-nc-text-3">
                {copyStatus}
              </span>
            )}
          </div>
        </div>
      )}

      {result.data?.detail && (
        <DiagnoseDetailView
          key={`${result.data.detail.summary.id}:${result.data.detail.pagination.page}`}
          detail={result.data.detail}
          active={visible && active}
        />
      )}
    </form>
  );
}

/** `/lab/backtest` diagnostic workspace: archived reports or a grouped run. */
export function DiagnoseWorkspacePanel({
  prefill = null,
  archiveId = null,
}: {
  prefill?: DiagnoseRunPrefill | null;
  archiveId?: string | null;
}) {
  const visible = usePanelVisible();
  const linkedArchiveId = visible ? archiveId : null;
  const [tab, setTab] = useState(prefill ? "run" : "archives");
  const [runVisited, setRunVisited] = useState(prefill !== null);
  const [archiveRequest, setArchiveRequest] = useState<ArchiveRequest | null>(
    linkedArchiveId ? { id: linkedArchiveId } : null,
  );
  const [seenPrefill, setSeenPrefill] = useState(prefill);
  const [seenArchiveId, setSeenArchiveId] = useState(linkedArchiveId);
  const prefillChanged = prefill !== seenPrefill;
  if (prefillChanged) setSeenPrefill(prefill);
  const archiveChanged = linkedArchiveId !== seenArchiveId;
  if (archiveChanged) setSeenArchiveId(linkedArchiveId);
  const openArchive =
    linkedArchiveId && (archiveChanged || (prefillChanged && !prefill));
  if (openArchive) setArchiveRequest({ id: linkedArchiveId });
  if (prefillChanged && prefill) {
    setTab("run");
    setRunVisited(true);
  } else if (openArchive) {
    setTab("archives");
  }
  return (
    <section
      aria-label="诊断工作台"
      className="mt-4 space-y-3 rounded-lg border border-nc-border bg-nc-card p-4"
    >
      <header className="flex flex-wrap items-baseline gap-2">
        <h3 className="text-base font-semibold text-nc-text">诊断工作台</h3>
        <span className="text-sub text-nc-text-3">
          历史诊断档案与成组情景运行；工程健康与研究有效性分开验收。
        </span>
      </header>
      <Tabs
        value={tab}
        onValueChange={(value) => {
          setTab(value);
          if (value === "run") setRunVisited(true);
        }}
      >
        <TabsList className="flex-wrap justify-start">
          <TabsTrigger value="archives">历史诊断档案</TabsTrigger>
          <TabsTrigger value="run">成组情景诊断运行</TabsTrigger>
        </TabsList>
        <TabsContent
          value="archives"
          forceMount
          className="data-[state=inactive]:hidden"
        >
          <ArchiveBrowser
            active={tab === "archives"}
            archiveRequest={archiveRequest}
          />
        </TabsContent>
        <TabsContent
          value="run"
          forceMount
          className="data-[state=inactive]:hidden"
        >
          {runVisited && (
            <RunForm
              prefill={prefill}
              active={tab === "run"}
              onViewArchive={(id) => {
                setArchiveRequest({ id });
                setTab("archives");
              }}
            />
          )}
        </TabsContent>
      </Tabs>
    </section>
  );
}
