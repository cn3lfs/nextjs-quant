import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  createNativeStudyRule,
  nativeStudyDefinition,
  studyWarmup,
  type FrozenChanObservation,
  type NativeStudyIdentity,
  type StrategyObjectInput,
} from "trading-strategies";
import { researchCanslimHighSeries } from "trading-strategies/research/canslim/research-canslim-high";
import type { PortfolioInstrument } from "quant-backtest";
import type { ResearchCostScenario } from "trading-strategy-core/costs";
import type { Settings } from "../../../src/lib/domain";
import {
  CausalPriceBasisError,
  refreshCausalPriceProof,
  type CausalPriceProof,
} from "../../../src/server/research/causal-price-basis";
import {
  prepareLabBacktest,
  usesNativeChan,
  type FrozenLabBacktest,
  type LabExecutionProfile,
} from "../../../src/server/research/lab-backtest";
import { readBars } from "../../../src/server/market/bar-store/read-bars";
import { readLocalFinancialHistory } from "../../../src/server/data-sources/tdx/local-financial-files";
import { buildCanslimPitSeries } from "../../../src/server/financial/canslim-pit-series";
import { captureNativeChanObservations } from "../../../src/server/strategies/strategy-center-native";
import type { CanslimPitDisclosure, NativeChanDisclosure } from "./types";

export const BENCHMARK_CALENDAR_SYMBOL = "sh000001";

export type PrepareDiagnoseRequestInput = {
  strategy: StrategyObjectInput;
  start: string;
  end: string;
  initial: number;
  riskPerTrade: number;
  maxPositions: number;
  costScenario: ResearchCostScenario;
  config: Settings;
  forceCausalPrice: boolean;
  executionProfile?: LabExecutionProfile;
  maxParticipation?: number;
  capacityPolicy?: "clip" | "reject";
  captureNative?: typeof captureNativeChanObservations;
  readFinancialHistory?: typeof readLocalFinancialHistory;
  nativeCacheDir?: string;
  nativeProgress?: (symbol: string, done: number, total: number) => void;
};

export type DiagnoseSourceQuality = {
  symbol: string;
  dataAsOf: string | null;
  adjustment: string | null;
  priceRepaired: boolean;
  sourceNote: string | null;
  /** Unparsed GBBQ records attributed to this symbol. */
  gbbqIssueCount: number;
  /** Unparsed GBBQ records whose security cannot be decoded; these could
   * belong to any symbol and are not a per-symbol completeness claim. */
  gbbqUnattributedIssueCount: number;
  /** Category 13/14 warrant dates skipped under the record-only GBBQ policy. */
  skippedWarrants: string[];
  /** Bars inside the window but absent from the benchmark calendar, dropped
   * from replay only; actions and execution maps are left untouched. */
  offCalendarDates: string[];
  offCalendarNote: string | null;
};

export type PreparedDiagnoseRequest = {
  frozen: FrozenLabBacktest;
  calendar: string[];
  dataQuality: DiagnoseSourceQuality[];
  nativeChan?: NativeChanDisclosure[];
  canslimPit?: CanslimPitDisclosure[];
};

const nativeCacheVersion = "chan-native-cache-1";
type NativeCacheEntry = {
  version: typeof nativeCacheVersion;
  symbol: string;
  firstIndex: number;
  identity: NativeStudyIdentity;
  originDate: string;
  baselineDate: string;
  auditCount: number;
  pendingCount: number;
  barsDigest: string;
  captureElapsedMs: number;
  observations: FrozenChanObservation[];
};

const barsDigest = (bars: PortfolioInstrument["signalBars"]) =>
  createHash("sha256").update(JSON.stringify(bars)).digest("hex");

