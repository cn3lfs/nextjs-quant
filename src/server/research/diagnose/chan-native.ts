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
import type { PortfolioInstrument } from "quant-backtest";
import {
  createNativeChanProfileRule,
  createNativeStudyRule,
  nativeStudyDefinition,
  type FrozenChanObservation,
  type FrozenChanPoint,
  type NativeStudyIdentity,
  type StrategyExternalInputs,
  type StrategyObjectInput,
} from "trading-strategies";
import type { CausalPriceProof } from "../causal-price-basis";
import type { FrozenLabBacktest } from "../lab-backtest";
import { captureNativeChanObservations } from "../../strategies/strategy-center-native";
import {
  czscRuntimeFingerprint,
  getCurrentCzscIdentity,
  nativeIdentityFromSnapshot,
  projectCzsc,
  type CzscSnapshot,
} from "../../strategies/chan/czsc";
import type { NativeChanDisclosure } from "./types";

export const NATIVE_CHAN_CACHE_VERSION = "chan-native-cache-2";
export const NATIVE_CHAN_ZD_STOP_KEY = "research-chan-hold-cash-zd-stop";
const zdStopField = "chan-zd";

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

export function buildNativeChanZdLevels(
  observations: readonly FrozenChanObservation[],
): NonNullable<StrategyExternalInputs["levels"]> {
  return observations.flatMap((row) => {
    if (row.projectionVersion !== 2) return [];
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

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function nativeChanCacheKey(input: {
  symbol: string;
  firstIndex: number;
  barsDigest: string;
  dllIdentity: NativeStudyIdentity;
  projectionVersion: number;
}) {
  const {
    symbol,
    firstIndex,
    barsDigest,
    projectionVersion,
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
  ]);
}

export type NativeChanOptions = {
  mode?: "current-dll-compute" | "frozen-replay";
  nativeCacheDir?: string;
  captureNative?: typeof captureNativeChanObservations;
  project?: typeof projectCzsc;
  resolveIdentity?: () => Promise<NativeStudyIdentity>;
  nativeProgress?: (symbol: string, done: number, total: number) => void;
};

type CacheEntry = {
  version: typeof NATIVE_CHAN_CACHE_VERSION;
  projectionVersion: 1 | 2;
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
  version: 1 | 2,
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
        { levels: [0], bars: false },
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
  const projectionVersion = 2;
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
  projectionVersion: 1 | 2;
  dllHash: string;
  mode: "frozen-replay" | "current-dll-compute";
  captureMetricsAvailable: boolean;
  zdStop?: {
    levelCount: number;
    entrySignalsMissingZd: number;
    boundary: string;
  };
};

export async function attachNativeChanMulti(
  frozen: Attachment,
  options: NativeChanOptions = {},
): Promise<NativeChanMultiDisclosure[]> {
  const { instruments, start } = frozen.request;
  const indices = instruments.map(({ symbol, signalBars }) => {
    const first = signalBars.findIndex((bar) => bar.date.slice(0, 10) >= start);
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
    if (instruments.length === 1) {
      if (rule.kind === "chan-third-buy")
        return { ...rule, firstIndex: indices[0] };
      if (rule.firstIndex !== indices[0])
        throw new Error("原生观察基线与显式执行起点不一致");
      return rule;
    }
    const { firstIndex: _first, ...perInstrument } = rule;
    return perInstrument;
  }
  const strategies = frozen.request.strategies.map((s) => ({
    ...s,
    entry: bind(s.entry),
    exit: s.exit.rule ? { ...s.exit, rule: bind(s.exit.rule) } : s.exit,
  }));
  const usesZdStop = strategies.some(
    ({ exit }) =>
      exit.stop?.kind === "structure" && exit.stop.field === zdStopField,
  );
  const results = [];
  for (const [i, instrument] of instruments.entries()) {
    const result = await loadNativeObservations(
      instrument,
      indices[i]!,
      options,
    );
    if (usesZdStop && result.entry.projectionVersion !== 2)
      throw new Error(
        `${instrument.symbol}：CH14 结构止损需要 v2 冻结买卖点观察`,
      );
    results.push(result);
  }
  frozen.request.strategies = strategies;
  return results.map(({ entry, cached, captureElapsedMs, cacheLoadMs }, i) => {
    const instrument = instruments[i]!;
    instrument.external = { ...instrument.external, chan: entry.observations };
    let zdStop: NativeChanMultiDisclosure["zdStop"];
    if (usesZdStop) {
      const levels = buildNativeChanZdLevels(entry.observations);
      const dates = new Set(levels.map(({ date }) => date));
      instrument.external.levels = [
        ...(instrument.external.levels ?? []).filter(
          ({ field }) => field !== zdStopField,
        ),
        ...levels,
      ];
      zdStop = {
        levelCount: levels.length,
        entrySignalsMissingZd: entry.observations.filter(
          (row) =>
            !row.baseline &&
            row.points?.some((point) => point.kind > 0) &&
            !dates.has(row.date),
        ).length,
        boundary:
          "只使用该收盘观察的原生买卖点所属中枢 ZD，空观察日不沿用旧位。" +
          "初始止损缺失或换算后不低于实际入场价，由引擎按「缺失或无效初始止损」拒单并记录。",
      };
    }
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
  });
}
