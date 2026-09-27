import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type { CzscInput } from "./czsc-input";
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
} from "~/lib/research/methods/chan/czsc";
import { decodeCzscMovements, decodeCzscRecursive } from "./czsc-recursive";
import {
  CZSC_FLAG_HIGHER,
  type CzscRawDivergence,
  type CzscRawFamily,
  type CzscSnapshot,
} from "./czsc-api";

export type { CzscSnapshot } from "./czsc-api";

const scope = globalThis as typeof globalThis & {
  czscWorker?: ChildProcess;
  czscQueue?: Promise<unknown>;
  czscRequestId?: number;
};

function worker() {
  if (!scope.czscWorker) {
    const child = fork(resolve("runtime/czsc-worker.cjs"), [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
      execArgv: [],
    });
    scope.czscWorker = child;
    child.once("exit", () => {
      if (scope.czscWorker === child) scope.czscWorker = undefined;
    });
  }
  return scope.czscWorker;
}

/** Build native snapshots (adapter/czsc_api.h) in the serial DLL worker. */
export function projectCzsc(
  input: CzscInput,
  configs: readonly number[] = [0, 1100],
  flags = 0,
  nested = false,
): Promise<CzscSnapshot> {
  // Queue entire jobs; retain the singleton across Next HMR.
  const message = {
    input: structuredClone(input),
    configs: [...configs],
    flags,
    nested,
  };
  const job = (scope.czscQueue ?? Promise.resolve()).then(
    () =>
      new Promise<CzscSnapshot>((resolveResult, reject) => {
        const child = worker(),
          id = (scope.czscRequestId = (scope.czscRequestId ?? 0) + 1);
        const cleanup = () => {
          child.off("message", onMessage);
          child.off("exit", onExit);
          child.off("error", onError);
        };
        const onError = (error: Error) => {
          cleanup();
          reject(error);
        };
        const onExit = (code: number | null) =>
          onError(new Error(`CZSC worker exited (${code})`));
        const onMessage = (reply: {
          id: number;
          result: CzscSnapshot;
          error?: string;
        }) => {
          if (reply.id !== id) return;
          cleanup();
          if (reply.error) reject(new Error(reply.error));
          else resolveResult(reply.result);
        };
        child
          .on("message", onMessage)
          .once("exit", onExit)
          .once("error", onError);
        child.send({ id, ...message }, (error) => {
          if (error) onError(error);
        });
      }),
  );
  scope.czscQueue = job.catch(() => {});
  return job;
}

export async function closeCzsc() {
  await scope.czscQueue;
  const child = scope.czscWorker;
  if (child) {
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.disconnect();
    });
  }
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
  research: boolean,
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
  if (raw.pivots.length < 2) return empty;
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
          ...(research ? { structure: structure(s) } : {}),
        }
      : {}),
  }));
  const pivotIndex = (p: number) => raw.pivots[p]?.index;
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
      const at = (p: number) => high!.pivots[p]?.index ?? null;
      return [
        {
          id: row + 1,
          config: 1100 as const,
          index: s.index,
          kind: s.type,
          pointId: id(s.pivot),
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
): Promise<CzscResult> {
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
  const research = signalDetails && researchStructures;
  const raw = await project(
    input,
    [0, 1100],
    research ? CZSC_FLAG_HIGHER : 0,
    research,
  );
  const families: CzscFamily[] = ([0, 1100] as const).map((config) => {
    const family = raw.families[config];
    if (!family) throw new Error(`结构缺口：缺少配置${config}快照`);
    const decoded = decodeFamily(family, config, bars, signalDetails, research);
    if (!research) return decoded;
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
    families,
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
