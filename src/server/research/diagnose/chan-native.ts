import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  open,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { PortfolioInstrument, runPortfolio } from "quant-backtest";
import {
  createNativeChanProfileRule,
  createNativeStudyRule,
  isNativeChanV3Profile,
  nativeChanV3Configs,
  nativeChanV3Rules,
  nativeStudyDefinition,
  type FrozenChanObservation,
  type FrozenChanPoint,
  type NativeChanProjectionVersion,
  type NativeStudyIdentity,
  type StrategyExternalInputs,
  type StrategyObjectInput,
} from "trading-strategies";
import { atr } from "trading-strategy-core/indicators";
import type { CausalPriceProof } from "../causal-price-basis";
import { usesNativeChan, type FrozenLabBacktest } from "../lab-backtest";
import { captureNativeChanObservations } from "../../strategies/strategy-center-native";
import {
  czscRuntimeFingerprint,
  getCurrentCzscIdentity,
  nativeIdentityFromSnapshot,
  projectCzsc,
  type CzscSnapshot,
} from "../../strategies/chan/czsc";
import type { NativeChanDisclosure } from "./types";
import { pairSleevePositionCycles } from "./sleeve-trades";

export const NATIVE_CHAN_CACHE_VERSION = "chan-native-cache-2";
export const NATIVE_CHAN_ZD_STOP_KEY = "research-chan-hold-cash-zd-stop";
export const NATIVE_CHAN_ZD_ATR_STOP_KEY = "research-chan-hold-cash-zd-atr";
const zdStopField = "chan-zd";
const zdAtrStopField = "chan-zd-atr";
const zdAtrPeriod = 14;
const zdAtrMultiplier = 1.0;

export const nativeChanCh04Rules = () =>
  nativeChanV3Rules("chan-overlap-native");
export const nativeChanCh07Rules = () =>
  nativeChanV3Rules("chan-nested-native");
export const nativeChanCh12Rules = () =>
  nativeChanV3Rules("chan-rebound-native");

export function nativeChanZdStopRules(): Pick<
  StrategyObjectInput,
  "entry" | "exit"
> {
  const entry = {
    kind: "chan-native",
    profile: "chan-hold-cash-native",
    side: "entry",
  } as const;
  return {
    entry,
    exit: {
      rule: { ...entry, side: "exit" },
      stop: { kind: "structure", field: zdStopField },
    },
  };
}

export function nativeChanZdAtrStopRules(): ReturnType<
  typeof nativeChanZdStopRules
> {
  const rules = nativeChanZdStopRules();
  return {
    ...rules,
    exit: { ...rules.exit, stop: { kind: "structure", field: zdAtrStopField } },
  };
}

export function buildNativeChanZdLevels(
  observations: readonly FrozenChanObservation[],
): NonNullable<StrategyExternalInputs["levels"]> {
  return observations.flatMap((row) => {
    if (row.projectionVersion !== 2 && row.projectionVersion !== 3) return [];
    // CH14 enters on any fresh buy point. Prefer its center on an entry day;
    // among simultaneous points of the preferred side, use the latest endpoint.
    let point: FrozenChanPoint | undefined;
    for (const current of row.points ?? []) {
      if (!point) {
        point = current;
        continue;
      }
      const currentIsBuy = current.kind > 0;
      const selectedIsBuy = point.kind > 0;
      if (currentIsBuy !== selectedIsBuy) {
        if (currentIsBuy) point = current;
      } else if (current.endpointIndex > point.endpointIndex) {
        point = current;
      }
    }
    const value = point?.center.ZD;
    return value !== undefined && Number.isFinite(value) && value > 0
      ? [{ date: row.date, availableAt: row.date, field: zdStopField, value }]
      : [];
  });
}

/** The shared ATR is a causal moving average of true range. Index each level
 * on its observation date, using the same adjusted signal bars as the DLL. */
export function buildNativeChanZdAtrLevels(
  observations: readonly FrozenChanObservation[],
  signalBars: PortfolioInstrument["signalBars"],
): NonNullable<StrategyExternalInputs["levels"]> {
  const ranges = new Map(signalBars.map((bar, index) => [bar.date, index]));
  const volatility = atr(signalBars, zdAtrPeriod);
  return buildNativeChanZdLevels(observations).flatMap((level) => {
    const index = ranges.get(level.date);
    const range = index === undefined ? null : volatility[index];
    if (range == null) return [];
    const value = level.value - zdAtrMultiplier * range;
    return Number.isFinite(value) && value > 0
      ? [{ ...level, field: zdAtrStopField, value }]
      : [];
  });
}

