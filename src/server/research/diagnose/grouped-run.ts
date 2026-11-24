import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { Settings } from "~/lib/domain";
import {
  DIAGNOSE_CHECK_GROUPS,
  DIAGNOSE_SAMPLE_LIMIT,
  DIAGNOSE_SCENARIO_PRESETS,
  labDiagnoseRunInputSchema,
  type DiagnoseArchiveDetail,
  type DiagnoseArchiveSummary,
  type DiagnoseScenarioCellGroup,
  type DiagnoseScenarioId,
  type DiagnoseScenarioMetrics,
  type LabDiagnoseRunInput,
} from "~/lib/research/diagnose-contract";
import { settings } from "../../infra/settings";
import {
  classifyArchiveBoundary,
  publishDiagnoseArchive,
  stageDiagnoseArchive,
} from "./archive";
import {
  classifyError,
  prepareDiagnoseCell,
  replayDiagnoseCell,
  type DiagnosePreparationOptions,
} from "./cell";
import { isStrategyKey, type PlannedDiagnoseCell } from "./strategy-specs";
import { emptyCounts } from "./types";

export type GroupedDiagnoseOptions = DiagnosePreparationOptions & {
  signal?: AbortSignal;
  onProgress?: (progress: number, phase: string) => void;
  config?: Settings;
  archiveDir?: string;
  stagingDir?: string;
  jobId?: string;
  beforePublish?: () => void;
};

type CellReplay = ReturnType<typeof replayDiagnoseCell>;
function capacityCoverage({ frozen, replay }: CellReplay) {
  if (!frozen.maxParticipation) return { capacityActive: false };
  const invalid = new Map<string, Set<string>>();
  let eligible = 0;
  let missing = 0;
  for (const { symbol, bars } of frozen.request.instruments) {
    const missingDates = new Set<string>();
    invalid.set(symbol, missingDates);
    for (const bar of bars) {
      if (bar.date < frozen.request.start || bar.date > frozen.request.end)
        continue;
      if (Number.isFinite(bar.amount) && bar.amount > 0) eligible++;
      else {
        missingDates.add(bar.date);
        missing++;
      }
    }
  }
  if (!missing) return { capacityActive: eligible > 0 };
  const { fills, rejections } = replay.result;
  const uncovered = fills.filter((fill) =>
    invalid.get(fill.symbol)?.has(fill.date),
  ).length;
  const constrained = rejections.some((row) =>
    row.reason.includes("参与率上限"),
  );
  const active =
    eligible > 0 && (!fills.length || uncovered < fills.length || constrained);
  return {
    capacityActive: active,
    capacityNote: `窗口内 ${missing} 根行情成交额缺失或非正，${uncovered} 笔成交未应用参与率上限。`,
  };
}

function profileMetrics(id: DiagnoseScenarioId) {
  const preset = DIAGNOSE_SCENARIO_PRESETS[id];
  return {
    scenarioId: id,
    label: preset.label,
    executionProfile: preset.executionProfile,
    maxParticipation:
      "maxParticipation" in preset ? preset.maxParticipation : null,
    capacityPolicy: "capacityPolicy" in preset ? preset.capacityPolicy : null,
  };
}

function replayMetrics(
  id: DiagnoseScenarioId,
  result: CellReplay,
): DiagnoseScenarioMetrics {
  const { replay, diagnostics, disclosures, reasons } = result;
  return {
    ...profileMetrics(id),
    ...diagnostics,
    ...disclosures,
    ...capacityCoverage(result),
    rejectionReasons: reasons,
    totalFees: replay.result.fills.reduce((sum, fill) => sum + fill.fee, 0),
    totalReturn: replay.overview.totalReturn.value,
    maxDrawdown: replay.overview.maxDrawdown.value,
    inputHash: replay.inputHash,
    timingStatus: replay.timingStatus,
    sampleOrders: replay.result.orders.slice(0, DIAGNOSE_SAMPLE_LIMIT),
    sampleFills: replay.result.fills.slice(0, DIAGNOSE_SAMPLE_LIMIT),
    sampleRejections: replay.result.rejections.slice(0, DIAGNOSE_SAMPLE_LIMIT),
  };
}

function errorMetrics(
  id: DiagnoseScenarioId,
  error: unknown,
): DiagnoseScenarioMetrics {
  const { status, layer } = classifyError(error);
  const message = error instanceof Error ? error.message : String(error);
  return {
    ...profileMetrics(id),
    status,
    layer,
    error: message,
    counts: emptyCounts(),
    rejectionReasons: [],
    totalFees: null,
    totalReturn: null,
    maxDrawdown: null,
    capacityActive: false,
    ...(id === "cap-0.5-clip" && {
      capacityNote: "回放未完成，容量约束无法评估。",
    }),
    checks: Object.keys(DIAGNOSE_CHECK_GROUPS).map((checkId) => ({
      id: checkId,
      status: status === "blocked" ? "blocked" : "not-evaluated",
      message,
    })),
    findings: [message],
    sampleOrders: [],
    sampleFills: [],
    sampleRejections: [],
  };
}

