import { fork, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import type { CzscInput } from "./czsc-input";
import type { Bar } from "~/lib/domain";
import type { CzscResult, CzscFamily } from "~/lib/research/methods/chan/czsc";
import { decodeCzscCenters } from "./czsc-structures";
import { decodeCzscMovements } from "./czsc-movements";
import { chanMovementOutputs } from "~/lib/research/methods/chan/czsc-movements";
import {
  czscResearchOutputs,
  czscNativeOutputs,
  decodeCzscResearchStructures,
} from "./czsc-research-structures";

export interface CzscProjections {
  hash: string;
  registered: number[];
  projections: Record<string, number[]>;
}
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

export function projectCzsc(
  input: CzscInput,
  configs = [0, 1100],
  outputs = [0, 1, 2, 3, 4, 5, 9, 23],
): Promise<CzscProjections> {
  // Queue entire jobs, including C/V registration; retain singleton across Next HMR.
  if (outputs.some((o) => !Number.isInteger(o) || o < 0 || o > 108))
    return Promise.reject(new RangeError("Invalid CZSC output"));
  const snapshot = structuredClone(input);
  configs = [...configs];
  outputs = [...outputs];
  const job = (scope.czscQueue ?? Promise.resolve()).then(
    () =>
      new Promise<CzscProjections>((resolveResult, reject) => {
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
        const onMessage = (message: {
          id: number;
          result: CzscProjections;
          error?: string;
        }) => {
          if (message.id !== id) return;
          cleanup();
          if (message.error) reject(new Error(message.error));
          else resolveResult(message.result);
        };
        child
          .on("message", onMessage)
          .once("exit", onExit)
          .once("error", onError);
        child.send({ id, input: snapshot, configs, outputs }, (error) => {
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
    ...(anchor ? { anchor, dates: bars.map((b) => b.date) } : {}),
    high: bars.map((b) => b.high),
    low: bars.map((b) => b.low),
    close: bars.map((b) => b.close),
    volume: bars.map((b) => b.volume),
  };
  // N1 may relay projections from a task thread to the same serial DLL owner.
  const raw = await project(
    input,
    [0, 1100],
    [
      0,
      1,
      2,
      3,
      4,
      5,
      9,
      23,
      ...(signalDetails ? [25, 29, 30, 31, 32, 53] : []),
      ...(signalDetails && researchStructures
        ? [
            ...czscResearchOutputs,
            ...czscNativeOutputs,
            ...(anchor ? [93, 94, 95, 96, 97, 98, 99] : []),
            ...(movements ? chanMovementOutputs : []),
          ]
        : []),
    ],
  );
  const families: CzscFamily[] = ([0, 1100] as const).map((config) => {
    const decoded = decodeCzscCenters(input, raw, config);
    const p = (output: number) => raw.projections[`${config}:${output}`]!;
    const research =
      signalDetails && researchStructures
        ? decodeCzscResearchStructures(raw, config, bars.length, true, anchor)
        : null;
    const native = research?.native;
    if (movements && native && anchor)
      native.recursiveMovements = decodeCzscMovements(
        raw,
        bars,
        config,
        anchor,
        native,
        decoded.centers,
      );
    const empty: CzscFamily = {
      config,
      points: [],
      centers: [],
      signals: [],
      movements: [],
      qualities: [],
      divergences: [],
      ...(research ? { diagnostics: research.diagnostics, native } : {}),
    };
    // A single endpoint cannot form a stroke/segment. Do not render a false structure.
    if (decoded.points.length < 2) return empty;
    const signals = p(4).flatMap((kind, index) =>
      kind === 0
        ? []
        : [
            {
              index,
              date: bars[index]!.date,
              // CzscInternal.h encodes sells as 11/12/13, not negative buys.
              kind: kind >= 11 && kind <= 13 ? -(kind - 10) : kind,
              quality: p(5)[index]!,
              // Exact candidate ownership, not nearest-center inference (Func30 output 25).
              ...(signalDetails
                ? {
                    centerId: p(25)[index]!,
                    ...(research ? { structure: research.signal(index) } : {}),
                    divergence: {
                      areaRatio: p(29)[index]!,
                      priceRatio: p(30)[index]!,
                      speedRatio: p(31)[index]!,
                      flags: p(32)[index]!,
                      semantic: p(53)[index]!,
                    },
                  }
                : {}),
            },
          ],
    );
    // Output 9 is signed start(1)/end(2) marks, not a continuous price series.
    const divergences: CzscFamily["divergences"] = [];
    let start: number | undefined;
    let direction = 0;
    p(9).forEach((mark, index) => {
      if (Math.abs(mark) === 1) {
        start = index;
        direction = Math.sign(mark);
      }
      if (
        Math.abs(mark) === 2 &&
        start !== undefined &&
        Math.sign(mark) === direction
      ) {
        divergences.push({ start, end: index, direction });
        start = undefined;
      }
    });
    return {
      config,
      points: decoded.points.map((point) => ({
        ...point,
        date: bars[point.index]!.date,
      })),
      centers: decoded.centers.map((center) => ({
        ...center,
        startDate: bars[center.start]!.date,
        endDate: bars[center.end]!.date,
      })),
      signals,
      ...(research ? { diagnostics: research.diagnostics, native } : {}),
      divergences,
      movements: signals.map((s) => ({
        index: s.index,
        direction: p(23)[s.index]!,
      })),
      qualities: signals.map((s) => ({ index: s.index, value: s.quality })),
    };
  });
  return {
    status: families.some((f) => f.points.length > 1)
      ? "structure"
      : "no-structure",
    hash: raw.hash,
    sourceCommit: "b67f3c6",
    families,
  };
}

/** Opt-in C4 reader. Capability validation rejects older DLLs without outputs 100–108. */
export function analyzeChanMovements(
  bars: readonly Bar[],
  anchor: 1 | 2 | 3,
  project: typeof projectCzsc = projectCzsc,
) {
  return analyzeCzsc(bars, true, project, true, anchor, true);
}