type ChanTradeLedger = Pick<
  ReturnType<typeof runPortfolio>,
  "fills" | "orders" | "rejections" | "corporateActions"
>;
const invalidInitialStop = "缺失或无效初始止损";

/** Match independently replayed CH14 cycles by symbol, signal date and entry
 * fill date. Report actual, fee-inclusive P&L in the respective book sizes. */
export function decomposeChanZdImpact(
  base: ChanTradeLedger,
  zd: ChanTradeLedger,
) {
  const entryKey = (symbol: string, signalAt: string, date: string) =>
    JSON.stringify([symbol, signalAt, date]);
  const positionDay = (strategyId: string, symbol: string, date: string) =>
    JSON.stringify([strategyId, symbol, date.slice(0, 10)]);
  function tradeEvidence(ledger: ChanTradeLedger) {
    const entries = new Map<string, ChanTradeLedger["fills"][number]>();
    const exits = new Map<string, ChanTradeLedger["fills"][number]>();
    const orders = new Map(ledger.orders.map((order) => [order.id, order]));
    for (const fill of ledger.fills) {
      const key = positionDay(fill.strategyId, fill.symbol, fill.date);
      if (
        fill.side === "buy" &&
        Math.abs(fill.holdingAfter - fill.quantity) <= 1e-8
      )
        entries.set(key, fill);
      if (fill.side === "sell" && fill.holdingAfter <= 1e-8)
        exits.set(key, fill);
    }
    const result = new Map<
      string,
      {
        entry: ChanTradeLedger["fills"][number];
        exit: ChanTradeLedger["fills"][number] | undefined;
        exitTrigger: ChanTradeLedger["orders"][number]["trigger"] | undefined;
        netPnl: number | null;
      }
    >();
    for (const cycle of pairSleevePositionCycles(ledger)) {
      const { strategyId, symbol, openedAt, closedAt, netPnl } = cycle;
      const entry = entries.get(positionDay(strategyId, symbol, openedAt));
      const exit =
        closedAt === null
          ? undefined
          : exits.get(positionDay(strategyId, symbol, closedAt));
      if (!entry || (closedAt !== null && !exit))
        throw new Error("CH14 归因缺少轮次对应的开仓或平仓成交");
      const key = entryKey(symbol, entry.signalAt, entry.date);
      if (result.has(key)) throw new Error("CH14 归因入场身份重复");
      result.set(key, {
        entry,
        exit,
        exitTrigger: exit && orders.get(exit.orderId)?.trigger,
        netPnl,
      });
    }
    return result;
  }
  const baseline = tradeEvidence(base);
  const stopped = tradeEvidence(zd);
  const rejectedAt = new Map(
    zd.rejections
      .filter(({ reason }) => reason === invalidInitialStop)
      .map(({ orderId, date }) => [orderId, date]),
  );
  const initialZdInvalidRejections = zd.orders.flatMap((order) => {
    if (
      order.side !== "buy" ||
      order.status !== "rejected" ||
      order.reason !== invalidInitialStop
    )
      return [];
    const date = rejectedAt.get(order.id) ?? order.due;
    const comparison =
      date && baseline.get(entryKey(order.symbol, order.signalAt, date));
    return [
      {
        orderId: order.id,
        symbol: order.symbol,
        signalAt: order.signalAt,
        date,
        reason: invalidInitialStop,
        baselineEntryDate: comparison ? comparison.entry.date : null,
        baselineNetPnl: comparison ? comparison.netPnl : null,
      },
    ];
  });
  const sharedEntryEarlyStops = [...stopped].flatMap(([key, trade]) => {
    const comparison = baseline.get(key);
    if (
      trade.exitTrigger !== "stop" ||
      comparison?.exitTrigger !== "signal" ||
      !trade.exit ||
      !comparison.exit ||
      trade.exit.date >= comparison.exit.date ||
      trade.netPnl === null ||
      comparison.netPnl === null
    )
      return [];
    return [
      {
        symbol: trade.entry.symbol,
        signalAt: trade.entry.signalAt,
        entryDate: trade.entry.date,
        baseExitDate: comparison.exit.date,
        zdExitDate: trade.exit.date,
        baseNetPnl: comparison.netPnl,
        zdNetPnl: trade.netPnl,
        netPnlDelta: trade.netPnl - comparison.netPnl,
      },
    ];
  });
  return {
    initialZdInvalidRejections,
    sharedEntryEarlyStops,
    sharedEntryEarlyStopNetPnlDelta: sharedEntryEarlyStops.reduce(
      (total, { netPnlDelta }) => total + netPnlDelta,
      0,
    ),
  };
}

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function nativeChanCacheKey(input: {
  symbol: string;
  firstIndex: number;
  barsDigest: string;
  dllIdentity: NativeStudyIdentity;
  projectionVersion: number;
  configs?: readonly number[];
}) {
  const {
    symbol,
    firstIndex,
    barsDigest,
    projectionVersion,
    configs,
    dllIdentity: id,
  } = input;
  return digest([
    NATIVE_CHAN_CACHE_VERSION,
    symbol,
    firstIndex,
    barsDigest,
    id.dllHash,
    id.apiVersion,
    id.buildCommit,
    id.configId,
    id.config,
    id.anchor,
    projectionVersion,
    ...(projectionVersion >= 3
      ? [[...new Set(configs ?? nativeChanV3Configs)].sort((a, b) => a - b)]
      : []),
  ]);
}

