"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { api } from "~/trpc/react";
import {
  DIAGNOSE_SCENARIO_PRESETS,
  diagnoseBookInputSchema,
  labDiagnoseRunInputSchema,
  normalizeDiagnoseBookInput,
  type DiagnoseArchiveSummary,
  type DiagnoseBookSleeve,
  type DiagnoseScenarioId,
} from "~/lib/research/diagnose-contract";
import { taskHistoryHref } from "~/lib/research/workflow/task-history-location";
import { usePanelVisible } from "../../workbench/keep-alive";
import { DiagnosticTaskIndicator } from "../../workbench/task-evidence";
import type { ResearchStudioDraftInput } from "~/lib/research/studio-result";
import { researchStudioDraftSchema } from "~/lib/research/studio-result";
import {
  RiskPolicyFields,
  StrategyPicker,
  StudioStep,
} from "../studio/studio-fields";
import { FrozenJson } from "../studio/frozen-json";
import type { StudioCatalog } from "../studio/studio-fields";
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
import {
  equalizeSleeveWeights,
  formatCount,
  formatPercent,
  maxSleeves,
  minSleeves,
  validateSleeveDraft,
  type SleeveDraft,
} from "./format";

const scenarioOptions = Object.values(DIAGNOSE_SCENARIO_PRESETS);

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
  { value: "custom", label: "自定义组合（2–6 策略）" },
] as const;
type RunMode = (typeof runModeOptions)[number]["value"];

const splitSymbols = (value: string) =>
  value
    .split(/[\s,，、]+/)
    .map((item) => item.trim())
    .filter(Boolean);

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

export type DiagnoseRunRequest =
  { handoff: DiagnoseRunPrefill } | { archive: DiagnoseArchiveSummary };

function toSleeveDrafts(sleeves: readonly DiagnoseBookSleeve[]): SleeveDraft[] {
  return sleeves.map((row) => ({ ...row, share: String(row.share) }));
}

function runDraft(
  request: DiagnoseRunRequest | null,
  template: "single" | "multi-book",
) {
  const prefill = request && "handoff" in request ? request.handoff : null;
  const archive = request && "archive" in request ? request.archive : null;
  const run = archive?.run;
  const rawBook = run?.book ?? run?.bookPreset;
  const book = rawBook && normalizeDiagnoseBookInput(rawBook);
  const custom = book && "sleeves" in book ? book.sleeves : null;
  const missingBook =
    !book &&
    !!run &&
    (run.strategyKey === "core-4" ||
      /^custom-[0-9a-f]{8}$/.test(run.strategyKey ?? "") ||
      !!archive?.book ||
      !!archive?.bookPreset);
  const mode: RunMode | "" = custom
    ? "custom"
    : book
      ? "core-4"
      : archive
        ? missingBook
          ? ""
          : (run?.mode ?? "")
        : prefill
          ? prefillRunMode(prefill)
          : template === "multi-book"
            ? "custom"
            : "portfolio";
  const missing = !archive
    ? []
    : !run
      ? ["诊断模式、标的、策略、日期、本金、成本情景、执行情景、时间留出设置"]
      : [
          missingBook ? "分仓组合" : !mode && "诊断模式",
          !missingBook && !book && !run.strategyKey && "策略键",
          run.includeHoldout && !run.holdoutStart && "留出切点",
        ].filter(Boolean);

  return {
    archive,
    missing,
    symbols: run?.symbols.join(", ") ?? prefillSymbolText(prefill),
    runMode: mode,
    strategyKey:
      book || missingBook
        ? ""
        : (run?.strategyKey ?? prefill?.strategyKey ?? ""),
    archivedStrategies: missingBook ? undefined : run?.strategies,
    poolId: run?.poolId,
    poolKind: run?.poolId ?? "custom",
    bookControl: run?.bookControl,
    riskPolicy: run?.riskPolicy,
    sleeves: custom
      ? toSleeveDrafts(custom)
      : equalizeSleeveWeights([
          { id: "sleeve-1", strategyKey: "", share: "" },
          { id: "sleeve-2", strategyKey: "", share: "" },
        ]),
    autoStart: run?.start === "auto",
    start: run?.start === "auto" ? "" : (run?.start ?? prefill?.start ?? ""),
    end: run?.end ?? prefill?.end ?? "",
    initial: run ? String(run.initial) : archive ? "" : "1000000",
    costScenario: (run?.costScenario ?? (archive ? "" : "fixed")) as
      CostScenario | "",
    includeHoldout: run?.includeHoldout ?? (archive ? null : false),
    holdoutStart: run?.holdoutStart ?? (archive ? "" : defaultHoldoutStart),
    chosen:
      run?.scenarios ??
      (archive ? [] : scenarioOptions.map((scenario) => scenario.id)),
    confirmed: false,
  };
}

