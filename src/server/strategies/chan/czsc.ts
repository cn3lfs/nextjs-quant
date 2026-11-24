import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { NativeStudyIdentity } from "trading-strategies";
import { execFile, fork, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { runIfJobRunning } from "../../db/jobs";
import { recordRuntimeError } from "../../infra/runtime-errors";
import { resolve } from "node:path";
import { isMainThread } from "node:worker_threads";
import type { CzscInput } from "./czsc-input";
import {
  czscOverrides,
  type CzscConfigSchema,
  type CzscSettings,
} from "~/lib/chart/czsc-settings";
import type { Bar } from "~/lib/domain";
import {
  CZSC_CTX,
  czscSourceCommit,
  type CzscFamily,
  type CzscHighCandidate,
  type CzscNativeProjection,
  type CzscNestedStructure,
  type CzscResult,
  type CzscSignalStructure,
} from "trading-strategies/research/chan/czsc";
import { decodeCzscMovements, decodeCzscRecursive } from "./czsc-recursive";
import {
  type CzscRawDivergence,
  type CzscRequest,
  type CzscRawFamily,
  type CzscSnapshot,
} from "./czsc-api";

export type { CzscSnapshot } from "./czsc-api";

const scope = globalThis as typeof globalThis & {
  czscWorker?: ChildProcess;
  czscQueue?: Promise<unknown>;
  czscRequestId?: number;
  czscSchema?: Promise<CzscConfigSchema>;
  czscClosed?: Promise<void>;
  czscIdleTimer?: NodeJS.Timeout;
  czscStats?: {
    requests: number;
    cancellations: number;
    timeouts: number;
    pending: number;
    lastQueueWaitMs: number | null;
    lastDllCallMs: number | null;
  };
};

const stats = (scope.czscStats ??= {
  requests: 0,
  cancellations: 0,
  timeouts: 0,
  pending: 0,
  lastQueueWaitMs: null,
  lastDllCallMs: null,
});
function duration(value: string | undefined, fallback: number) {
  const ms = Number(value);
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 2_147_483_647
    ? ms
    : fallback;
}

/** Host-lifetime counts for queue submissions, skips at dispatch and timed-out
 * requests. DLL call time includes the IPC round trip and cold worker startup.
 * RSS is sampled only here and is null when no live reading is available. */
export async function getCzscTelemetry() {
  const child = scope.czscWorker;
  const pid = child?.pid;
  let workerRssBytes: number | null = null;
  if (pid) {
    const windows = process.platform === "win32";
    try {
      const { stdout } = await promisify(execFile)(
        windows ? "tasklist.exe" : "ps",
        windows
          ? ["/fi", `PID eq ${pid}`, "/fo", "csv", "/nh"]
          : ["-o", "rss=", "-p", String(pid)],
        { windowsHide: true, timeout: 3000 },
      );
      const kib = windows
        ? stdout
            .trim()
            .match(/,"([\d.,\s]+)\s*K"$/i)?.[1]
            ?.replace(/\D/g, "")
        : stdout.trim();
      if (kib && Number(kib) > 0 && scope.czscWorker === child)
        workerRssBytes = Number(kib) * 1024;
    } catch {
      // Sandboxed OS queries or a worker exiting during sampling have no reading.
    }
  }
  return { ...stats, workerPid: scope.czscWorker?.pid ?? null, workerRssBytes };
}

function forgetWorker(child: ChildProcess) {
  if (scope.czscWorker !== child) return;
  scope.czscWorker = undefined;
  scope.czscSchema = undefined;
  scope.czscClosed = undefined;
}

function workerExit(child: ChildProcess) {
  return (scope.czscClosed ??= new Promise<void>((done) => {
    const stopped = () => {
      child.off("exit", stopped);
      child.off("close", stopped);
      forgetWorker(child);
      done();
    };
    // Parent-initiated IPC disconnect can produce exit without close on
    // Windows. Failed spawns, conversely, can produce close without exit.
    child.once("exit", stopped).once("close", stopped);
  }));
}

/** Reserve the queue until exit, or detach this PID after the kill deadline. */
function retireWorker(
  child: ChildProcess,
  closed: Promise<void>,
  graceful = false,
) {
  forgetWorker(child);
  const report = (error: unknown) => recordRuntimeError("czsc-worker", error);
  // Kill/disconnect may emit errors even after the deadline and a replacement fork.
  child.on("error", report);
  const disconnect = () => {
    try {
      if (child.connected) child.disconnect();
    } catch (error) {
      report(error);
    }
  };
  return new Promise<void>((done) => {
    let timer: NodeJS.Timeout;
    const force = () => {
      timer = setTimeout(
        () => {
          report(
            Object.assign(new Error("CZSC worker did not exit after SIGKILL"), {
              code: "ETIMEDOUT",
            }),
          );
          child.channel?.unref();
          child.unref();
          disconnect();
          done();
        },
        duration(process.env.QUANT_CZSC_KILL_GRACE_MS, 5000),
      );
      try {
        child.kill("SIGKILL");
      } catch (error) {
        report(error);
      }
    };
    void closed.then(() => {
      clearTimeout(timer);
      done();
    });
    if (graceful) {
      timer = setTimeout(force, 1000);
      disconnect();
    } else force();
  });
}

function worker() {
  return (scope.czscWorker ??= fork(resolve("runtime/czsc-worker.cjs"), [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    execArgv: [],
  }));
}

/** One api v22 build (both levels by default) in the serial DLL worker. */
export function projectCzsc(
  input: CzscInput,
  request: CzscRequest = {},
  shouldSkip?: () => boolean,
  jobId?: string,
): Promise<CzscSnapshot> {
  return dispatch<CzscSnapshot>(
    {
      input: structuredClone(input),
      request: structuredClone(request),
    },
    shouldSkip,
    jobId,
  );
}

export function nativeIdentityFromSnapshot(
  raw: Pick<CzscSnapshot, "hash" | "apiVersion" | "buildCommit" | "configId">,
): NativeStudyIdentity {
  if (
    !/^[a-f0-9]{64}$/.test(raw.hash) ||
    raw.apiVersion !== 22 ||
    typeof raw.buildCommit !== "string" ||
    !raw.buildCommit.trim() ||
    typeof raw.configId !== "string" ||
    !raw.configId.trim()
  )
    throw new Error("原生DLL身份元数据缺失或无效");
  return {
    dllHash: raw.hash,
    apiVersion: raw.apiVersion,
    buildCommit: raw.buildCommit,
    configId: raw.configId,
    config: 0,
    anchor: 1,
  };
}

// Default config metadata is a function of these two exact binaries.
export async function czscRuntimeFingerprint() {
  const hash = (bytes: Buffer) =>
    createHash("sha256").update(bytes).digest("hex");
  const [dllHash, workerHash] = await Promise.all([
    readFile(resolve("runtime/czsc/CZSC64.dll")).then(hash),
    readFile(resolve("runtime/czsc-worker.cjs")).then(hash),
  ]);
  return { dllHash, workerHash };
}

let lastDefaults:
  { fingerprint: string; identity: NativeStudyIdentity } | undefined;

/** On a cold process the caller can supply its first real prefix as the probe,
 * then consume that same snapshot in capture. No independent projection pool. */
export async function getCurrentCzscIdentity(
  project: typeof projectCzsc = projectCzsc,
  runtime?: Awaited<ReturnType<typeof czscRuntimeFingerprint>>,
  probe?: () => Promise<CzscSnapshot>,
  shouldSkip?: () => boolean,
  jobId?: string,
): Promise<NativeStudyIdentity> {
  const local =
    runtime ??
    (project === projectCzsc ? await czscRuntimeFingerprint() : undefined);
  const fingerprint = local && JSON.stringify(local);
  if (fingerprint && lastDefaults?.fingerprint === fingerprint)
    return { ...lastDefaults.identity };
  const raw = await (probe?.() ??
    project(
      { high: [1], low: [1], close: [1], volume: [1] },
      { levels: [0], bars: false },
      shouldSkip,
      jobId,
    ));
  const identity = nativeIdentityFromSnapshot(raw);
  if (local && identity.dllHash !== local.dllHash)
    throw new Error("运行中的原生DLL与当前文件身份不符");
  if (fingerprint) lastDefaults = { fingerprint, identity };
  return { ...identity };
}

/** v22 configuration schema, read once per worker lifetime. */
export function czscConfigSchema(): Promise<CzscConfigSchema> {
  return (scope.czscSchema ??= dispatch<CzscConfigSchema>({
    schema: true,
  }).catch((error: unknown) => {
    scope.czscSchema = undefined;
    throw error;
  }));
}

function sendToWorker<T>(
  message: Record<string, unknown>,
  resolveResult: (value: T) => void,
  reject: (reason: Error) => void,
) {
  const child = worker();
  child.ref();
  child.channel?.ref();
  const closed = workerExit(child);
  const id = (scope.czscRequestId = (scope.czscRequestId ?? 0) + 1);
  const started = performance.now();
  let settled = false;
  const cleanup = () => {
    settled = true;
    stats.lastDllCallMs = performance.now() - started;
    clearTimeout(timeout);
    child.off("message", onMessage);
    child.off("exit", onExit);
    child.off("disconnect", onDisconnect);
  };
  const fail = (error: Error) => {
    if (settled) return;
    cleanup();
    void retireWorker(child, closed).then(() => reject(error));
    child.off("error", fail);
  };
  const onExit = (code: number | null) =>
    fail(new Error(`CZSC worker exited (${code})`));
  const onDisconnect = () => fail(new Error("CZSC worker disconnected"));
  const onMessage = (reply: { id: number; result: T; error?: string }) => {
    if (reply.id !== id) return;
    cleanup();
    child.off("error", fail);
    if (reply.error) reject(new Error(reply.error));
    else resolveResult(reply.result);
  };
  const timeout = setTimeout(
    () => {
      stats.timeouts++;
      fail(
        Object.assign(new Error("CZSC worker IPC timeout"), {
          code: "ETIMEDOUT",
        }),
      );
    },
    duration(process.env.QUANT_CZSC_TIMEOUT_MS, 60_000),
  );
  child
    .on("message", onMessage)
    .once("exit", onExit)
    .once("disconnect", onDisconnect)
    .once("error", fail);
  try {
    child.send({ id, ...message }, (error) => {
      if (error) fail(error);
    });
  } catch (error) {
    fail(error as Error);
  }
}

function dispatch<T>(
  message: Record<string, unknown>,
  shouldSkip?: () => boolean,
  jobId?: string,
): Promise<T> {
  if (!isMainThread)
    return Promise.reject(
      new Error("原生缠论工作进程只能由主线程创建，请通过主线程代理调用"),
    );
  const queuedAt = performance.now();
  stats.requests++;
  stats.pending++;
  clearTimeout(scope.czscIdleTimer);
  const job = (scope.czscQueue ?? Promise.resolve())
    .then(
      () =>
        new Promise<T>((resolveResult, reject) => {
          stats.lastQueueWaitMs = performance.now() - queuedAt;
          if (shouldSkip?.()) {
            stats.cancellations++;
            throw new DOMException("任务已取消", "AbortError");
          }
          const send = () => {
            sendToWorker<T>(message, resolveResult, reject);
          };
          // A cancelling writer cannot commit between the status check and IPC submission.
          // Only the synchronous send is inside the reservation, never the DLL round trip.
          if (jobId) {
            if (!runIfJobRunning(jobId, send)) {
              stats.cancellations++;
              throw new DOMException("任务已取消", "AbortError");
            }
          } else {
            send();
          }
        }),
    )
    .finally(() => {
      stats.pending--;
      if (!stats.pending && scope.czscWorker) {
        scope.czscWorker.unref();
        scope.czscWorker.channel?.unref();
        scope.czscIdleTimer = setTimeout(
          () => {
            void closeCzsc();
          },
          duration(process.env.QUANT_CZSC_IDLE_TTL_MS, 60_000),
        ).unref();
      }
    });
  scope.czscQueue = job.catch((error) => {
    recordRuntimeError("czsc-worker", error);
  });
  return job;
}

export function closeCzsc(): Promise<void> {
  // Enqueue the shutdown itself so a simultaneous request waits for the old PID.
  const closing = (scope.czscQueue ?? Promise.resolve()).then(async () => {
    clearTimeout(scope.czscIdleTimer);
    const child = scope.czscWorker;
    if (!child) return;
    child.ref();
    await retireWorker(child, workerExit(child), true);
  });
  scope.czscQueue = closing.catch((error) => {
    recordRuntimeError("czsc-worker", error);
  });
  return closing;
}

/** One-based table id; 0 = absent (native -1). */
const id = (index: number) => (index >= 0 ? index + 1 : 0);

const percent = (current: number, previous: number) =>
  previous > 0 ? (current / previous) * 100 : 0;

function divergenceOf(d: CzscRawDivergence, kind: number, context: number) {
  return {
    areaRatio: percent(d.curArea, d.prevArea),
    priceRatio: percent(d.curSpace, d.prevSpace),
    speedRatio: percent(d.curSpeed, d.prevSpeed),
    // 1 new extreme / 2 weak space / 4 weak speed / 8 weak MACD area / 16 holds.
    flags:
      (d.newExtreme ? 1 : 0) |
      (d.weakSpace ? 2 : 0) |
      (d.weakSpeed ? 4 : 0) |
      (d.weakArea ? 8 : 0) |
      (d.holds ? 16 : 0),
    // 3 = third-class point satisfying the lesson-44 small-turn necessary condition.
    semantic:
      Math.abs(kind) === 3 && context & CZSC_CTX.smallTurn ? 3 : d.semantic,
  };
}

function decodeFamily(
  raw: CzscRawFamily,
  config: 0 | 1100,
  bars: readonly Bar[],
  signalDetails: boolean,
  structures: boolean,
): CzscFamily {
  const hindsight = raw.signals
    .map((signal, row) => ({ signal, row }))
    .filter(({ signal }) => signal.hindsight === 1)
    .sort((a, b) => a.signal.index - b.signal.index);
  const empty: CzscFamily = {
    config,
    points: [],
    centers: [],
    signals: [],
    movements: [],
    qualities: [],
    divergences: [],
  };
  // A single endpoint cannot form a stroke/segment. Do not render a false structure.
  if (raw.pivots.length < 2)
    return structures ? { ...empty, breakouts: [] } : empty;
  const structure = (
    s: CzscRawFamily["signals"][number],
  ): CzscSignalStructure => {
    const b = s.breakout >= 0 ? raw.breakouts[s.breakout] : undefined;
    const d = s.divergence;
    return {
      contextFlags: s.context,
      pointId: id(s.pivot),
      trendId: id(s.movement),
      breakoutId: id(s.breakout),
      leavePointId: id(b?.leavePivot ?? -1),
      retestPointId: id(b?.retestPivot ?? -1),
      secondBasePointId: id(s.secondBasePivot),
      secondTurnPointId: id(s.secondTurnPivot),
      smallTurnBasePointId: id(s.smallTurnBasePivot),
      smallTurnLeavePointId: id(s.smallTurnLeavePivot),
      smallTurnRetestPointId: id(s.smallTurnRetestPivot),
      previousStartPointId: id(d.prevStart),
      previousEndPointId: id(d.prevEnd),
      currentStartPointId: id(d.curStart),
      currentEndPointId: id(d.curEnd),
      centerLifecycle:
        s.center >= 0 ? (raw.centers[s.center]?.lifecycle ?? 0) : 0,
    };
  };
  const signals: CzscFamily["signals"] = hindsight.map(({ signal: s }) => ({
    index: s.index,
    date: bars[s.index]!.date,
    kind: s.type,
    quality: s.quality,
    confirmedAt: s.confirmedAt,
    revokedAt: s.revokedAt,
    stop: s.stop,
    ...(signalDetails
      ? {
          centerId: id(s.center),
          divergence: divergenceOf(s.divergence, s.type, s.context),
          ...(structures ? { structure: structure(s) } : {}),
        }
      : {}),
  }));
  // Divergence intervals are analysis spans: use the true extreme (api v8).
  const pivotIndex = (p: number) => raw.pivots[p]?.extremeIndex;
  const divergences: CzscFamily["divergences"] = hindsight.flatMap(
    ({ signal: s }) => {
      const start = pivotIndex(s.divergence.curStart),
        end = pivotIndex(s.divergence.curEnd);
      return Math.abs(s.type) === 1 &&
        s.divergence.holds &&
        start !== undefined &&
        end !== undefined
        ? [{ start, end, direction: -Math.sign(s.type) }]
        : [];
    },
  );
  return {
    config,
    points: raw.pivots.map((p) => ({
      index: p.index,
      date: bars[p.index]!.date,
      direction: p.kind,
      price: p.price,
      confirmedAt: p.confirmedAt,
    })),
    centers: raw.centers.map((c) => ({
      established: c.established,
      start: c.start,
      end: c.end,
      startDate: bars[c.start]!.date,
      endDate: bars[c.end]!.date,
      direction: c.direction,
      ZG: c.zg,
      ZD: c.zd,
      GG: c.gg,
      DD: c.dd,
      confirmedAt: c.confirmedAt,
      relation: c.relationToPrev,
      lifecycle: c.lifecycle,
    })),
    ...(structures
      ? {
          breakouts: (raw.breakouts ?? []).map((b) => ({
            centerId: id(b.center),
            direction: (b.direction >= 0 ? 1 : -1) as 1 | -1,
            leavePointId: id(b.leavePivot),
            retestPointId: id(b.retestPivot),
            third: b.third === 1,
            confirmedAt: b.confirmedAt,
            divergence: divergenceOf(b.divergence, 2, 0),
          })),
        }
      : {}),
    signals,
    divergences,
    movements: hindsight.map(({ signal: s }) => ({
      index: s.index,
      direction: s.movement >= 0 ? (raw.movements[s.movement]?.type ?? 0) : 0,
    })),
    qualities: signals.map((s) => ({ index: s.index, value: s.quality })),
  };
}

function decodeNative(
  raw: CzscRawFamily,
  high: CzscRawFamily | undefined,
  config: 0 | 1100,
): CzscNativeProjection {
  const trends = raw.movements.map((m, i) => ({
    id: i + 1,
    config,
    unit: config === 0 ? 1 : 2,
    type: m.type,
    start: m.start,
    end: m.end,
    firstCenterId: m.firstCenter + 1,
    lastCenterId: m.lastCenter + 1,
    memberCenterIds: Array.from(
      { length: m.lastCenter - m.firstCenter + 1 },
      (_, k) => m.firstCenter + 1 + k,
    ),
    completedAt: m.completedAt >= 0 ? m.completedAt : null,
    completedByIndex: m.completedByIndex,
    confirmedAt: m.confirmedAt,
  }));
  // Higher-level candidates are the config-1100 first-class signals (all lives
  // in hindsight), identical for both families.
  const highCandidates: CzscHighCandidate[] = (high?.signals ?? []).flatMap(
    (s, row) => {
      if (s.hindsight !== 1 || Math.abs(s.type) !== 1) return [];
      const d = s.divergence;
      const at = (p: number) => high!.pivots[p]?.extremeIndex ?? null;
      return [
        {
          id: row + 1,
          config: 1100 as const,
          index: s.index,
          kind: s.type,
          pointId: id(s.pivot),
          pointConfirmedAt: high!.pivots[s.pivot]?.confirmedAt,
          segmentStartPointId: id(d.curStart),
          segmentEndPointId: id(d.curEnd),
          segmentStart: at(d.curStart),
          segmentEnd: at(d.curEnd),
          semantic: d.semantic,
          divergence: d.holds === 1,
          trendId: id(s.movement),
          centerId: id(s.center),
          source: 1,
          priority: 0,
          quality: s.quality,
          unit: 2 as const,
          newExtreme: d.newExtreme === 1,
          weakSpace: d.weakSpace === 1,
          weakSpeed: d.weakSpeed === 1,
          weakMacd: d.weakArea === 1,
          currentStart: at(d.curStart),
          currentEnd: at(d.curEnd),
        },
      ];
    },
  );
  return {
    version: czscSourceCommit,
    config,
    trends,
    highCandidates,
    completedSequence: "unavailable",
  };
}

export async function analyzeCzsc(
  bars: readonly Bar[],
  signalDetails = false,
  project: typeof projectCzsc = projectCzsc,
  researchStructures = false,
  anchor?: 1 | 2 | 3,
  movements = false,
  /** Chart-only structure settings (schema keys); research keeps DLL defaults. */
  settings?: CzscSettings,
  /** Chart view needs the same structural tables as research, with custom settings. */
  chartStructures = false,
): Promise<CzscResult> {
  if (researchStructures && settings)
    throw new Error("研究结构锁定默认配置（原0/1100）");
  if (movements && (!anchor || !signalDetails || !researchStructures))
    throw new Error("C4读取必须启用显式锚及完整结构表");
  if (
    bars.some(
      (bar, i) =>
        !Number.isFinite(Date.parse(bar.date)) ||
        (i > 0 && Date.parse(bar.date) <= Date.parse(bars[i - 1]!.date)),
    )
  )
    throw new RangeError("CZSC bars must be in strictly ascending time order");
  const input = {
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: bars.map((b) => b.close),
    volume: bars.map((b) => b.volume),
  };
  const fullStructures =
    signalDetails && (researchStructures || chartStructures);
  const raw = await project(input, {
    ...(settings ? czscOverrides(settings) : {}),
    recursion: fullStructures,
    nested: fullStructures,
    bars: fullStructures,
  });
  const families: CzscFamily[] = ([0, 1100] as const).map((config) => {
    const family = raw.families[config];
    if (!family)
      throw new Error(`结构缺口：缺少${config ? "线段" : "笔"}级快照`);
    const decoded = decodeFamily(
      family,
      config,
      bars,
      signalDetails,
      fullStructures,
    );
    if (!fullStructures) return decoded;
    const lowSignals = raw.families[0]!.signals;
    const nested: CzscNestedStructure[] =
      config === 0
        ? raw.nested.flatMap((n) => {
            const s = lowSignals[n.lowSignal];
            if (!s) return [];
            return [
              {
                lowConfig: 0 as const,
                sourceConfig: 1100 as const,
                index: s.index,
                level: n.insideHighSegment ? 1 : 0,
                sourceCandidateId: id(n.highSignal),
                lowStartPointId: id(s.divergence.curStart),
                lowEndPointId: id(s.divergence.curEnd),
                semantic: s.divergence.semantic,
                // 1 inside high segment / 2 both confirmed / 4 new extreme / 8 small-turn candidate
                confirmFlags:
                  (n.insideHighSegment ? 1 : 0) |
                  (n.confirmed ? 2 : 0) |
                  (n.newExtreme ? 4 : 0) |
                  (n.smallTurn ? 8 : 0),
                direction: Math.sign(s.type),
              },
            ];
          })
        : [];
    return {
      ...decoded,
      native: {
        ...decodeNative(family, raw.families[1100], config),
        // The anchor names which calendar series the caller fed (daily,
        // five-minute or complete months); the DLL never sees dates.
        ...(anchor
          ? {
              recursive: decodeCzscRecursive(
                family,
                config,
                anchor,
                input.close,
              ),
            }
          : {}),
        ...(anchor && movements
          ? { recursiveMovements: decodeCzscMovements(family, config, anchor) }
          : {}),
      },
      diagnostics: {
        version: czscSourceCommit,
        ma: family.bars.map((b, index) => ({
          index,
          // Native MA5/MA20 (api v6), the same pair the engine's kisses use.
          difference: Math.fround(b.maShort - b.maLong),
          kiss: b.kiss === 4 ? 3 : b.kiss,
          instantWarning: b.instantDivergence,
          volumeKiss: b.kiss,
        })),
        lifecycle: family.centers
          .map((c) => ({ index: c.start, value: c.lifecycle }))
          .filter((c) => c.value >= 0),
        nested,
      },
    };
  });
  return {
    status: families.some((f) => f.points.length > 1)
      ? "structure"
      : "no-structure",
    hash: raw.hash,
    sourceCommit: czscSourceCommit,
    configId: raw.configId,
    families,
  };
}

/** Third-buy capture consumes stroke pivots, centers and confirmed signals.
 * Avoid decoding per-bar diagnostics and recursive/nested chart tables at every
 * prefix. The DLL still builds each prefix: v22 exposes no append API. */
export async function analyzeNativeThirdBuy(
  bars: readonly Bar[],
  project: typeof projectCzsc = projectCzsc,
): Promise<CzscResult> {
  if (
    bars.some(
      (b, i) =>
        !Number.isFinite(Date.parse(b.date)) ||
        (i > 0 && Date.parse(b.date) <= Date.parse(bars[i - 1]!.date)),
    )
  )
    throw new RangeError("CZSC bars must be in strictly ascending time order");
  const raw = await project(
    {
      high: bars.map((b) => b.high),
      low: bars.map((b) => b.low),
      close: bars.map((b) => b.close),
      volume: bars.map((b) => b.volume),
    },
    { levels: [0], bars: false },
  );
  if (!raw.families[0]) throw new Error("结构缺口：缺少笔级快照");
  const family = decodeFamily(raw.families[0], 0, bars, true, false);
  return {
    status: family.points.length > 1 ? "structure" : "no-structure",
    hash: raw.hash,
    sourceCommit: czscSourceCommit,
    configId: raw.configId,
    families: [family],
  };
}

/** C4 anchored recursive movements over the caller's anchor series (api v5). */
export function analyzeChanMovements(
  bars: readonly Bar[],
  anchor: 1 | 2 | 3,
  project: typeof projectCzsc = projectCzsc,
) {
  return analyzeCzsc(bars, true, project, true, anchor, true);
}