export type NativeChanOptions = {
  /** A portfolio may retain only one listed member when replaying a prefix. */
  perInstrumentWarmup?: boolean;
  mode?: "current-dll-compute" | "frozen-replay";
  nativeCacheDir?: string;
  projectionVersion?: 2 | 3;
  captureNative?: typeof captureNativeChanObservations;
  project?: typeof projectCzsc;
  resolveIdentity?: () => Promise<NativeStudyIdentity>;
  nativeProgress?: (symbol: string, done: number, total: number) => void;
};

type CacheEntry = {
  version: typeof NATIVE_CHAN_CACHE_VERSION;
  projectionVersion: NativeChanProjectionVersion;
  symbol: string;
  firstIndex: number;
  barsDigest: string;
  identity: NativeStudyIdentity;
  originDate: string;
  baselineDate: string;
  observations: readonly FrozenChanObservation[];
  captureElapsedMs: number;
  auditCount: number;
  pendingCount: number;
};
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

async function cacheDirectory(path: string) {
  const check = async () => {
    const st = await lstat(path);
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      relative(resolve(path), await realpath(path)) !== ""
    )
      throw new Error(
        `Native Chan cache directory must be a real, non-symlink directory: ${path}`,
      );
  };
  try {
    await check();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    await cacheDirectory(dirname(resolve(path)));
    try {
      await mkdir(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  await check();
  return realpath(path);
}

async function readCache<T>(dir: string, path: string): Promise<T | undefined> {
  if (!(await cacheFileExists(dir, path))) return;
  const json = await readFile(path, "utf8");
  try {
    return JSON.parse(json) as T;
  } catch {
    return;
  }
}

async function saveCache(dir: string, path: string, value: unknown) {
  await cacheFileExists(dir, path);
  const temp = join(dir, `chan-${randomUUID()}.tmp`);
  const handle = await open(temp, "wx");
  try {
    try {
      await handle.writeFile(JSON.stringify(value));
    } finally {
      await handle.close();
    }
    await cacheFileExists(dir, path);
    await rename(temp, path);
  } finally {
    if (await cacheFileExists(dir, temp)) await unlink(temp);
  }
}

function validateEvidence(
  instrument: PortfolioInstrument,
  first: number,
  rows: readonly FrozenChanObservation[],
  barsDigest: string,
  version: NativeChanProjectionVersion,
) {
  const bars = instrument.signalBars;
  if (rows.some((row) => (row?.projectionVersion ?? 1) !== version))
    throw new Error("原生冻结观察投影版本不一致");
  if (version === 1) createNativeStudyRule(bars, first, rows);
  else {
    // Verify every projected point and its third-buy mirror. Consumers decide
    // whether recorded gaps in the additional point kinds block their rule.
    createNativeChanProfileRule("chan-third-native", bars, rows, first);
  }
  if (
    rows[0]!.prefixHash !== digest(bars.slice(0, first)) ||
    rows.at(-1)!.prefixHash !== barsDigest
  )
    throw new Error("原生冻结观察的行情前缀摘要不符");
}

// Recheck the current identity and the atomically published cache after an
// overlapping request. A failed writer must not poison later captures.
const cacheWrites = new Map<string, Promise<void>>();
export async function loadNativeObservations(
  instrument: PortfolioInstrument,
  firstIndex: number,
  options: NativeChanOptions = {},
) {
  if (!options.nativeCacheDir || options.mode === "frozen-replay")
    return loadObservations(instrument, firstIndex, options);
  const key = JSON.stringify([
    resolve(options.nativeCacheDir),
    instrument.symbol,
    firstIndex,
  ]);
  const previous = cacheWrites.get(key) ?? Promise.resolve();
  const result = previous.then(() =>
    loadObservations(instrument, firstIndex, options),
  );
  const finished = result.then(
    () => {},
    () => {},
  );
  cacheWrites.set(key, finished);
  try {
    return await result;
  } finally {
    if (cacheWrites.get(key) === finished) cacheWrites.delete(key);
  }
}

async function loadObservations(
  instrument: PortfolioInstrument,
  firstIndex: number,
  options: NativeChanOptions,
) {
  const { symbol, signalBars: bars } = instrument;
  if (
    !Number.isInteger(firstIndex) ||
    firstIndex < nativeStudyDefinition.warmupBars ||
    firstIndex >= bars.length
  )
    throw new Error(`${symbol}：原生观察缺少预热或执行行情`);
  const tLoad = Date.now();
  const barsDigest = digest(bars);
  const common = {
    version: NATIVE_CHAN_CACHE_VERSION,
    symbol,
    firstIndex,
    barsDigest,
    originDate: bars[0]!.date,
    baselineDate: bars[firstIndex - 1]!.date,
  } as const;
  if (options.mode === "frozen-replay") {
    const rows = instrument.external?.chan;
    if (!rows?.length) throw new Error(`${symbol}：缺少原生冻结观察`);
    const version = rows[0]!.projectionVersion ?? 1;
    if (options.projectionVersion === 3 && version !== 3)
      throw new Error(`${symbol}：缺少 v3 双级冻结观察`);
    validateEvidence(instrument, firstIndex, rows, barsDigest, version);
    // Bare frozen rows carry no capture timing, audit trail, or pending list.
    const entry: CacheEntry = {
      ...common,
      projectionVersion: version,
      observations: rows,
      identity: rows[0]!.identity,
      captureElapsedMs: 0,
      auditCount: 0,
      pendingCount: 0,
    };
    return { entry, cached: false, captureElapsedMs: 0, cacheLoadMs: null };
  }

  const dir = options.nativeCacheDir
    ? await cacheDirectory(options.nativeCacheDir)
    : undefined;
  const project = options.project ?? projectCzsc;
  const projectionVersion = options.projectionVersion ?? 2;
  let baseline: CzscSnapshot | undefined;
  let baselineElapsedMs = 0;
  async function currentIdentity() {
    if (options.resolveIdentity) return options.resolveIdentity();
    const runtime =
      project === projectCzsc ? await czscRuntimeFingerprint() : undefined;
    // A different worker binary can change default configuration even with the same DLL.
    const metaPath =
      dir && runtime ? join(dir, `runtime-${digest(runtime)}.json`) : undefined;
    if (dir && metaPath && runtime) {
      const meta = await readCache<{
        identity: NativeStudyIdentity;
        checksum: string;
      }>(dir, metaPath);
      if (
        meta?.identity?.dllHash === runtime.dllHash &&
        meta.checksum === digest([runtime, meta.identity])
      ) {
        const id = meta.identity;
        return nativeIdentityFromSnapshot({ hash: id.dllHash, ...id });
      }
    }
    const id = await getCurrentCzscIdentity(project, runtime, async () => {
      const start = Date.now();
      const prefix = bars.slice(0, firstIndex);
      baseline = await project(
        {
          high: prefix.map((b) => b.high),
          low: prefix.map((b) => b.low),
          close: prefix.map((b) => b.close),
          volume: prefix.map((b) => b.volume),
        },
        projectionVersion === 3
          ? { recursion: true, nested: true, bars: true }
          : { levels: [0], bars: false },
      );
      baselineElapsedMs = Date.now() - start;
      return baseline;
    });
    if (dir && metaPath)
      await saveCache(dir, metaPath, {
        identity: id,
        checksum: digest([runtime, id]),
      });
    return id;
  }
  const identity = await currentIdentity();
  const key = nativeChanCacheKey({
    symbol,
    firstIndex,
    barsDigest,
    dllIdentity: identity,
    projectionVersion,
  });
  const path = dir ? join(dir, `chan-${key}.json`) : undefined;
  if (dir && path) {
    const entry = await readCache<CacheEntry>(dir, path);
    if (
      entry &&
      Object.entries(common).every(
        ([k, v]) => entry[k as keyof CacheEntry] === v,
      ) &&
      entry.projectionVersion === projectionVersion &&
      isDeepStrictEqual(entry.identity, identity) &&
      isDeepStrictEqual(entry.observations?.[0]?.identity, identity) &&
      [entry.auditCount, entry.pendingCount].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      ) &&
      Number.isFinite(entry.captureElapsedMs) &&
      entry.captureElapsedMs >= 0
    ) {
      try {
        validateEvidence(
          instrument,
          firstIndex,
          entry.observations,
          barsDigest,
          projectionVersion,
        );
        return {
          entry,
          cached: true,
          captureElapsedMs: entry.captureElapsedMs,
          cacheLoadMs: Date.now() - tLoad,
        };
      } catch {
        /* Recapture malformed frozen evidence. */
      }
    }
  }

  const t0 = Date.now();
  const capture = await (
    options.captureNative ?? captureNativeChanObservations
  )(
    bars,
    firstIndex,
    undefined,
    async (input, request) => {
      if (baseline && input.close.length === firstIndex) {
        const raw = baseline;
        baseline = undefined;
        return raw;
      }
      return project(input, request);
    },
    (done, total) => options.nativeProgress?.(symbol, done, total),
    projectionVersion === 3 ? "v3" : undefined,
  );
  const captureElapsedMs = baselineElapsedMs + Date.now() - t0;
  if (
    !isDeepStrictEqual(identity, capture.identity) ||
    !isDeepStrictEqual(identity, capture.observations[0]?.identity)
  )
    throw new Error("原生捕获身份与当前DLL或配置不一致");
  validateEvidence(
    instrument,
    firstIndex,
    capture.observations,
    barsDigest,
    projectionVersion,
  );
  const entry: CacheEntry = {
    ...common,
    projectionVersion,
    identity,
    observations: capture.observations,
    captureElapsedMs,
    auditCount: capture.audit.length,
    pendingCount: capture.pending.length,
  };
  if (dir && path) await saveCache(dir, path, entry);
  return { entry, cached: false, captureElapsedMs, cacheLoadMs: null };
}

type Attachment = Pick<FrozenLabBacktest, "sources" | "request">;
export type NativeChanMultiDisclosure = NativeChanDisclosure & {
  projectionVersion: NativeChanProjectionVersion;
  dllHash: string;
  mode: "frozen-replay" | "current-dll-compute";
  captureMetricsAvailable: boolean;
  zdStop?: {
    levelCount: number;
    entrySignalsMissingZd: number;
    boundary: string;
  };
  zdAtrStop?: NativeChanMultiDisclosure["zdStop"];
};

export async function attachNativeChanMulti(
  frozen: Attachment,
  options: NativeChanOptions = {},
): Promise<NativeChanMultiDisclosure[]> {
  const { instruments, start } = frozen.request;
  const mixedBook =
    frozen.request.strategies.length > 1 &&
    frozen.request.strategies.some(
      (strategy) =>
        !usesNativeChan(strategy) &&
        !(
          strategy.entry.kind === "external" &&
          isNativeChanV3Profile(strategy.entry.id)
        ),
    );
  const perInstrument =
    options.perInstrumentWarmup || instruments.length > 1 || mixedBook;
  const indices = instruments.map(({ symbol, signalBars }) => {
    const first = signalBars.findIndex((bar) => bar.date.slice(0, 10) >= start);
    if (perInstrument) return Math.max(first, nativeStudyDefinition.warmupBars);
    if (first < nativeStudyDefinition.warmupBars)
      throw new Error(
        `${symbol}：原生缠论需要至少 ${nativeStudyDefinition.warmupBars} 根预热行情（当前仅 ${Math.max(0, first)} 根）`,
      );
    return first;
  });
  function bind(
    rule: StrategyObjectInput["entry"],
  ): StrategyObjectInput["entry"] {
    if (
      (rule.kind !== "chan-native" && rule.kind !== "chan-third-buy") ||
      rule.firstIndex === undefined
    )
      return rule;
    if (!perInstrument) {
      if (rule.kind === "chan-third-buy")
        return { ...rule, firstIndex: indices[0] };
      if (rule.firstIndex !== indices[0])
        throw new Error("原生观察基线与显式执行起点不一致");
      return rule;
    }
    const { firstIndex: _first, ...unbound } = rule;
    return unbound;
  }
  const strategies = frozen.request.strategies.map((s) => ({
    ...s,
    entry: bind(s.entry),
    exit: s.exit.rule ? { ...s.exit, rule: bind(s.exit.rule) } : s.exit,
  }));
  const stopFields = new Set(
    strategies.flatMap(({ exit }) =>
      exit.stop?.kind === "structure" ? [exit.stop.field] : [],
    ),
  );
  const usesZdStop = stopFields.has(zdStopField);
  const usesZdAtrStop = stopFields.has(zdAtrStopField);
  const v3Profiles = new Set(
    strategies.flatMap(({ entry }) =>
      entry.kind === "external" && isNativeChanV3Profile(entry.id)
        ? [entry.id]
        : [],
    ),
  );
  const captureOptions = v3Profiles.size
    ? { ...options, projectionVersion: 3 as const }
    : options;
  const results = [];
  for (const [i, instrument] of instruments.entries()) {
    if (indices[i]! >= instrument.signalBars.length) continue;
    const result = await loadNativeObservations(
      instrument,
      indices[i]!,
      captureOptions,
    );
    if ((usesZdStop || usesZdAtrStop) && result.entry.projectionVersion === 1)
      throw new Error(
        `${instrument.symbol}：CH14 结构止损需要 v2 冻结买卖点观察`,
      );
    const v3Signals = [...v3Profiles].flatMap((profile) => {
      const { signalBars } = instrument;
      const { observations, firstIndex } = result.entry;
      const rule = createNativeChanProfileRule(
        profile,
        signalBars,
        observations,
        firstIndex,
      );
      return observations.map(({ date }, offset) => ({
        id: profile,
        date,
        availableAt: date,
        entry: rule(firstIndex - 1 + offset).enter,
        exit: null,
      }));
    });
    results.push({ ...result, v3Signals, instrument });
  }
  frozen.request.strategies = strategies;
  const disclosures = results.map(
    ({
      entry,
      cached,
      captureElapsedMs,
      cacheLoadMs,
      v3Signals,
      instrument,
    }) => {
      instrument.external = {
        ...instrument.external,
        chan: entry.observations,
      };
      if (v3Signals.length) {
        instrument.external.signals = [
          ...(instrument.external.signals ?? []).filter(
            ({ id }) => !isNativeChanV3Profile(id) || !v3Profiles.has(id),
          ),
          ...v3Signals,
        ];
      }
      function attachStopLevels(
        field: string,
        levels: NonNullable<StrategyExternalInputs["levels"]>,
        boundary: string,
      ) {
        const dates = new Set(levels.map(({ date }) => date));
        const external = instrument.external!;
        external.levels = [
          ...(external.levels ?? []).filter((row) => row.field !== field),
          ...levels,
        ];
        return {
          levelCount: levels.length,
          entrySignalsMissingZd: entry.observations.filter(
            (row) =>
              !row.baseline &&
              row.points?.some((point) => point.kind > 0) &&
              !dates.has(row.date),
          ).length,
          boundary:
            boundary +
            "初始止损缺失或换算后不低于实际入场价，由引擎按「缺失或无效初始止损」拒单并记录。",
        };
      }
      const zdStop = usesZdStop
        ? attachStopLevels(
            zdStopField,
            buildNativeChanZdLevels(entry.observations),
            "只使用该收盘观察的原生买卖点所属中枢 ZD，空观察日不沿用旧位。",
          )
        : undefined;
      const zdAtrStop = usesZdAtrStop
        ? attachStopLevels(
            zdAtrStopField,
            buildNativeChanZdAtrLevels(
              entry.observations,
              instrument.signalBars,
            ),
            "只使用该收盘同尺度信号行情前缀的 ZD − 1.0 × ATR(14)，缺失或非正的结构位不可用。",
          )
        : undefined;
      const source = frozen.sources.find((s) => s.symbol === instrument.symbol);
      const proof = source?.causalPrice as CausalPriceProof | undefined;
      const previous = source?.nativeChan as
        Partial<NativeChanMultiDisclosure> | undefined;
      const recorded =
        options.mode === "frozen-replay" &&
        previous &&
        previous.captureMetricsAvailable !== false &&
        previous.firstIndex === entry.firstIndex &&
        previous.baselineDate === entry.baselineDate &&
        previous.originDate === entry.originDate &&
        previous.prefixCount === entry.observations.length &&
        (entry.projectionVersion !== 3 || previous.projectionVersion === 3) &&
        isDeepStrictEqual(previous.identity, entry.identity) &&
        [previous.auditCount, previous.pendingCount].every(
          (n) => Number.isSafeInteger(n) && n! >= 0,
        ) &&
        typeof previous.captureElapsedMs === "number" &&
        Number.isFinite(previous.captureElapsedMs) &&
        previous.captureElapsedMs >= 0
          ? previous
          : undefined;
      const disclosure: NativeChanMultiDisclosure = {
        symbol: instrument.symbol,
        mode: options.mode ?? "current-dll-compute",
        identity: entry.identity,
        dllHash: entry.identity.dllHash,
        projectionVersion: entry.projectionVersion,
        firstIndex: entry.firstIndex,
        originDate: entry.originDate,
        baselineDate: entry.baselineDate,
        prefixCount: entry.observations.length,
        cached,
        captureElapsedMs: recorded?.captureElapsedMs ?? captureElapsedMs,
        cacheLoadMs,
        captureMetricsAvailable: options.mode !== "frozen-replay" || !!recorded,
        auditCount: recorded?.auditCount ?? entry.auditCount,
        pendingCount: recorded?.pendingCount ?? entry.pendingCount,
        ...(zdStop && { zdStop }),
        ...(zdAtrStop && { zdAtrStop }),
        signalPriceBasis:
          proof?.kind ??
          (typeof source?.adjustment === "string" ? source.adjustment : null),
      };
      if (source) source.nativeChan = disclosure;
      else
        frozen.sources.push({
          symbol: instrument.symbol,
          nativeChan: disclosure,
        });
      return disclosure;
    },
  );
  const captured = new Map(disclosures.map((row) => [row.symbol, row]));
  const reference = disclosures[0];
  if (!reference && !mixedBook)
    throw new Error(
      `原生缠论需要至少 ${nativeStudyDefinition.warmupBars} 根预热行情和一根执行行情`,
    );
  const mode = options.mode ?? "current-dll-compute";
  const identity =
    reference?.identity ??
    (mode === "current-dll-compute"
      ? await (options.resolveIdentity?.() ??
          getCurrentCzscIdentity(options.project))
      : instruments[0]?.external?.chan?.[0]?.identity);
  if (!identity) throw new Error("原生观察缺少冻结的DLL身份");
  return instruments.map((instrument) => {
    const row = captured.get(instrument.symbol);
    if (row) return row;
    const source = frozen.sources.find((s) => s.symbol === instrument.symbol);
    const skipped: NativeChanMultiDisclosure = {
      symbol: instrument.symbol,
      insufficientWarmup: {
        availableBars: instrument.signalBars.length,
        requiredWarmupBars: nativeStudyDefinition.warmupBars,
      },
      // The projection identity is shared by this capture batch.
      identity,
      dllHash: identity.dllHash,
      mode,
      projectionVersion:
        reference?.projectionVersion ?? captureOptions.projectionVersion ?? 2,
      firstIndex: nativeStudyDefinition.warmupBars,
      originDate: instrument.signalBars[0]?.date ?? "",
      baselineDate: "",
      prefixCount: 0,
      cached: false,
      captureElapsedMs: 0,
      captureMetricsAvailable: false,
      auditCount: 0,
      pendingCount: 0,
      signalPriceBasis: source?.causalPrice
        ? (source.causalPrice as CausalPriceProof).kind
        : null,
    };
    if (mixedBook) {
      // Freeze the known warmup gap for Lab replay. This is neither a baseline
      // nor an executable observation; native validation rejects it as either.
      instrument.external = {
        ...instrument.external,
        chan: [
          {
            date: instrument.signalBars.at(-1)!.date,
            prefixHash: digest(instrument.signalBars),
            identity,
            baseline: false,
            signals: [],
            gaps: ["insufficient-warmup"],
          },
        ],
      };
    }
    if (source) source.nativeChan = skipped;
    return skipped;
  });
}