const presetStorageKey = "guanlan.diagnose.custom-book-presets.v1";
const presetLimit = 5;
type LocalBookPreset = { name: string; sleeves: DiagnoseBookSleeve[] };

function readLocalBookPresets(): LocalBookPreset[] {
  try {
    const stored: unknown = JSON.parse(
      localStorage.getItem(presetStorageKey) ?? "[]",
    );
    if (!Array.isArray(stored)) return [];
    return stored
      .flatMap((row) => {
        if (typeof row?.name !== "string" || !row.name.trim()) return [];
        const parsed = diagnoseBookInputSchema.safeParse({
          sleeves: row.sleeves,
        });
        if (
          !parsed.success ||
          typeof parsed.data === "string" ||
          !("sleeves" in parsed.data)
        )
          return [];
        return [{ name: row.name, sleeves: parsed.data.sleeves }];
      })
      .slice(0, presetLimit);
  } catch {
    return [];
  }
}

function CustomBookEditor({
  sleeves,
  validation,
  onChange,
}: {
  sleeves: SleeveDraft[];
  validation: ReturnType<typeof validateSleeveDraft>;
  onChange: (sleeves: SleeveDraft[]) => void;
}) {
  const validationId = useId();
  const [presets, setPresets] = useState(readLocalBookPresets);
  const [name, setName] = useState("");
  const [selectedName, setSelectedName] = useState("");
  const [presetError, setPresetError] = useState("");
  const selected = presets.find((preset) => preset.name === selectedName);
  const duplicate = presets.some((preset) => preset.name === name.trim());

  function persist(next: LocalBookPreset[], selection: string) {
    try {
      localStorage.setItem(presetStorageKey, JSON.stringify(next));
      setPresets(next);
      setSelectedName(selection);
      setPresetError("");
    } catch {
      setPresetError("无法保存浏览器预设，请检查本地存储设置。");
    }
  }

  function updateSleeve(id: string, fields: Partial<SleeveDraft>) {
    onChange(
      sleeves.map((row) => (row.id === id ? { ...row, ...fields } : row)),
    );
  }

  return (
    <fieldset className="space-y-2 rounded-lg border border-nc-border-soft px-3 py-2">
      <legend className="px-1 text-sm">自定义分仓</legend>
      {sleeves.map((row, index) => (
        <div key={row.id} className="flex flex-wrap items-end gap-2">
          <label className="min-w-48 flex-1 text-sm">
            分仓 {index + 1} 策略键
            <Input
              className="mt-1"
              value={row.strategyKey}
              maxLength={100}
              placeholder="例如 dual-ma"
              onChange={(event) =>
                updateSleeve(row.id, { strategyKey: event.target.value })
              }
            />
          </label>
          <label className="w-40 text-sm">
            分仓 {index + 1} 权重
            <Input
              type="number"
              step="any"
              inputMode="decimal"
              className="mt-1"
              aria-describedby={validationId}
              placeholder="例如 0.5"
              value={row.share}
              onChange={(event) =>
                updateSleeve(row.id, { share: event.target.value })
              }
            />
          </label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-label={`移除分仓 ${index + 1}`}
            disabled={sleeves.length <= minSleeves}
            onClick={() =>
              onChange(sleeves.filter((sleeve) => sleeve.id !== row.id))
            }
          >
            移除
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={sleeves.length >= maxSleeves}
          onClick={() => {
            let index = 1;
            while (sleeves.some((row) => row.id === `sleeve-${index}`)) index++;
            onChange([
              ...sleeves,
              { id: `sleeve-${index}`, strategyKey: "", share: "" },
            ]);
          }}
        >
          添加分仓
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onChange(equalizeSleeveWeights(sleeves))}
        >
          均分权重
        </Button>
        <p
          id={validationId}
          role="status"
          className={`text-sm ${validation.error ? "text-nc-warn" : "text-nc-text-3"}`}
        >
          权重合计 {formatPercent(validation.sum)}（1 = 100%）
          {validation.error && ` · ${validation.error}`}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-nc-border-soft pt-2">
        <Input
          aria-label="本地组合预设名称"
          className="w-44"
          placeholder="本地预设名称"
          value={name}
          maxLength={40}
          onChange={(event) => setName(event.target.value)}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={
            !name.trim() ||
            duplicate ||
            !validation.book ||
            presets.length >= presetLimit
          }
          onClick={() => {
            if (
              !validation.book ||
              !name.trim() ||
              duplicate ||
              presets.length >= presetLimit
            )
              return;
            const next = {
              name: name.trim(),
              sleeves: validation.book.sleeves,
            };
            persist([...presets, next], next.name);
          }}
        >
          保存本地预设
        </Button>
        <Select value={selected?.name ?? ""} onValueChange={setSelectedName}>
          <SelectTrigger aria-label="本地组合预设" className="max-w-full">
            <SelectValue
              placeholder={`本地预设 (${presets.length}/${presetLimit})`}
            />
          </SelectTrigger>
          <SelectContent>
            {presets.map((preset) => (
              <SelectItem key={preset.name} value={preset.name}>
                {preset.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!selected}
          onClick={() => selected && onChange(toSleeveDrafts(selected.sleeves))}
        >
          加载本地预设
        </Button>
        <Button
          type="button"
          size="sm"
          variant="plain"
          disabled={!selected}
          onClick={() =>
            persist(
              presets.filter((preset) => preset.name !== selectedName),
              "",
            )
          }
        >
          删除本地预设
        </Button>
        {duplicate && (
          <span className="text-sub text-nc-warn">预设名称已存在</span>
        )}
        {presets.length >= presetLimit && (
          <span className="text-sub text-nc-text-3">
            已保存 {presetLimit} 套预设
          </span>
        )}
      </div>
      {presetError && (
        <p role="alert" className="text-sm text-nc-warn">
          {presetError}
        </p>
      )}
    </fieldset>
  );
}

export function DiagnoseWorkspacePanel({
  request,
  template,
  catalog,
  onViewArchive,
  onStudioRun,
  studioBusy,
}: {
  request: DiagnoseRunRequest | null;
  template: "single" | "multi-book";
  catalog: StudioCatalog | undefined;
  onViewArchive: (archiveId: string) => void;
  onStudioRun: (draft: ResearchStudioDraftInput) => void;
  studioBusy: boolean;
}) {
  const visible = usePanelVisible();
  const [baseline, setBaseline] = useState(() => runDraft(request, template));
  const [draft, setDraft] = useState(baseline);
  const [seenRequest, setSeenRequest] = useState(request);
  const [seenTemplate, setSeenTemplate] = useState(template);
  const [submission, setSubmission] = useState<"archive" | "studio">(
    request ? "archive" : "studio",
  );
  const [pending, setPending] = useState<DiagnoseRunRequest | null>(null);
  const [error, setError] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const submitting = useRef(false);
  const {
    symbols,
    runMode,
    strategyKey,
    sleeves,
    autoStart,
    start,
    end,
    initial,
    costScenario,
    includeHoldout,
    holdoutStart,
    chosen,
    confirmed,
  } = draft;
  const edit = (fields: Partial<typeof draft>) =>
    setDraft((current) => ({
      ...current,
      ...fields,
      ...(("runMode" in fields ||
        "strategyKey" in fields ||
        "sleeves" in fields) && { archivedStrategies: undefined }),
    }));
  const applyRequest = (next: DiagnoseRunRequest) => {
    const nextDraft = runDraft(next, template);
    setSubmission("archive");
    setBaseline(nextDraft);
    setDraft(nextDraft);
    setPending(null);
    setError("");
  };
  if (template !== seenTemplate) {
    setSeenTemplate(template);
    if (!request || request === seenRequest) {
      const mode = template === "multi-book" ? "custom" : "portfolio";
      if (
        (runMode === "custom" || runMode === "core-4") !==
        (template === "multi-book")
      )
        edit({ runMode: mode });
    }
  }
  if (request !== seenRequest) {
    setSeenRequest(request);
    if (request) {
      if (draft !== baseline) setPending(request);
      else applyRequest(request);
    }
  }
  const sleeveValidation = validateSleeveDraft(sleeves);
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
    edit({
      chosen: next ? [...chosen, id] : chosen.filter((value) => value !== id),
    });

  const rawRun = {
    symbols: splitSymbols(symbols),
    poolId: draft.poolId,
    mode: runMode === "core-4" || runMode === "custom" ? "portfolio" : runMode,
    ...(runMode === "core-4"
      ? { book: { preset: "core-4" as const } }
      : runMode === "custom"
        ? { book: sleeveValidation.book }
        : { strategyKey }),
    bookControl:
      runMode === "core-4" || runMode === "custom"
        ? draft.bookControl
        : undefined,
    riskPolicy: draft.riskPolicy,
    strategies: draft.archivedStrategies,
    includeHoldout,
    holdoutStart: includeHoldout
      ? holdoutStart
      : draft.archive?.run?.holdoutStart,
    start: autoStart ? "auto" : start,
    end,
    initial: initial === "" ? undefined : Number(initial),
    costScenario,
    scenarios: chosen,
    confirmed,
  };
  const studioInput = {
    universe:
      draft.poolId === "core-12" || draft.poolId === "core-30-v1"
        ? draft.poolId
        : rawRun.symbols,
    start,
    end,
    initial: rawRun.initial,
    costScenario,
    riskPolicy: draft.riskPolicy,
    holdoutStart: includeHoldout ? holdoutStart : undefined,
    ...("book" in rawRun && rawRun.book
      ? {
          template: "multi-book",
          book: rawRun.book,
          bookControl: rawRun.bookControl,
        }
      : { template: "single", strategy: strategyKey }),
  };
  const effectiveSubmission =
    autoStart ||
    runMode === "per-symbol" ||
    draft.archive ||
    draft.poolId === "core-5" ||
    draft.poolId === "chan-core-7"
      ? "archive"
      : submission;

  const submit = () => {
    if (submitting.current || awaitingResult || studioBusy) return;
    setError("");
    setCopyStatus("");
    if (
      !runMode ||
      includeHoldout === null ||
      (includeHoldout && !holdoutStart)
    ) {
      setError("请选择诊断模式和时间留出设置，并填写启用时的留出切点。");
      return;
    }
    if (runMode === "custom" && !sleeveValidation.book) return;
    if (draft.poolKind === "single" && rawRun.symbols.length !== 1) {
      setError("单股证券池须填写一个标的。");
      return;
    }
    if (effectiveSubmission === "studio") {
      const parsed = researchStudioDraftSchema.safeParse(studioInput);
      if (parsed.success) onStudioRun(parsed.data);
      else setError(parsed.error.issues[0]?.message ?? "请检查研究参数。");
      return;
    }
    const parsed = labDiagnoseRunInputSchema.safeParse(rawRun);
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
      onSuccess: (job) => {
        setJobId(job.id);
        setBaseline(draft);
      },
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
      {pending && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 text-sm text-nc-warn"
        >
          <span>当前诊断草稿有未保存修改，确认覆盖？</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => applyRequest(pending)}
          >
            确认覆盖诊断草稿
          </Button>
          <Button
            type="button"
            size="sm"
            variant="plain"
            onClick={() => setPending(null)}
          >
            保留当前诊断草稿
          </Button>
        </div>
      )}
      {draft.archive && (
        <div className="space-y-1 text-sm">
          <p>复跑参数来自归档 {draft.archive.title}</p>
          {draft.missing.length > 0 && (
            <p role="status" className="text-nc-warn">
              未记录，需重填：{draft.missing.join("、")}
            </p>
          )}
        </div>
      )}
      <StudioStep title="2. 策略选择">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="block text-sm">
            诊断模式
            <Select
              value={runMode}
              onValueChange={(value) => {
                const mode = runModeOptions.find(
                  (option) => option.value === value,
                );
                if (mode) edit({ runMode: mode.value });
              }}
            >
              <SelectTrigger aria-label="诊断模式" className="mt-1 max-w-full">
                <SelectValue placeholder="选择诊断模式" />
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
          {runMode !== "custom" && runMode !== "core-4" && (
            <StrategyPicker
              label="诊断策略键"
              value={strategyKey}
              groups={catalog?.strategyGroups ?? []}
              onChange={(value) => edit({ strategyKey: value })}
            />
          )}
        </div>
      </StudioStep>
      <StudioStep title="3. 证券池与历史区间">
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <label className="block text-sm">
            证券池
            <select
              className="mt-1 block w-full"
              value={draft.poolKind}
              onChange={(event) => {
                const value = event.target.value;
                const pool = catalog?.pools.find((item) => item.id === value);
                const poolId =
                  value === "core-12" || value === "core-30-v1"
                    ? value
                    : undefined;
                edit({
                  poolId,
                  poolKind: value,
                  symbols:
                    pool?.symbols.join(", ") ??
                    (value === "single"
                      ? (splitSymbols(symbols)[0] ?? "")
                      : symbols),
                });
              }}
            >
              <option value="custom">自定义（1–12 股）</option>
              <option value="single">单股</option>
              {catalog?.pools
                .filter((pool) => pool.id !== "etf-21")
                .map((pool) => (
                  <option key={pool.id} value={pool.id}>
                    {pool.label} · {pool.id}
                  </option>
                ))}
              {(draft.poolId === "core-5" ||
                draft.poolId === "chan-core-7") && (
                <option value={draft.poolId}>{draft.poolId}</option>
              )}
            </select>
          </label>
          <label className="block text-sm">
            {draft.poolId
              ? "具名池成员"
              : draft.poolKind === "single"
                ? "单股标的"
                : "标的（最多 12 个）"}
            <Input
              data-testid="diagnose-run-symbols"
              aria-label="诊断标的"
              className="mt-1"
              value={symbols}
              placeholder="sz300750, sh600000"
              readOnly={!!draft.poolId}
              onChange={(event) => edit({ symbols: event.target.value })}
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
              onChange={(event) => edit({ initial: event.target.value })}
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
              onChange={(event) => edit({ start: event.target.value })}
            />
          </label>
          <label className="block text-sm">
            结束日期
            <Input
              aria-label="诊断结束日期"
              type="date"
              className="mt-1"
              value={end}
              onChange={(event) => edit({ end: event.target.value })}
            />
          </label>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={autoStart}
            onCheckedChange={(value) => edit({ autoStart: value === true })}
          />
          自动起始（auto，使用最早可用数据）
        </label>
        {catalog?.pools.find((pool) => pool.id === draft.poolId)
          ?.disclosure && (
          <p className="text-xs text-nc-text-3">
            {catalog.pools.find((pool) => pool.id === draft.poolId)?.disclosure}
          </p>
        )}
      </StudioStep>
      <StudioStep title="4. 分仓与账户风控">
        {runMode === "custom" && (
          <CustomBookEditor
            sleeves={sleeves}
            validation={sleeveValidation}
            onChange={(next) => edit({ sleeves: next })}
          />
        )}

        {runMode === "core-4" && (
          <div className="rounded-lg border border-nc-border-soft bg-nc-inset px-3 py-2 text-sm">
            <p className="font-medium text-nc-text">四策略核心组合 (core-4)</p>
            <p className="mt-1 text-nc-text-3">
              组合模式固定为 4 分仓等权、跨分仓合计最多 10 个持仓、单票上限
              10%。「0.5% 容量裁剪」情景按日成交额在分仓间共享容量。
            </p>
          </div>
        )}

        {(runMode === "custom" || runMode === "core-4") && (
          <label className="block text-sm">
            分仓调配（bookControl）
            <select
              className="mt-1 block"
              value={draft.bookControl ?? "none"}
              onChange={(event) => {
                const value = event.target.value;
                if (
                  value === "none" ||
                  value === "equal-month-end" ||
                  value === "risk-parity-60"
                )
                  edit({ bookControl: value });
              }}
            >
              <option value="none">固定初始权重</option>
              <option value="equal-month-end">月末等权</option>
              <option value="risk-parity-60">60 日协方差风险平价</option>
            </select>
          </label>
        )}
        <RiskPolicyFields
          value={draft.riskPolicy}
          onChange={(riskPolicy) => edit({ riskPolicy })}
        />
      </StudioStep>
      <StudioStep title="5. 成本与执行">
        <div className="grid gap-2 sm:grid-cols-2">
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
                  edit({ costScenario: value });
              }}
            >
              <SelectTrigger
                aria-label="诊断成本情景"
                className="mt-1 max-w-full"
              >
                <SelectValue placeholder="选择成本情景" />
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
          <label className="block text-sm">
            执行方式
            <select
              className="mt-1 block w-full"
              value={effectiveSubmission}
              disabled={
                autoStart ||
                runMode === "per-symbol" ||
                !!draft.archive ||
                draft.poolId === "core-5" ||
                draft.poolId === "chan-core-7"
              }
              onChange={(event) =>
                setSubmission(
                  event.target.value === "studio" ? "studio" : "archive",
                )
              }
            >
              <option value="studio">工作室成本敏感性</option>
              <option value="archive">成组情景诊断（写入本地归档）</option>
            </select>
          </label>
        </div>
        <fieldset className="space-y-1.5 rounded-lg border border-nc-border-soft px-3 py-2">
          <legend className="px-1 text-sm text-nc-text-3">时间留出验证</legend>
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={includeHoldout ?? "indeterminate"}
              onCheckedChange={(value) =>
                edit({ includeHoldout: value === true })
              }
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
              onChange={(event) => edit({ holdoutStart: event.target.value })}
            />
          </label>
          <p className="text-sub text-nc-text-4">
            历史留出复核，不宣称新鲜样本外收益；默认切点 {defaultHoldoutStart}。
          </p>
        </fieldset>

        {effectiveSubmission === "archive" && (
          <>
            <fieldset className="space-y-1.5">
              <legend className="text-sm text-nc-text-3">执行情景</legend>
              <div className="flex flex-wrap gap-3">
                {scenarioOptions.map((option) => (
                  <label
                    key={option.id}
                    className="flex items-center gap-2 text-sm"
                  >
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
                onCheckedChange={(value) => edit({ confirmed: value === true })}
                className="mt-0.5"
              />
              确认以诊断专用只读/记录口径运行（不影响常规回测默认）
            </label>
          </>
        )}
        <FrozenJson
          value={effectiveSubmission === "studio" ? studioInput : rawRun}
        />
      </StudioStep>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          disabled={
            run.isPending ||
            awaitingResult ||
            studioBusy ||
            (effectiveSubmission === "archive" && !confirmed) ||
            (runMode === "custom" && !sleeveValidation.book)
          }
          aria-busy={run.isPending || (awaitingResult && !result.isError)}
        >
          {run.isPending
            ? "正在创建诊断任务…"
            : running
              ? "诊断运行中…"
              : awaitingResult
                ? "等待诊断状态"
                : effectiveSubmission === "archive"
                  ? "运行成组情景诊断"
                  : "运行研究回测"}
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
    </form>
  );
}
