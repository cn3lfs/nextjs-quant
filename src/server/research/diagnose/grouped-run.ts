import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import type { Settings } from "~/lib/domain";
import {
  DIAGNOSE_CHECK_GROUPS,
  DIAGNOSE_SAMPLE_LIMIT,
  DIAGNOSE_SCENARIO_PRESETS,
  diagnoseSessionEvidenceSchema,
  diagnoseScenarioMetricsSchema,
  type DiagnoseBookSleeve,
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
  diagnoseArchiveSidecar,
  publishDiagnoseArchive,
  stageDiagnoseArchive,
} from "./archive";
import {
  classifyError,
  prepareDiagnoseCell,
  replayDiagnoseCell,
  type DiagnosePreparationOptions,
} from "./cell";
import {
  buildStrategy,
  DIAGNOSE_BOOK_PRESETS,
  isStrategyKey,
  warmupBarsFor,
  type PlannedDiagnoseCell,
} from "./strategy-specs";
import {
  BENCHMARK_CALENDAR_SYMBOL,
  prepareDiagnoseRequest,
} from "./prepare-request";
import { readBars } from "../../market/bar-store/read-bars";
import { BarResourceBudget } from "../../market/bar-store/resource-budget";
import { runDiagnoseTimeHoldout } from "./time-holdout";
import type { StrategyDisclosures } from "./types";
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
type ParsedRun = ReturnType<typeof labDiagnoseRunInputSchema.parse>;
type PreparedCell = Awaited<ReturnType<typeof prepareDiagnoseCell>>;

// Use the same request builder and replay engine as the CLI core-4 book.
async function prepareCustomBook(
  definitions: DiagnoseBookSleeve[],
  input: ParsedRun,
  options: Parameters<typeof prepareDiagnoseCell>[1],
): Promise<PreparedCell> {
  const { symbols, end, initial, costScenario } = input;
  const { config, riskPerTrade, maxPositions, signal } = options;
  const legs = definitions.map(({ id, strategyKey, share }, index) => {
    if (!isStrategyKey(strategyKey))
      throw new Error(`未知诊断策略：${strategyKey}`);
    const strategy = buildStrategy(strategyKey, symbols, "portfolio");
    // Each strategy instance needs its own ledger identity, including repeated rules.
    if (
      definitions.some((s, i) => i !== index && s.strategyKey === strategyKey)
    )
      strategy.id = `diag-${strategyKey}-${index + 1}`;
    strategy.sleeve = id;
    return { strategy, strategyKey, share, warmup: warmupBarsFor(strategyKey) };
  });
  const total = legs.reduce((sum, leg) => sum + leg.share, 0);
  let start = input.start;
  const load = options.read ?? readBars;
  const prefetched = new Map<string, Awaited<ReturnType<typeof load>>>();
  const read: typeof load = (q, ...rest) =>
    Promise.resolve(
      prefetched.get(JSON.stringify([q.instrument.symbol, q.to])) ??
        load(q, ...rest),
    );
  if (start === "auto") {
    const budget = new BarResourceBudget();
    const warmup = Math.max(...legs.map((leg) => leg.warmup));
    const readyDates: string[] = [];
    for (const symbol of symbols) {
      signal?.throwIfAborted();
      const snapshot = await load(
        {
          instrument: { market: "cn-equity", symbol },
          period: "day",
          adjustment: "none",
          root: config.tdxRoot,
          source: "local",
          freezeRaw: true,
          to: end,
          live: false,
        },
        undefined,
        undefined,
        budget,
      );
      prefetched.set(JSON.stringify([symbol, end]), snapshot);
      const date = (snapshot.rawBars ?? snapshot.bars)[warmup]?.date;
      if (date) readyDates.push(date);
    }
    const benchmark = await load({
      instrument: { market: "cn-equity", symbol: BENCHMARK_CALENDAR_SYMBOL },
      period: "day",
      adjustment: "none",
      root: config.tdxRoot,
      live: false,
    });
    prefetched.set(
      JSON.stringify([BENCHMARK_CALENDAR_SYMBOL, undefined]),
      benchmark,
    );
    const earliest = readyDates.sort()[0];
    const aligned =
      earliest && benchmark.bars.find((bar) => bar.date >= earliest)?.date;
    if (!aligned || aligned >= end)
      throw new Error(`缺少满足 ${warmup} 根预热行情的组合交易日`);
    start = aligned;
  }
  const policy = DIAGNOSE_BOOK_PRESETS["core-4"];
  const strategyConfig = legs[0]!.strategy;
  const {
    calendar,
    frozen,
    dataQuality,
    benchmarkBars,
    suspensionCertificates,
    ...attached
  } = await prepareDiagnoseRequest({
    ...options,
    read,
    start,
    end,
    initial,
    costScenario,
    strategy: strategyConfig,
    additionalStrategies: legs.slice(1).map((leg) => leg.strategy),
    sleeves: legs.map(({ strategy, share }) => ({
      id: strategy.sleeve,
      share: share / total,
      riskPerTrade,
      maxPositions,
    })),
    accountMaxUniqueSymbols: policy.accountMaxUniqueSymbols,
    accountMaxSymbolWeight: policy.accountMaxSymbolWeight,
    collectDailyDecisionCounts: true,
    executionProfile: "strict",
    forceCausalPrice: true,
    perInstrumentWarmup: true,
  });
  const disclosures: StrategyDisclosures = attached;
  const memberships: NonNullable<typeof frozen.request.memberships>[number][] =
    [];
  disclosures.portfolioEligibility = legs.flatMap(({ strategy, warmup }) => {
    const rows = frozen.request.instruments.map(({ symbol, signalBars }) => ({
      strategyId: strategy.id,
      symbol,
      warmupBars: warmup,
      firstBar: signalBars[0]?.date ?? null,
      readyDate: signalBars[warmup]?.date ?? null,
    }));
    for (const date of calendar) {
      const ready = rows.filter(
        (row) => row.readyDate && row.readyDate <= date,
      );
      if (ready.length < rows.length)
        memberships.push({
          strategyId: strategy.id,
          date,
          availableAt: date,
          symbols: ready.map((row) => row.symbol),
        });
    }
    return rows;
  });
  if (memberships.length) frozen.request.memberships = memberships;
  // Cache timing belongs to the archive evidence, outside the scientific input hash.
  for (const {
    cached: _cached,
    captureElapsedMs: _elapsed,
    cacheLoadMs: _load,
    ...identity
  } of disclosures.nativeChan ?? []) {
    const source = frozen.sources.find((s) => s.symbol === identity.symbol);
    if (!source || !identity.strategyKey) continue;
    source.nativeChanByStrategy = {
      ...(source.nativeChanByStrategy as Record<string, unknown>),
      [identity.strategyKey]: identity,
    };
    delete source.nativeChan;
  }
  return {
    frozen,
    disclosures,
    dataQuality,
    benchmarkBars,
    suspensionCertificates,
    excludedSymbols: [],
    strategyConfig,
    candidateId: legs[0]!.strategyKey,
    bookCapacity: policy,
  };
}