// Cache entries are direct children of the resolved cache directory.
async function cacheFileExists(cacheDir: string, cachePath: string) {
  if (
    relative(cacheDir, dirname(cachePath)) !== "" ||
    relative(cacheDir, await realpath(cacheDir)) !== ""
  )
    throw new Error(
      `Native Chan cache path escapes its directory: ${cachePath}`,
    );
  let st;
  try {
    st = await lstat(cachePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (st.isSymbolicLink() || !st.isFile())
    throw new Error(
      `Native Chan cache requires a regular, non-symlink file: ${cachePath}`,
    );
  if (relative(cacheDir, dirname(await realpath(cachePath))) !== "")
    throw new Error(
      `Native Chan cache path escapes its directory: ${cachePath}`,
    );
  return true;
}

async function loadNativeObservations(
  { symbol, signalBars }: PortfolioInstrument,
  firstIndex: number,
  input: PrepareDiagnoseRequestInput,
) {
  const tLoad = Date.now();
  const expectedBarsDigest = barsDigest(signalBars);
  let cacheDir: string | undefined;
  let cachePath: string | undefined;
  if (input.nativeCacheDir) {
    try {
      const dirStat = await lstat(input.nativeCacheDir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory())
        throw new Error(
          `Native Chan cache directory must be a real, non-symlink directory: ${input.nativeCacheDir}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(input.nativeCacheDir, { recursive: true });
    const dirStatAfter = await lstat(input.nativeCacheDir);
    if (dirStatAfter.isSymbolicLink() || !dirStatAfter.isDirectory())
      throw new Error(
        `Native Chan cache directory must be a real, non-symlink directory: ${input.nativeCacheDir}`,
      );
    cacheDir = await realpath(input.nativeCacheDir);
    const hash = createHash("sha256")
      .update(
        JSON.stringify({
          version: nativeCacheVersion,
          symbol,
          firstIndex,
          bars: signalBars.map((b) => [
            b.date,
            b.open,
            b.high,
            b.low,
            b.close,
            b.volume,
          ]),
        }),
      )
      .digest("hex");
    cachePath = join(cacheDir, `chan-${symbol}-${hash.slice(0, 16)}.json`);
    if (await cacheFileExists(cacheDir, cachePath)) {
      try {
        const entry: NativeCacheEntry = JSON.parse(
          await readFile(cachePath, "utf8"),
        );
        if (
          entry.version === nativeCacheVersion &&
          entry.symbol === symbol &&
          entry.firstIndex === firstIndex &&
          entry.originDate === signalBars[0]!.date &&
          entry.baselineDate === signalBars[firstIndex - 1]!.date &&
          entry.barsDigest === expectedBarsDigest &&
          Number.isSafeInteger(entry.auditCount) &&
          entry.auditCount >= 0 &&
          Number.isSafeInteger(entry.pendingCount) &&
          entry.pendingCount >= 0 &&
          typeof entry.captureElapsedMs === "number" &&
          Number.isFinite(entry.captureElapsedMs) &&
          entry.captureElapsedMs >= 0 &&
          Array.isArray(entry.observations) &&
          entry.observations[0]?.prefixHash ===
            barsDigest(signalBars.slice(0, firstIndex)) &&
          entry.observations.at(-1)?.prefixHash === expectedBarsDigest &&
          isDeepStrictEqual(entry.identity, entry.observations[0]?.identity)
        ) {
          createNativeStudyRule(signalBars, firstIndex, entry.observations);
          return {
            entry,
            cached: true,
            captureElapsedMs: entry.captureElapsedMs,
            cacheLoadMs: Date.now() - tLoad,
          };
        }
      } catch {
        // Unreadable or invalid evidence is recaptured from the final bars.
      }
    }
  }

  const t0 = Date.now();
  const capture = await (input.captureNative ?? captureNativeChanObservations)(
    signalBars,
    firstIndex,
    undefined,
    undefined,
    (done, total) => input.nativeProgress?.(symbol, done, total),
  );
  const captureElapsedMs = Date.now() - t0;
  const entry: NativeCacheEntry = {
    version: nativeCacheVersion,
    symbol,
    firstIndex,
    identity: capture.identity,
    originDate: capture.originDate,
    baselineDate: capture.baselineDate,
    auditCount: capture.audit.length,
    pendingCount: capture.pending.length,
    barsDigest: expectedBarsDigest,
    captureElapsedMs,
    observations: capture.observations,
  };
  if (cacheDir && cachePath) {
    await cacheFileExists(cacheDir, cachePath);
    const tempPath = `${cachePath}.${randomUUID()}.tmp.${process.pid}`;
    await writeFile(tempPath, JSON.stringify(entry), { flag: "wx" });
    await rename(tempPath, cachePath);
  }
  return { entry, cached: false, captureElapsedMs, cacheLoadMs: null };
}

async function attachNativeChan(
  frozen: FrozenLabBacktest,
  input: PrepareDiagnoseRequestInput,
) {
  const { instruments, start } = frozen.request;
  const indices = instruments.map((instrument) => {
    const first = instrument.signalBars.findIndex(
      (bar) => bar.date.slice(0, 10) >= start,
    );
    if (first < nativeStudyDefinition.warmupBars)
      throw new Error(
        `${instrument.symbol}：原生缠论需要至少 ${nativeStudyDefinition.warmupBars} 根预热行情（当前仅 ${Math.max(0, first)} 根）`,
      );
    return first;
  });
  const firstIndex = indices[0]!;
  if (indices.some((index) => index !== firstIndex))
    throw new Error(
      "原生缠论组合模式要求各标的预热起点索引一致；请使用 per-symbol 模式",
    );
  frozen.request.strategies = frozen.request.strategies.map((strategy) => ({
    ...strategy,
    entry:
      strategy.entry.kind === "chan-third-buy"
        ? { ...strategy.entry, firstIndex }
        : strategy.entry,
    exit:
      strategy.exit.rule?.kind === "chan-third-buy"
        ? { ...strategy.exit, rule: { ...strategy.exit.rule, firstIndex } }
        : strategy.exit,
  }));

  const nativeChan: NativeChanDisclosure[] = [];
  for (const instrument of instruments) {
    const { entry, cached, captureElapsedMs, cacheLoadMs } =
      await loadNativeObservations(instrument, firstIndex, input);
    instrument.external = { ...instrument.external, chan: entry.observations };
    const source = frozen.sources.find(
      (row) => row.symbol === instrument.symbol,
    );
    const proof = source?.causalPrice as CausalPriceProof | undefined;
    const disclosure: NativeChanDisclosure = {
      symbol: instrument.symbol,
      identity: entry.identity,
      originDate: entry.originDate,
      baselineDate: entry.baselineDate,
      firstIndex,
      prefixCount: entry.observations.length,
      captureElapsedMs,
      cacheLoadMs,
      auditCount: entry.auditCount,
      pendingCount: entry.pendingCount,
      signalPriceBasis:
        proof?.kind ??
        (typeof source?.adjustment === "string" ? source.adjustment : null),
      cached,
    };
    nativeChan.push(disclosure);
    if (source) source.nativeChan = disclosure;
    else
      frozen.sources.push({
        symbol: instrument.symbol,
        nativeChan: disclosure,
      });
  }
  return nativeChan;
}

async function attachCanslimPit(
  frozen: FrozenLabBacktest,
  input: PrepareDiagnoseRequestInput,
) {
  const { instruments, start, end } = frozen.request;
  const readHistory = input.readFinancialHistory ?? readLocalFinancialHistory;
  const id = "research-canslim-pit";
  const warmup = studyWarmup("research-growth");
  const disclosures: CanslimPitDisclosure[] = [];
  for (const instrument of instruments) {
    const { symbol, signalBars } = instrument;
    const history = await readHistory(input.config.tdxRoot, symbol, {
      asOf: end,
      strict: true,
      limit: 200,
    });
    const priceSeries = researchCanslimHighSeries(
      "canslim-high-98",
      signalBars,
    );
    const pit = buildCanslimPitSeries(history.reports, signalBars);
    let priceSignalCount = 0;
    let pitFilteredSignalCount = 0;
    let qualifiedDays = 0;
    let missingDays = 0;
    let conflictDays = 0;
    const signals = signalBars.map(({ date }, i) => {
      const priceEntry = priceSeries[i]!.entry;
      const day = pit.days[i]!;
      const entry = i < warmup ? null : priceEntry && day.qualified;
      if (date >= start && date <= end && i >= warmup) {
        if (day.qualified) qualifiedDays++;
        const statuses = [day.c1.status, day.a1.status, day.a2.status];
        if (statuses.includes("missing")) missingDays++;
        if (statuses.includes("conflict")) conflictDays++;
        if (priceEntry) priceSignalCount++;
        if (entry) pitFilteredSignalCount++;
      }
      return { id, date, availableAt: date, entry, exit: false };
    });
    instrument.external = { ...instrument.external, signals };
    const disclosure: CanslimPitDisclosure = {
      symbol,
      strictReportCount: pit.strictReportCount,
      reportDateRange: pit.reportDateRange,
      qualifiedDays,
      missingDays,
      conflictDays,
      priceSignalCount,
      pitFilteredSignalCount,
      sourceIssuesCount: history.issues.length,
      boundary: pit.boundary,
    };
    const source = frozen.sources.find((row) => row.symbol === symbol);
    if (source) source.canslimPit = disclosure;
    else frozen.sources.push({ symbol, canslimPit: disclosure });
    disclosures.push(disclosure);
  }
  return disclosures;
}

function sourceQuality(sources: readonly Record<string, unknown>[]) {
  return sources.map((source) => ({
    symbol: typeof source.symbol === "string" ? source.symbol : "",
    dataAsOf: typeof source.dataAsOf === "string" ? source.dataAsOf : null,
    adjustment:
      typeof source.adjustment === "string" ? source.adjustment : null,
    priceRepaired: source.priceRepaired === true,
    sourceNote:
      typeof source.sourceNote === "string" ? source.sourceNote : null,
    gbbqIssueCount:
      typeof source.gbbqIssueCount === "number" ? source.gbbqIssueCount : 0,
    gbbqUnattributedIssueCount:
      typeof source.gbbqUnattributedIssueCount === "number"
        ? source.gbbqUnattributedIssueCount
        : 0,
    skippedWarrants: Array.isArray(source.skippedWarrants)
      ? source.skippedWarrants.filter(
          (date): date is string => typeof date === "string",
        )
      : [],
    offCalendarDates: Array.isArray(source.offCalendarDates)
      ? source.offCalendarDates.filter(
          (date): date is string => typeof date === "string",
        )
      : [],
    offCalendarNote:
      typeof source.offCalendarNote === "string"
        ? source.offCalendarNote
        : null,
  }));
}

/**
 * Reuse the lab loader for bars, causal prices, corporate actions and per-date
 * execution limits, then swap the union calendar for the benchmark's trading
 * days so a suspended stock stays a missing bar instead of disappearing.
 * Dropping replay bars also re-binds each frozen causal-price proof to the
 * filtered series; a proof whose anchor bar was dropped is rejected rather
 * than left stale.
 */
export async function prepareDiagnoseRequest(
  input: PrepareDiagnoseRequestInput,
): Promise<PreparedDiagnoseRequest> {
  const isNativeChan = usesNativeChan(input.strategy);
  const isCanslimPit =
    input.strategy.entry.kind === "external" &&
    input.strategy.entry.id === "research-canslim-pit";
  const frozen = await prepareLabBacktest(
    {
      type: "lab-backtest",
      input: {
        source: "local",
        strategy: input.strategy,
        start: input.start,
        end: input.end,
        initial: input.initial,
        riskPerTrade: input.riskPerTrade,
        maxPositions: input.maxPositions,
        costScenario: input.costScenario,
      },
    },
    undefined,
    undefined,
    undefined,
    {
      config: input.config,
      allowNativeChan: isNativeChan,
      allowExternalSignals: isCanslimPit,
      forceCausalPrice: input.forceCausalPrice,
      dataQualityMode: "record-only",
      gbbqIssuePolicy: "record-only",
      executionProfile: input.executionProfile,
      maxParticipation: input.maxParticipation,
      capacityPolicy: input.capacityPolicy,
    },
  );
  const benchmark = await readBars({
    instrument: { market: "cn-equity", symbol: BENCHMARK_CALENDAR_SYMBOL },
    root: input.config.tdxRoot,
    period: "day",
    adjustment: "none",
    to: input.end,
    live: false,
  });
  const calendar = benchmark.bars
    .map((bar) => bar.date)
    .filter(
      (date) =>
        date.slice(0, 10) >= input.start && date.slice(0, 10) <= input.end,
    );
  if (!calendar.length)
    throw new Error(
      `基准日历 ${BENCHMARK_CALENDAR_SYMBOL} 在 ${input.start} 至 ${input.end} 无交易日`,
    );
  // The benchmark dates replace the union calendar, so a stock bar on a day
  // the index lacks would silently disappear. Bars before `start` are kept on
  // purpose: they are the strategy warmup. A handful of early Shenzhen special
  // sessions can put a stock bar outside the Shanghai benchmark calendar; when
  // that stays below a small share of the window, drop only those replay bars
  // and disclose them, rather than blocking the whole cell or synthesizing a
  // date. A larger gap is still a benchmark-calendar defect.
  const calendarSet = new Set(calendar);
  const { start, end } = frozen.request;
  for (const instrument of frozen.request.instruments) {
    const inWindowBars = instrument.bars.filter((bar) => {
      const date = bar.date.slice(0, 10);
      return date >= start && date <= end;
    });
    // Daily bars: the unique dates are exactly the sessions that will be
    // dropped from both bar arrays.
    const offCalendar = [
      ...new Set(
        inWindowBars
          .map((bar) => bar.date.slice(0, 10))
          .filter((date) => !calendarSet.has(date)),
      ),
    ].sort();
    if (!offCalendar.length) continue;
    const threshold = Math.max(20, Math.floor(inWindowBars.length * 0.005));
    if (offCalendar.length > threshold) {
      const shown = offCalendar.slice(0, 5).join(", ");
      throw new Error(
        `基准日历 ${BENCHMARK_CALENDAR_SYMBOL} 缺少 ${instrument.symbol} 的交易日：${shown}${offCalendar.length > 5 ? ` 等 ${offCalendar.length} 个` : ""}`,
      );
    }
    const dropped = new Set(offCalendar);
    const sharedBars = instrument.signalBars === instrument.bars;
    const bars = instrument.bars.filter(
      (bar) => !dropped.has(bar.date.slice(0, 10)),
    );
    instrument.bars = bars;
    instrument.signalBars = sharedBars
      ? bars
      : instrument.signalBars.filter(
          (bar) => !dropped.has(bar.date.slice(0, 10)),
        );
    // Actions and execution maps keep their original dates; the engine maps a
    // non-calendar action date to the next calendar session on its own.
    const note = `基准日历 ${BENCHMARK_CALENDAR_SYMBOL} 不含该标的 ${offCalendar.length} 个交易日；为对齐回放日历，已从 bars/signalBars 删除这些 bar（未合成日期，未改公司行动或执行映射）`;
    const source = frozen.sources.find(
      (row) => row.symbol === instrument.symbol,
    );
    // The lab froze the causal series hash over the unfiltered arrays. Re-bind
    // it to the filtered pair so a later proof check sees the actual replay
    // series. Without a proof (non-causal strategies) there is nothing to do.
    const proof = source?.causalPrice as CausalPriceProof | undefined;
    if (proof && source) {
      const refreshed = refreshCausalPriceProof(
        proof,
        instrument.bars,
        instrument.signalBars,
      );
      if (!refreshed)
        throw new CausalPriceBasisError(
          `${instrument.symbol}：因果价格证明无法刷新：固定锚点原始 bar ${proof.anchorDate} 已被基准日历过滤，价格基失去锚点`,
        );
      source.causalPrice = refreshed;
    }
    if (source) {
      source.offCalendarDates = offCalendar;
      source.offCalendarNote = note;
    } else
      frozen.sources.push({
        symbol: instrument.symbol,
        offCalendarDates: offCalendar,
        offCalendarNote: note,
      });
  }
  frozen.request.calendar = calendar;
  frozen.request.observationDetail = "full";
  const nativeChan = isNativeChan
    ? await attachNativeChan(frozen, input)
    : undefined;
  const canslimPit = isCanslimPit
    ? await attachCanslimPit(frozen, input)
    : undefined;
  return {
    frozen,
    calendar,
    dataQuality: sourceQuality(frozen.sources),
    ...(nativeChan && { nativeChan }),
    ...(canslimPit && { canslimPit }),
  };
}
