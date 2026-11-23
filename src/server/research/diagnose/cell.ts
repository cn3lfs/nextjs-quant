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
  type GrowthPitSignalOptions,
} from "./growth-pit";
import {
  BENCHMARK_CALENDAR_SYMBOL,
  prepareDiagnoseRequest,
} from "./prepare-request";
import {
  buildStrategy,
  isNativeStrategyKey,
  isPitStrategyKey,
  isWyckoffFunnelKey,
  warmupBarsFor,
  type PlannedDiagnoseCell,
  type StrategyKey,
} from "./strategy-specs";
import type { NativeChanOptions } from "./chan-native";
import type {
  DiagnoseLayer,
  DiagnoseStatus,
  StrategyDisclosures,
} from "./types";
import { analyzeWyckoffFunnel } from "./wyckoff-funnel";
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
  key: StrategyKey,
  symbols: readonly string[],
  mode: "per-symbol" | "portfolio",
  tdxRoot: string,
  end: string,
  cache: BarCache,
) {
  const warmup = warmupBarsFor(key);
  const series = await Promise.all(
    symbols.map((symbol) => loadDaily(tdxRoot, end, symbol, cache)),
  );
  if (mode === "portfolio") {
    const native = isNativeStrategyKey(key);
    const listed = series
      .map((bars, i) => {
        if (!native) return bars[0]?.date;
        const ready = bars[warmup];
        if (!ready)
          throw new Error(
            `${symbols[i]}：原生缠论需要至少 ${warmup} 根预热行情和一根执行行情`,
          );
        return ready.date;
      })
      .filter((date): date is string => date !== undefined);
    if (!listed.length) throw new Error("自动起始日缺少本地日线");
    const latest = listed.reduce((a, b) => (b > a ? b : a));
    const start = await alignToBenchmark(latest, tdxRoot, end, cache);
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
  Pick<GrowthPitSignalOptions, "indexBars" | "readFinancialHistory">;
export type DiagnoseMarketCache = { marketBars?: readonly Bar[] };
type CellInput = DiagnosePreparationOptions & {
  config: Settings;
  start: string;
  end: string;
  initial: number;
  cost: ResearchCostScenario;
  riskPerTrade: number;
  maxPositions: number;
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
  const strategyConfig = buildStrategy(
    strategy,
    symbols,
    item.mode === "portfolio" ? "portfolio" : "single",
  );
  const forceCausalPrice = strategy !== "hold";
  const prefetched = new Map<string, Awaited<ReturnType<typeof readBars>>>();
  const read: typeof readBars = (query, ...rest) => {
    const key = JSON.stringify([query.instrument.symbol, query.adjustment]);
    const snapshot = prefetched.get(key);
    return snapshot ? Promise.resolve(snapshot) : readBars(query, ...rest);
  };
  let start = input.start;
  if (start === "auto") {
    const cache: BarCache = new Map();
    const budget = new BarResourceBudget();
    async function prefetch(symbol: string, benchmark: boolean) {
      input.signal?.throwIfAborted();
      const adjustment = benchmark || forceCausalPrice ? "none" : "forward";
      const query = {
        instrument: { market: "cn-equity", symbol },
        period: "day",
        adjustment,
        root: tdxRoot,
        to: input.end,
        live: false,
        ...(benchmark ? {} : { source: "local" as const, freezeRaw: true }),
      } as const;
      const snapshot = await readBars(query, undefined, undefined, budget);
      prefetched.set(JSON.stringify([symbol, adjustment]), snapshot);
      cache.set(symbol, snapshot.rawBars ?? snapshot.bars);
    }
    for (const symbol of symbols) await prefetch(symbol, false);
    if (item.mode === "portfolio" && !cache.has(BENCHMARK_CALENDAR_SYMBOL))
      await prefetch(BENCHMARK_CALENDAR_SYMBOL, true);
    start = await resolveAutoStart(
      strategy,
      symbols,
      item.mode,
      tdxRoot,
      input.end,
      cache,
    );
  }

  if (
    input.indexBars === undefined &&
    isPitStrategyKey(strategy) &&
    strategy !== "research-canslim-pit" &&
    strategy !== "research-sepa-pit"
  ) {
    market.marketBars ??= await readGrowthMarketBars(tdxRoot, input.end);
  }
  input.signal?.throwIfAborted();
  const {
    frozen,
    dataQuality,
    calendar: _calendar,
    ...disclosures
  } = await prepare({
    config: input.config,
    strategy: strategyConfig,
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
    source.nativeChan = identity;
  }
  return { strategyConfig, frozen, dataQuality, disclosures };
}

type PreparedCell = Awaited<ReturnType<typeof prepareDiagnoseCell>>;
type ExecutionOptions = {
  executionProfile?: LabExecutionProfile;
  maxParticipation?: number;
  capacityPolicy?: "clip" | "reject";
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
  const frozen: FrozenLabBacktest = {
    ...base.frozen,
    executionProfile: profile,
    maxParticipation: options.maxParticipation ?? null,
    capacityPolicy: options.capacityPolicy ?? null,
    request: {
      ...request,
      instruments:
        profile === "strict"
          ? request.instruments
          : request.instruments.map((instrument) => ({
              ...instrument,
              execution: applyProfile(
                instrument.execution,
                profile === "clamp" ? "clamp" : "none",
              ),
            })),
      ...(options.maxParticipation === undefined
        ? {}
        : { maxParticipation: options.maxParticipation }),
      ...(options.capacityPolicy === undefined
        ? {}
        : { capacityPolicy: options.capacityPolicy }),
    },
  };
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
  const { entry } = base.strategyConfig;
  const key =
    entry.kind === "study-rule" && isWyckoffStudy(entry.strategy)
      ? wyckoffStudyBindings[entry.strategy]
      : undefined;
  if (key && isWyckoffFunnelKey(key)) {
    disclosures.wyckoffFunnel = request.instruments.map(
      ({ symbol, signalBars }) => ({
        symbol,
        ...analyzeWyckoffFunnel(key, signalBars, request.start, request.end),
        buyOrders: replay.result.orders.filter(
          (o) => o.symbol === symbol && o.side === "buy",
        ).length,
        buyFills: replay.result.fills.filter(
          (f) => f.symbol === symbol && f.side === "buy",
        ).length,
      }),
    );
  }
  return {
    frozen,
    replay,
    diagnostics,
    disclosures,
    reasons: rejectionReasons(replay),
  };
}