type SuspensionDates = {
  pairs: Set<string>;
  affected: Set<string>;
  unknown: Set<string>;
  unknownComplete: boolean;
};
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
  dates: SuspensionDates,
): DiagnoseScenarioMetrics {
  const { replay, diagnostics, disclosures, reasons } = result;
  const decisions = replay.result.dailyDecisionCounts;
  const unknown = new Set<string>();
  for (const row of decisions ?? []) {
    for (const symbol of row.suspendedSymbols ?? []) {
      dates.pairs.add(symbol + "/" + row.date);
      dates.affected.add(row.date);
    }
    if (row.unknown) {
      dates.unknown.add(row.date);
      unknown.add(row.date);
    }
  }
  if (!decisions?.length) dates.unknownComplete = false;
  const orderById = new Map(
    replay.result.orders.map((order) => [order.id, order]),
  );
  const sessionEvidence =
    disclosures.suspensionEvidence &&
    diagnoseSessionEvidenceSchema.parse({
      ...disclosures.suspensionEvidence,
      ...(decisions?.length && { unknownDays: unknown.size }),
    });
  return diagnoseScenarioMetricsSchema.parse({
    ...profileMetrics(id),
    ...diagnostics,
    ...disclosures,
    sessionEvidence,
    ...capacityCoverage(result),
    rejectionReasons: reasons,
    totalFees: replay.result.fills.reduce((sum, fill) => sum + fill.fee, 0),
    totalReturn: replay.overview.totalReturn.value,
    maxDrawdown: replay.overview.maxDrawdown.value,
    inputHash: replay.inputHash,
    timingStatus: replay.timingStatus,
    sampleOrders: replay.result.orders.slice(0, DIAGNOSE_SAMPLE_LIMIT),
    sampleFills: replay.result.fills
      .slice(0, DIAGNOSE_SAMPLE_LIMIT)
      .map((fill) => ({
        ...fill,
        trigger: orderById.get(fill.orderId)?.trigger,
      })),
    sampleRejections: replay.result.rejections.slice(0, DIAGNOSE_SAMPLE_LIMIT),
  });
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
  item: Omit<PlannedDiagnoseCell, "strategy"> & { strategy: string },
  input: ParsedRun,
  options: GroupedDiagnoseOptions,
  dates: SuspensionDates,
): Promise<DiagnoseScenarioCellGroup> {
  const { signal, onProgress } = options;
  onProgress?.(2, "冻结行情、价格依据与策略输入");
  signal?.throwIfAborted();
  let prepared: Awaited<ReturnType<typeof prepareDiagnoseCell>> | undefined;
  let preparationError: unknown;
  const prefixFractions = new Map<string, number>();
  let lastProgressAt = -Infinity;
  try {
    const preparation: Parameters<typeof prepareDiagnoseCell>[1] = {
      ...options,
      nativeProgress(symbol, done, total) {
        options.nativeProgress?.(symbol, done, total);
        const now = performance.now();
        if (done !== 1 && done !== total && now - lastProgressAt < 500) return;
        lastProgressAt = now;
        prefixFractions.set(symbol, done / total);
        const captured = [...prefixFractions.values()].reduce(
          (a, b) => a + b,
          0,
        );
        onProgress?.(
          2 + Math.floor((27 * captured) / item.symbols.length),
          `原生缠论前缀 ${symbol} ${done}/${total}`,
        );
      },
      start: input.start,
      end: input.end,
      initial: input.initial,
      config: options.config ?? settings(),
      cost: input.costScenario,
      riskPerTrade: 0.02,
      maxPositions: item.symbols.length,
    };
    if (input.book && "sleeves" in input.book)
      prepared = await prepareCustomBook(
        input.book.sleeves,
        input,
        preparation,
      );
    else if (item.strategy === "core-4" || isStrategyKey(item.strategy))
      prepared = await prepareDiagnoseCell(
        { ...item, strategy: item.strategy },
        preparation,
      );
    else throw new Error(`未知诊断策略：${item.strategy}`);
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
        },
        signal,
      );
      if (input.includeHoldout)
        result.disclosures.timeHoldout = runDiagnoseTimeHoldout(
          result.frozen.request,
          {
            holdoutStart: input.holdoutStart,
            candidateId: item.strategy,
            benchmark: prepared.benchmarkBars,
            signal,
          },
        );
      metrics.push(replayMetrics(id, result, dates));
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
  if (!params.book && !isStrategyKey(strategyKey))
    throw new Error(`未知诊断策略：${strategyKey}`);
  const strategies = params.book
    ? ("preset" in params.book
        ? DIAGNOSE_BOOK_PRESETS[params.book.preset].sleeves
        : params.book.sleeves
      ).map((s) => s.strategyKey)
    : [strategyKey];
  if (
    params.strategies &&
    (params.strategies.length !== strategies.length ||
      params.strategies.some((key, i) => key !== strategies[i]))
  )
    throw new Error("归档复跑策略与分仓定义不一致");
  const groups =
    mode === "portfolio" ? [symbols] : symbols.map((symbol) => [symbol]);
  const cells: DiagnoseScenarioCellGroup[] = [];
  const dates: SuspensionDates = {
    pairs: new Set(),
    affected: new Set(),
    unknown: new Set(),
    unknownComplete: true,
  };
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
        dates,
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
    book: params.book,
    run: {
      mode,
      symbols,
      strategyKey,
      strategies,
      book: params.book,
      start: params.start,
      end: params.end,
      initial: params.initial,
      costScenario: params.costScenario,
      scenarios,
      includeHoldout: params.includeHoldout,
      holdoutStart: params.holdoutStart,
    },
    ...(metrics.every((m) => m.sessionEvidence) && {
      suspensionSummary: {
        symbolSuspensionDays: dates.pairs.size,
        portfolioAffectedDays: dates.affected.size,
        ...(dates.unknownComplete && { unknownDays: dates.unknown.size }),
      },
    }),
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

export function diagnoseWorkerResult(detail: DiagnoseArchiveDetail) {
  const { summary, boundaryState } = detail;
  return {
    receipt: {
      archiveId: summary.id,
      title: summary.title,
      strategyKeys: summary.strategyKeys,
      symbols: summary.symbols,
      scenarios: summary.scenarios,
      statusCounts: summary.statusCounts,
      boundaryState,
      driftWarningsCount: summary.driftWarnings.length,
      missingFilesCount: summary.missingFiles.length,
    },
    sidecar: diagnoseArchiveSidecar(detail),
  };
}
export type LabDiagnoseWorkerResult = ReturnType<typeof diagnoseWorkerResult>;