async function replayGroup(
  item: PlannedDiagnoseCell,
  input: LabDiagnoseRunInput,
  options: GroupedDiagnoseOptions,
): Promise<DiagnoseScenarioCellGroup> {
  const { signal, onProgress } = options;
  onProgress?.(2, "冻结行情、价格依据与策略输入");
  signal?.throwIfAborted();
  let prepared: Awaited<ReturnType<typeof prepareDiagnoseCell>> | undefined;
  let preparationError: unknown;
  try {
    prepared = await prepareDiagnoseCell(item, {
      ...options,
      start: input.start,
      end: input.end,
      initial: input.initial,
      config: options.config ?? settings(),
      cost: input.costScenario,
      riskPerTrade: 0.02,
      maxPositions: item.symbols.length,
    });
  } catch (error) {
    signal?.throwIfAborted();
    preparationError = error;
  }
  const metrics: DiagnoseScenarioMetrics[] = [];
  for (const [index, id] of input.scenarios.entries()) {
    // Replays are synchronous. Yield so a pending cancellation can reach the
    // job between scenarios, including between the final replay and publish.
    await setImmediate();
    signal?.throwIfAborted();
    onProgress?.(
      30 + Math.floor((index / input.scenarios.length) * 65),
      `回放 ${DIAGNOSE_SCENARIO_PRESETS[id].label}`,
    );
    signal?.throwIfAborted();
    if (!prepared) {
      metrics.push(errorMetrics(id, preparationError));
      continue;
    }
    try {
      const result = replayDiagnoseCell(
        prepared,
        {
          maxParticipation: null, // Disable the book's implicit cap on strict/clamp.
          ...DIAGNOSE_SCENARIO_PRESETS[id],
          holdoutStart: input.includeHoldout ? input.holdoutStart : undefined,
        },
        signal,
      );
      metrics.push(replayMetrics(id, result));
    } catch (error) {
      signal?.throwIfAborted();
      metrics.push(errorMetrics(id, error));
    }
  }
  return {
    strategyKey: item.strategy,
    symbols: item.symbols,
    mode: item.mode,
    start: prepared?.frozen.request.start ?? input.start,
    end: input.end,
    scenarios: metrics,
  };
}

export async function runGroupedDiagnoseScenarios(
  input: LabDiagnoseRunInput,
  options: GroupedDiagnoseOptions = {},
): Promise<DiagnoseArchiveDetail> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();
  const params = labDiagnoseRunInputSchema.parse(input);
  const {
    strategyKey,
    symbols,
    scenarios,
    mode = symbols.length > 1 ? "portfolio" : "per-symbol",
  } = params;
  if (strategyKey !== "core-4" && !isStrategyKey(strategyKey))
    throw new Error(`未知诊断策略：${strategyKey}`);
  const groups =
    mode === "portfolio" ? [symbols] : symbols.map((symbol) => [symbol]);
  const cells: DiagnoseScenarioCellGroup[] = [];
  for (const [index, group] of groups.entries()) {
    cells.push(
      await replayGroup(
        { strategy: strategyKey, symbols: group, mode },
        params,
        {
          ...options,
          onProgress(progress, phase) {
            onProgress?.(
              Math.floor((index * 98 + progress) / groups.length),
              phase,
            );
          },
        },
      ),
    );
  }
  const metrics = cells.flatMap((cell) => cell.scenarios);
  const statusCounts = { ok: 0, blocked: 0, failed: 0, zeroSignal: 0 };
  for (const scenario of metrics) {
    statusCounts[scenario.status]++;
    if (scenario.status === "ok" && scenario.counts.signals === 0)
      statusCounts.zeroSignal++;
  }
  const summary: DiagnoseArchiveSummary = {
    id: `lab-${options.jobId ?? randomUUID()}`,
    source: "lab-archive",
    title: `${strategyKey} · ${symbols.join("、")}`,
    generatedAt: new Date().toISOString(),
    ...(params.bookPreset && { bookPreset: params.bookPreset }),
    ...(params.includeHoldout && { holdoutStart: params.holdoutStart }),
    strategyKeys: [strategyKey],
    symbols,
    scenarios,
    statusCounts,
    missingFiles: [],
    driftWarnings: metrics.some((m) => m.timingStatus === "drift")
      ? ["策略构建身份已变化"]
      : [],
  };
  const detail: DiagnoseArchiveDetail = {
    summary,
    cells,
    pagination: { page: 1, pageSize: cells.length, totalCells: cells.length },
    boundaryState: classifyArchiveBoundary(summary),
  };
  onProgress?.(98, "写入诊断归档");
  await setImmediate();
  signal?.throwIfAborted();
  if (options.stagingDir !== undefined)
    await stageDiagnoseArchive(detail, options.stagingDir, options);
  else await publishDiagnoseArchive(detail, options);
  return detail;
}

export function diagnoseWorkerResult({
  summary,
  boundaryState,
}: DiagnoseArchiveDetail) {
  return {
    archiveId: summary.id,
    title: summary.title,
    strategyKeys: summary.strategyKeys,
    symbols: summary.symbols,
    scenarios: summary.scenarios,
    statusCounts: summary.statusCounts,
    boundaryState,
    driftWarningsCount: summary.driftWarnings.length,
    missingFilesCount: summary.missingFiles.length,
  };
}
export type LabDiagnoseWorkerResult = ReturnType<typeof diagnoseWorkerResult>;
