import type { PortfolioExecution, PortfolioInstrument } from "quant-backtest";
import { isWyckoffStudy, wyckoffStudyBindings } from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import type { ResearchCostScenario } from "trading-strategy-core/costs";
import type { Settings } from "~/lib/domain";
import { readBars } from "../../market/bar-store/read-bars";
import { BarResourceBudget } from "../../market/bar-store/resource-budget";
import {
  replayLabBacktest,
  type FrozenLabBacktest,
  type LabExecutionProfile,
} from "../lab-backtest";
import { runDiagnostics } from "./diagnostics";
import {
  readGrowthMarketBars,
  isSepaVcpCloseStrategyKey,
  type GrowthPitSignalOptions,
} from "./growth-pit";
import {
  BENCHMARK_CALENDAR_SYMBOL,
  prepareDiagnoseRequest,
} from "./prepare-request";
import {
  buildDiagnoseCellStrategies,
  DIAGNOSE_BOOK_PRESETS,
  isPitStrategyKey,
  isNativeStrategyKey,
  isWyckoffFunnelKey,
  warmupBarsFor,
  type PlannedDiagnoseCell,
  type StrategyKey,
} from "./strategy-specs";
import type { NativeChanOptions } from "./chan-native";
import type {
  BookControl,
  DiagnoseLayer,
  DiagnoseStatus,
  StrategyDisclosures,
} from "./types";
import { analyzeWyckoffFunnel } from "./wyckoff-funnel";
import { summarizePortfolioSuspensions } from "../lifecycle-score";
import {
  buildMonthEndEqualRebalanceTargets,
  buildCausalRiskParity60Targets,
  computeSleeveTradeMetrics,
} from "./sleeve-trades";
import { computeSleeveAttribution } from "./sleeve-attribution";
import { runDiagnoseTimeHoldout } from "./time-holdout";
type ReplayReturn = ReturnType<typeof replayLabBacktest>;
export function classifyError(error: unknown): {
  status: DiagnoseStatus;
  layer: DiagnoseLayer;
} {
  const message = error instanceof Error ? error.message : String(error);
  if (/GBBQ|公司行动|配股|除权|warrant|权证|entitlement/i.test(message))
    return { status: "blocked", layer: "gbbq" };
  if (/因果|复权|价格基|price basis/i.test(message))
    return { status: "blocked", layer: "causal-price" };
  // Native Chan warmup/portfolio shortages are input limits, not engine bugs.
  if (/原生缠论需要至少|原生缠论组合模式/i.test(message))
    return { status: "blocked", layer: "data" };
  // Native evidence, DLL or causal integrity violations are engine failures.
  // They must be classified before the generic data matcher, whose "超出"
  // pattern would otherwise turn them into allowlisted blocked/data cells.
  if (
    /原生观察|原生DLL|原生信号重复|原生结构|回放期间原生|原生缠论策略缺少|Missing serial native observations/i.test(
      message,
    )
  )
    return { status: "failed", layer: "internal" };
  // The growth PIT strategy is our own external-signal wiring; a missing daily
  // signal series is an engine/wiring failure, not an allowlisted data limit.
  if (/外部时点策略缺少逐日信号输入/.test(message))
    return { status: "failed", layer: "internal" };
  if (
    /行情|数据|日历|缺少|缺失|无交易日|超出|未对齐|停牌|原价|Invalid portfolio|Invalid strategy bars|Raw \/ signal|基准日历/i.test(
      message,
    )
  )
    return { status: "blocked", layer: "data" };
  return { status: "failed", layer: "internal" };
}

type BarCache = Map<string, Bar[]>;

async function loadDaily(
  tdxRoot: string,
  end: string,
  symbol: string,
  cache: BarCache,
): Promise<Bar[]> {
  const cached = cache.get(symbol);
  if (cached) return cached;
  const snapshot = await readBars({
    instrument: { market: "cn-equity", symbol },
    root: tdxRoot,
    period: "day",
    adjustment: "none",
    to: end,
    live: false,
  });
  cache.set(symbol, snapshot.bars);
  return snapshot.bars;
}

/** Advance a start date to the benchmark's next trading day when absent. */
async function alignToBenchmark(
  date: string,
  tdxRoot: string,
  end: string,
  cache: BarCache,
) {
  const calendar = await loadDaily(
    tdxRoot,
    end,
    BENCHMARK_CALENDAR_SYMBOL,
    cache,
  );
  if (calendar.some((bar) => bar.date === date)) return date;
  const next = calendar.find((bar) => bar.date > date)?.date;
  if (!next)
    throw new Error(
      `基准日历 ${BENCHMARK_CALENDAR_SYMBOL} 在 ${date} 之后无交易日`,
    );
  return next;
}

export async function resolveAutoStart(
  key: PlannedDiagnoseCell["strategy"],
  symbols: readonly string[],
  mode: "per-symbol" | "portfolio",
  tdxRoot: string,
  end: string,
  cache: BarCache,
) {
  const warmup =
    key === "core-4"
      ? Math.max(
          ...DIAGNOSE_BOOK_PRESETS[key].sleeves.map((s) =>
            warmupBarsFor(s.strategyKey),
          ),
        )
      : warmupBarsFor(key);
  const series = await Promise.all(
    symbols.map((symbol) => loadDaily(tdxRoot, end, symbol, cache)),
  );
  if (mode === "portfolio") {
    const required =
      symbols.length === 1 && key !== "core-4" && !isNativeStrategyKey(key)
        ? 0
        : warmup;
    const ready = series.flatMap((bars) => bars[required]?.date ?? []).sort();
    if (!ready.length)
      throw new Error(`组合没有满足 ${required} 根预热行情的标的`);
    const start = await alignToBenchmark(ready[0]!, tdxRoot, end, cache);
    if (start >= end)
      throw new Error(`自动起始日 ${start} 不早于结束日 ${end}`);
    return start;
  }
  const reference = series[0]!;
  if (!reference?.length) throw new Error("自动起始日缺少本地日线");
  const index = Math.min(warmup, reference.length - 1);
  const start = reference[index]!.date;
  if (!start) throw new Error("自动起始日解析失败");
  if (start >= end) throw new Error(`自动起始日 ${start} 不早于结束日 ${end}`);
  return start;
}

function rejectionReasons(replay: ReplayReturn) {
  const counts = new Map<string, number>();
  for (const rejection of replay.result.rejections)
    counts.set(rejection.reason, (counts.get(rejection.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count);
}

export type DiagnosePreparationOptions = Pick<
  NativeChanOptions,
  | "nativeCacheDir"
  | "captureNative"
  | "project"
  | "resolveIdentity"
  | "nativeProgress"
> &
  Pick<GrowthPitSignalOptions, "indexBars" | "readFinancialHistory"> & {
    read?: typeof readBars;
  };
export type DiagnoseMarketCache = { marketBars?: readonly Bar[] };
type CellInput = DiagnosePreparationOptions & {
  config: Settings;
  start: string;
  end: string;
  initial: number;
  cost: ResearchCostScenario;
  riskPerTrade: number;
  maxPositions: number;
  /** Original end date, used only to confirm a post-cut listing on a development retry. */
  retryFullEnd?: string;
  signal?: AbortSignal;
};

/** Auto-start needs dates before Lab can validate the request. Reuse the very
 * same raw/adjusted snapshot in Lab so date selection and replay see one read. */
export async function prepareDiagnoseCell(
  item: PlannedDiagnoseCell,
  input: CellInput,
  market: DiagnoseMarketCache = {},
  prepare = prepareDiagnoseRequest,
) {
  const { strategy, symbols } = item;
  const { tdxRoot } = input.config;
  const strategies = buildDiagnoseCellStrategies(item);
  const strategyConfig = strategies[0]!;
  const book =
    strategy === "core-4" ? DIAGNOSE_BOOK_PRESETS[strategy] : undefined;
  const keys: readonly StrategyKey[] =
    strategy === "core-4"
      ? DIAGNOSE_BOOK_PRESETS[strategy].sleeves.map((s) => s.strategyKey)
      : [strategy];
  const forceCausalPrice = strategy !== "hold";
  const prefetched = new Map<string, Awaited<ReturnType<typeof readBars>>>();
  const read: typeof readBars = (query, ...rest) => {
    const key = JSON.stringify([
      query.instrument.symbol,
      query.adjustment,
      query.to,
    ]);
    const snapshot = prefetched.get(key);
    return snapshot
      ? Promise.resolve(snapshot)
      : (input.read ?? readBars)(query, ...rest);
  };
  let start = input.start;
  const excludedSymbols: string[] = [];
  if (start === "auto" || input.retryFullEnd) {
    const cache: BarCache = new Map();
    const budget = new BarResourceBudget();
    async function prefetch(
      symbol: string,
      benchmark: boolean,
      end = input.end,
    ) {
      input.signal?.throwIfAborted();
      const adjustment = benchmark || forceCausalPrice ? "none" : "forward";
      const query = {
        instrument: { market: "cn-equity", symbol },
        period: "day",
        adjustment,
        root: tdxRoot,
        ...(benchmark ? {} : { to: end }),
        live: false,
        ...(benchmark ? {} : { source: "local" as const, freezeRaw: true }),
      } as const;
      const snapshot = await (input.read ?? readBars)(
        query,
        undefined,
        undefined,
        budget,
      );
      prefetched.set(JSON.stringify([symbol, adjustment, query.to]), snapshot);
      return snapshot.rawBars ?? snapshot.bars;
    }
    for (const symbol of symbols) {
      let prefixError: unknown;
      const bars = await prefetch(symbol, false).catch((error: unknown) => {
        if (!input.retryFullEnd) throw error;
        prefixError = error;
        return [];
      });
      cache.set(symbol, bars);
      if (input.retryFullEnd && !bars.some((b) => b.date <= input.end)) {
        const full = await prefetch(symbol, false, input.retryFullEnd);
        if (!full.length || full.some((bar) => bar.date <= input.end))
          throw prefixError ?? new Error(`${symbol}：无法核实开发段行情覆盖`);
        excludedSymbols.push(symbol);
      }
    }
    if (excludedSymbols.length) {
      const retained = symbols.filter(
        (symbol) => !excludedSymbols.includes(symbol),
      );
      if (!retained.length)
        throw new Error(`开发段全部标的无行情：${excludedSymbols.join(", ")}`);
      for (const strategy of strategies)
        strategy.universe = { kind: "symbols", symbols: retained };
    }
    if (start === "auto") {
      if (item.mode === "portfolio" && !cache.has(BENCHMARK_CALENDAR_SYMBOL))
        cache.set(
          BENCHMARK_CALENDAR_SYMBOL,
          await prefetch(BENCHMARK_CALENDAR_SYMBOL, true),
        );
      start = await resolveAutoStart(
        strategy,
        symbols,
        item.mode,
        tdxRoot,
        input.end,
        cache,
      );
    }
  }

  if (
    input.indexBars === undefined &&
    keys.some(
      (key) =>
        isPitStrategyKey(key) &&
        !isSepaVcpCloseStrategyKey(key) &&
        key !== "research-canslim-pit" &&
        key !== "research-sepa-pit",
    )
  ) {
    market.marketBars ??= await readGrowthMarketBars(tdxRoot, input.end);
  }
  input.signal?.throwIfAborted();
  const {
    frozen,
    dataQuality,
    calendar: _calendar,
    benchmarkBars,
    suspensionCertificates,
    ...attached
  } = await prepare({
    config: input.config,
    strategy: strategyConfig,
    ...(book && {
      additionalStrategies: strategies.slice(1),
      sleeves: book.sleeves.map(({ id, share }) => ({
        id,
        share,
        riskPerTrade: input.riskPerTrade,
        maxPositions: input.maxPositions,
      })),
      accountMaxUniqueSymbols: book.accountMaxUniqueSymbols,
      accountMaxSymbolWeight: book.accountMaxSymbolWeight,
      collectDailyDecisionCounts: true,
    }),
    start,
    end: input.end,
    costScenario: input.cost,
    initial: input.initial,
    riskPerTrade: input.riskPerTrade,
    maxPositions: input.maxPositions,
    signal: input.signal,
    readFinancialHistory: input.readFinancialHistory,
    nativeCacheDir: input.nativeCacheDir,
    captureNative: input.captureNative,
    project: input.project,
    resolveIdentity: input.resolveIdentity,
    perInstrumentWarmup: item.mode === "portfolio" && symbols.length > 1,
    forceCausalPrice,
    read,
    indexBars: input.indexBars ?? market.marketBars,
    // All scenarios derive their execution settings from this single baseline.
    executionProfile: "strict",
    nativeProgress(symbol, done, total) {
      input.signal?.throwIfAborted();
      input.nativeProgress?.(symbol, done, total);
    },
  });
  input.signal?.throwIfAborted();
  const disclosures: StrategyDisclosures = attached;
  if (item.mode === "portfolio" && (symbols.length > 1 || book)) {
    const rows = frozen.request.instruments;
    const memberships: NonNullable<
      typeof frozen.request.memberships
    >[number][] = [];
    disclosures.portfolioEligibility = frozen.request.strategies.flatMap(
      (s, i) => {
        const warmupBars = warmupBarsFor(keys[i]!);
        const eligibility = rows.map(({ symbol, signalBars }) => ({
          strategyId: s.id,
          symbol,
          warmupBars,
          firstBar: signalBars[0]?.date ?? null,
          readyDate: signalBars[warmupBars]?.date ?? null,
        }));
        for (const date of frozen.request.calendar) {
          const ready = eligibility.filter(
            (row) => row.readyDate && row.readyDate <= date,
          );
          if (ready.length !== rows.length)
            memberships.push({
              strategyId: s.id,
              date,
              availableAt: date,
              symbols: ready.map((row) => row.symbol),
            });
        }
        return eligibility;
      },
    );
    if (memberships.length) frozen.request.memberships = memberships;
  }
  // Timing and cache hits describe the capture operation. Keep them in the
  // disclosures, outside the scientific input that replayLabBacktest hashes.
  for (const row of disclosures.nativeChan ?? []) {
    const source = frozen.sources.find((entry) => entry.symbol === row.symbol);
    if (!source) continue;
    const {
      cached: _cached,
      cacheLoadMs: _load,
      captureElapsedMs: _elapsed,
      ...identity
    } = row;
    if (row.strategyKey) {
      source.nativeChanByStrategy = {
        ...(source.nativeChanByStrategy as Record<string, unknown>),
        [row.strategyKey]: identity,
      };
      delete source.nativeChan;
    } else source.nativeChan = identity;
  }
  return {
    excludedSymbols,
    strategyConfig,
    candidateId: item.strategy,
    suspensionCertificates,
    benchmarkBars,
    frozen,
    dataQuality,
    disclosures,
    bookCapacity: book
      ? {
          maxParticipation: book.maxParticipation,
          capacityPolicy: book.capacityPolicy,
        }
      : undefined,
  };
}

type PreparedCell = Awaited<ReturnType<typeof prepareDiagnoseCell>>;
type ExecutionOptions = {
  bookControl?: BookControl;
  holdoutStart?: string;
  executionProfile?: LabExecutionProfile;
  maxParticipation?: number | null;
  capacityPolicy?: "clip" | "reject" | null;
};

function applyProfile(
  execution: PortfolioInstrument["execution"],
  policy: PortfolioExecution["slippagePolicy"],
) {
  if (typeof execution === "function")
    throw new Error("诊断需要已冻结的执行证据");
  if (typeof execution.evidence === "string")
    return { ...(execution as PortfolioExecution), slippagePolicy: policy };
  return Object.fromEntries(
    Object.entries(
      execution as Readonly<Record<string, PortfolioExecution>>,
    ).map(([date, fact]) => [date, { ...fact, slippagePolicy: policy }]),
  );
}

export function replayDiagnoseCell(
  base: PreparedCell,
  options: ExecutionOptions,
  signal?: AbortSignal,
) {
  const profile = options.executionProfile ?? "strict";
  const request = base.frozen.request;
  const maxParticipation =
    options.maxParticipation === null
      ? undefined
      : (options.maxParticipation ?? base.bookCapacity?.maxParticipation);
  const capacityPolicy =
    maxParticipation === undefined
      ? undefined
      : (options.capacityPolicy ??
        base.bookCapacity?.capacityPolicy ??
        undefined);
  // Keep every source in the frozen pool. Replay only executable instruments
  // when the native feed has no observation and no sleeve can trade that symbol.
  const inactive = new Set(
    base.disclosures.nativeChan
      ?.filter(
        (row) =>
          request.sleeves.length === 1 &&
          row.insufficientWarmup &&
          !base.disclosures.portfolioEligibility?.some(
            (member) =>
              member.symbol === row.symbol && member.readyDate !== null,
          ),
      )
      .map((row) => row.symbol),
  );
  const instruments = inactive.size
    ? request.instruments.filter((i) => !inactive.has(i.symbol))
    : request.instruments;
  const frozen: FrozenLabBacktest = {
    ...base.frozen,
    executionProfile: profile,
    maxParticipation: maxParticipation ?? null,
    capacityPolicy: capacityPolicy ?? null,
    request: {
      ...request,
      instruments:
        profile === "strict"
          ? instruments
          : instruments.map((instrument) => ({
              ...instrument,
              execution: applyProfile(
                instrument.execution,
                profile === "clamp" ? "clamp" : "none",
              ),
            })),
      ...(maxParticipation === undefined ? {} : { maxParticipation }),
      ...(capacityPolicy === undefined ? {} : { capacityPolicy }),
    },
  };
  const policy = options.bookControl ?? "none";
  if (request.sleeves.length > 1 && policy !== "none") {
    const baseline = frozen.request;
    const calendar = baseline.calendar.filter(
      (d) => d >= baseline.start && d <= baseline.end,
    );
    const targets =
      policy === "equal-month-end"
        ? buildMonthEndEqualRebalanceTargets(
            calendar,
            baseline.sleeves.map((s) => s.id),
          )
        : buildCausalRiskParity60Targets(
            calendar,
            computeSleeveAttribution(
              replayLabBacktest(frozen, undefined, signal).result,
            ),
            Object.fromEntries(baseline.sleeves.map((s) => [s.id, s.share])),
          );
    frozen.request = { ...baseline, rebalance: {}, sleeveTargets: targets };
  }
  const replay = replayLabBacktest(frozen, undefined, signal);
  const diagnostics = runDiagnostics({
    request: frozen.request,
    frozen,
    replay,
  });
  diagnostics.counts.capacityClippedFills = replay.result.fills.filter(
    (f) => f.capacityClipped,
  ).length;
  const disclosures: StrategyDisclosures = { ...base.disclosures };
  disclosures.suspensionEvidence = {
    ...summarizePortfolioSuspensions(replay.result),
    certificates: base.suspensionCertificates ?? [],
  };
  if (request.sleeves.length > 1) {
    const { sleeves, investmentCorrelations, ...book } =
      computeSleeveAttribution(replay.result);
    // The archive validates the original sleeveAttribution object with a strict schema.
    const investment = sleeves.map(
      ({
        id,
        investmentReturn,
        investmentMaxDrawdown,
        tradingPnlContribution,
        dailyInvestmentReturns,
      }) => ({
        id,
        investmentReturn,
        investmentMaxDrawdown,
        tradingPnlContribution,
        dailyInvestmentReturns,
      }),
    );
    disclosures.sleeveInvestment = {
      sleeves: investment,
      correlations: investmentCorrelations,
    };
    disclosures.sleeveAttribution = {
      ...book,
      sleeves: sleeves.map(
        ({
          investmentReturn,
          investmentMaxDrawdown,
          tradingPnlContribution,
          dailyInvestmentReturns,
          ...ledger
        }) => ledger,
      ),
    };
    disclosures.sleeveTrades = computeSleeveTradeMetrics(
      replay.result,
      frozen.request,
    );
    disclosures.bookControl = {
      policy,
      targetCount: frozen.request.sleeveTargets?.length ?? 0,
      transferCount: replay.result.transfers.length,
    };
  }
  if (options.holdoutStart !== undefined)
    disclosures.timeHoldout = runDiagnoseTimeHoldout(frozen.request, {
      holdoutStart: options.holdoutStart,
      candidateId: base.candidateId,
      benchmark: base.benchmarkBars,
      signal,
    });
  for (const strategy of request.strategies) {
    const { entry } = strategy;
    const key =
      entry.kind === "study-rule" && isWyckoffStudy(entry.strategy)
        ? wyckoffStudyBindings[entry.strategy]
        : undefined;
    if (key && isWyckoffFunnelKey(key)) {
      (disclosures.wyckoffFunnel ??= []).push(
        ...request.instruments.map(({ symbol, signalBars }) => ({
          ...(request.strategies.length > 1 && {
            strategyKey: strategy.id.replace(/^diag-/, ""),
          }),
          symbol,
          ...analyzeWyckoffFunnel(key, signalBars, request.start, request.end),
          buyOrders: replay.result.orders.filter(
            (o) =>
              o.strategyId === strategy.id &&
              o.symbol === symbol &&
              o.side === "buy",
          ).length,
          buyFills: replay.result.fills.filter(
            (f) =>
              f.strategyId === strategy.id &&
              f.symbol === symbol &&
              f.side === "buy",
          ).length,
        })),
      );
    }
  }
  return {
    frozen,
    replay,
    diagnostics,
    disclosures,
    reasons: rejectionReasons(replay),
  };
}
