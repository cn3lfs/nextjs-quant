import { createHash } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  readdir,
  stat,
  open,
  unlink,
} from "node:fs/promises";
import { resolve, join, isAbsolute } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { isDeepStrictEqual } from "node:util";
import {
  runPortfolio,
  createPortfolioPreparation,
  validationDefaults,
  validationScorePasses,
  validationAdditionalReasons,
  portfolioObservationDay,
  type PortfolioRequest,
  type ValidationScore,
  type ValidationRow,
  type ValidationRun,
} from "quant-backtest";
import {
  strategyObjectSchema,
  buildClassicSchedule,
  strategyBookReturns,
  marketLowZoneSeries,
} from "trading-strategies";
import {
  lifecyclePreregistration,
  applyLifecyclePatch,
  type LifecycleMain,
} from "./lifecycle-menu";
import {
  loadLifecycleSource,
  lifecycleConfigHash,
  type LifecycleSourceBundle,
  type LifecycleMarketSource,
} from "../../../src/server/research/lifecycle-source";
import {
  lifecycleSegments,
  scoreLifecycleResult,
} from "../../../src/server/research/lifecycle-score";
import {
  assessValidationCandidates,
  validationMethodEvidence,
} from "../../../src/server/research/validation-method";
import { forwardExecutionBuildHash } from "../../../src/server/research/forward-identity";
import {
  ForwardReferenceRepository,
  forwardSizingPolicyHash,
} from "../../../src/server/db/forward-reference-repository";
import { publishAccountExpectation } from "../../../src/server/portfolio/account-expectation-service";
import { saveValidationScoreboard } from "../../../src/server/db/validation-scoreboard";
import { StrategyRepository } from "../../../src/server/db/strategy-repository";
import { freezeLifecycleCandidateSource } from "../../../src/server/research/lifecycle-candidate";
import { forwardDefinitionHash } from "../../../src/server/db/forward-reference-repository";
import { projectLifecycleLowZone } from "../../../src/server/research/lifecycle-low-zone";
import type { ScoreboardRow } from "../../../src/server/research/validation-model";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytesHash = (value: Buffer | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

/** maxRSS is KiB in Node, including Windows. Historical peaks remain a hard
 * failure even if GC has since lowered current RSS. Never erase checkpoints. */
export function assertLifecycleProcessBudget(stage: string) {
  const peak = Math.max(
    process.resourceUsage().maxRSS * 1024,
    process.memoryUsage().rss,
  );
  if (peak > 4096 * 1024 ** 2)
    throw new Error(
      `Lifecycle 4096MiB process budget exceeded at ${stage}; maxRSS=${(peak / 1024 ** 2).toFixed(2)}MiB; retained checkpoints are not deleted`,
    );
}
type Scenario = "base" | "doubledCost" | "delayed";
type Trial = {
  candidate: LifecycleMain;
  center: string;
  selectable: boolean;
  perturbed?: "entry" | "exit";
};
type Segment = {
  identity: string;
  kind: "in-sample" | "training" | "oos" | "holdout";
  scenario: Scenario;
  start: string;
  end: string;
};
type SegmentArtifact = {
  identity: string;
  score: ValidationScore;
  fills: ReturnType<typeof runPortfolio>["fills"];
  orders: ReturnType<typeof runPortfolio>["orders"];
  corporateActions: ReturnType<typeof runPortfolio>["corporateActions"];
};
export type LifecycleProgress = {
  physicalCalls: number;
  resumedCheckpoints: number;
  insufficientSegments: number;
  elapsedMs: number;
  phase: "engine" | "checkpoint";
  trialId: string;
  scenario: Scenario;
  nativeDone?: number;
  nativeTotal?: number;
};

export function lifecycleTrials() {
  const config = lifecyclePreregistration();
  const trials: Trial[] = config.main.map((candidate) => ({
    candidate,
    center: candidate.id,
    selectable: true,
  }));
  for (const neighbor of config.neighbors)
    trials.push({
      candidate: applyLifecyclePatch(
        config.main.find((c) => c.id === neighbor.parent)!,
        neighbor,
      ),
      center: neighbor.parent,
      selectable: false,
      perturbed: neighbor.block.startsWith("entry-") ? "entry" : "exit",
    });
  for (const trial of trials)
    strategyObjectSchema.parse(trial.candidate.strategy);
  return trials;
}
function segmentsFor(axis: readonly string[]) {
  const split = lifecycleSegments(axis);
  const segments: Omit<Segment, "identity">[] = [
    { kind: "in-sample", scenario: "base", ...split.inSample },
  ];
  for (const window of split.windows) {
    segments.push({
      kind: "training",
      scenario: "base",
      start: window.trainStart,
      end: window.trainEnd,
    });
    for (const scenario of ["base", "doubledCost", "delayed"] as const)
      segments.push({
        kind: "oos",
        scenario,
        start: window.start,
        end: window.end,
      });
  }
  for (const scenario of ["base", "doubledCost", "delayed"] as const)
    segments.push({ kind: "holdout", scenario, ...split.holdoutWindow });
  return { split, segments };
}
function sourceFor(
  bundle: LifecycleSourceBundle,
  candidate: LifecycleMain,
): LifecycleMarketSource {
  return bundle.markets[
    candidate.strategy.market === "cn-equity"
      ? "cn-day"
      : candidate.strategy.period === "4h"
        ? "crypto-4h"
        : "crypto-day"
  ];
}
function inputMissingGroups(
  bundle: LifecycleSourceBundle,
  candidate: LifecycleMain,
) {
  const family = bundle.families[candidate.family],
    source = sourceFor(bundle, candidate);
  return [
    family?.missing ?? ["missing-frozen-family-axis"],
    source.missing,
    [
      ...(candidate.detector && !bundle.lowZoneInput
        ? ["market-low-zone-input-adapter-required"]
        : []),
      ...(candidate.strategy.rank?.kind === "classic" &&
      !source.bookFacts.classicWeeks?.length
        ? ["missing-frozen-classic-panel"]
        : []),
      ...(candidate.strategy.regime &&
      source.bookFacts.benchmark?.symbol !== candidate.strategy.regime.benchmark
        ? ["missing-declared-regime-benchmark"]
        : []),
      ...(candidate.strategy.costFilter &&
      source.bookFacts.roundTripCost === undefined
        ? ["missing-frozen-round-trip-cost"]
        : []),
    ],
  ];
}
export function lifecycleExecutionPlan(
  bundle: LifecycleSourceBundle,
  buildHash: string | null = null,
) {
  assertLifecycleProcessBudget("plan-before");
  if (bundle.configHash !== lifecycleConfigHash)
    throw new Error("Frozen lifecycle config hash differs");
  const missingEvidence: Record<string, readonly string[]> = {};
  const seenGroups = new WeakMap<readonly string[], string>();
  const register = (rows: readonly string[]) => {
    if (!rows.length) return null;
    const known = seenGroups.get(rows);
    if (known) return known;
    const values = [...new Set(rows)],
      ref = digest(values);
    missingEvidence[ref] ??= values;
    seenGroups.set(rows, ref);
    return ref;
  };
  const trials = lifecycleTrials().map((trial) => {
    const family = bundle.families[trial.candidate.family],
      missingRefs = [
        ...new Set(
          inputMissingGroups(bundle, trial.candidate)
            .map(register)
            .filter((ref): ref is string => ref !== null),
        ),
      ];
    const expanded = family?.dailyAxis.length
      ? segmentsFor(family.dailyAxis)
      : null;
    return {
      id: trial.candidate.id,
      center: trial.center,
      selectable: trial.selectable,
      family: trial.candidate.family,
      missingRefs,
      axisHash: family?.axisHash ?? null,
      sourceHash: sourceFor(bundle, trial.candidate).inputHash,
      entryParameterSensitivity: lifecyclePreregistration().neighbors.some(
        (n) => n.parent === trial.center && n.block.startsWith("entry-"),
      )
        ? ("required" as const)
        : ("not-applicable" as const),
      segments:
        expanded?.segments.map((segment) => ({
          ...segment,
          identity: digest({
            configHash: bundle.configHash,
            inputHash: bundle.inputHash,
            sourceHash: sourceFor(bundle, trial.candidate).inputHash,
            buildHash,
            candidate: trial.candidate,
            axisHash: family?.axisHash ?? null,
            segment,
          }),
        })) ?? [],
      estimatedPhysicalEngineCalls: missingRefs.length
        ? 0
        : (expanded?.segments.length ?? 0),
    };
  });
  const plan = {
    version: "lifecycle-execution-plan-2",
    configHash: bundle.configHash,
    inputHash: bundle.inputHash,
    sourceManifest: bundle.manifestPath,
    buildHash,
    scenarioIdentities: 360,
    economicConfigurations: 120,
    selectableMains: 16,
    schemaNoopsNotRun: 8,
    estimatedPhysicalEngineCalls: trials.reduce(
      (n, t) => n + t.estimatedPhysicalEngineCalls,
      0,
    ),
    trials,
    missingEvidence,
    constraints: {
      maximumProcesses: 1,
      heapMiB: 4096,
      sourceCacheMiB: 512,
      researchOutputsMiB: 512,
      oracleMiB: 2,
      selection:
        "Only 16 preregistered main configurations may be selected or published. All valid neighbor trials enter family DSR/PBO; no neighbor becomes a new main or borrows a parent's gate.",
      segments:
        "Independent capital and portfolio state in every declared training/OOS/holdout segment. Training never sees holdout. 360 counts configuration x stress identities, not physical segmented engine calls.",
      checkpoint:
        "All plans/parity/checkpoints/reports/OOS artifacts share512MiB; sources have a separate512MiB budget. Every gzip checkpoint verifies config/input/source/build/axis/strategy/segment identity and its content digest. Completed checkpoint counts include resumed and explicit-insufficient rows; physicalCalls counts only actual engine invocations.",
      boundary:
        "Source-only plan. No historical return computation until manager reviews this exact source/axis/build/work budget plan.",
    },
  };
  const result = { ...plan, contentHash: digest(plan) };
  assertLifecycleProcessBudget("plan-complete");
  return result;
}

/** Resolve complete, hash-bound details. Rows carry references, never a
 * truncated copy masquerading as the full source/family gap list. */
export function resolveLifecycleMissing(
  plan: Pick<ReturnType<typeof lifecycleExecutionPlan>, "missingEvidence">,
  trial: { missingRefs: readonly string[] },
) {
  return [
    ...new Set(
      trial.missingRefs.flatMap((ref) => {
        const values = plan.missingEvidence[ref];
        if (!Array.isArray(values) || digest(values) !== ref)
          throw new Error("Missing evidence reference/content differs");
        return values;
      }),
    ),
  ];
}

/** Rejected source rows need no stock/market signal matrix merely to report
 * insufficient cycle evidence. A runnable row keeps its original projection. */
export function lifecycleLowZoneEvidence<T>(
  candidate: Pick<LifecycleMain, "detector">,
  declaration: { missingRefs: readonly string[] },
  axis: readonly string[],
  project: () => T,
): T | null {
  return candidate.detector && !declaration.missingRefs.length && axis.length
    ? project()
    : null;
}

export function lifecyclePrepareSummary(value: {
  source: LifecycleSourceBundle;
  plan: ReturnType<typeof lifecycleExecutionPlan>;
  oracle: unknown;
  planPath: string;
  parityPath: string;
}) {
  const { source, plan } = value;
  const families = Object.fromEntries(
    Object.entries(source.families).map(([id, axis]) => {
      const trials = plan.trials.filter((trial) => trial.family === id);
      const missingRefs = [
        ...new Set(trials.flatMap((trial) => trial.missingRefs)),
      ];
      return [
        id,
        {
          main: trials.filter((trial) => trial.selectable).length,
          neighbors: trials.filter((trial) => !trial.selectable).length,
          axisDays: axis.dailyAxis.length,
          first: axis.dailyAxis[0] ?? null,
          last: axis.dailyAxis.at(-1) ?? null,
          expandedSegments: trials.reduce(
            (n, trial) => n + trial.segments.length,
            0,
          ),
          estimatedPhysicalEngineCalls: trials.reduce(
            (n, trial) => n + trial.estimatedPhysicalEngineCalls,
            0,
          ),
          blockedTrials: trials.filter((trial) => trial.missingRefs.length)
            .length,
          missingFacts: resolveLifecycleMissing(plan, { missingRefs }).length,
          missingRefs,
        },
      ];
    }),
  );
  assertLifecycleProcessBudget("prepare-summary");
  return {
    planPath: value.planPath,
    parityPath: value.parityPath,
    executionPlanHash: plan.contentHash,
    inputHash: plan.inputHash,
    buildHash: plan.buildHash,
    sourceManifest: plan.sourceManifest,
    economicConfigurations: plan.economicConfigurations,
    scenarioIdentities: plan.scenarioIdentities,
    estimatedPhysicalEngineCalls: plan.estimatedPhysicalEngineCalls,
    actualEngineCalls: 0,
    families,
    oracle: value.oracle,
  };
}

function assertIsolatedOutput(output: string) {
  const root = resolve(".test-data/lifecycle-20261116/l3");
  if (
    resolve(output) !== root ||
    !process.env.QUANT_DATA_DIR ||
    !isAbsolute(process.env.QUANT_DATA_DIR) ||
    !resolve(process.env.QUANT_DATA_DIR).startsWith(
      resolve(".test-data/lifecycle-20261116") + "\\",
    )
  )
    throw new Error(
      "Lifecycle research requires its explicit isolated task directory",
    );
  return root;
}
const outputBudget = new Map<string, number>();
async function researchOutputBytes(
  directory: string,
  root = directory,
): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (directory === root && ["sources", "data"].includes(entry.name))
      continue;
    total += entry.isDirectory()
      ? await researchOutputBytes(join(directory, entry.name), root)
      : (await stat(join(directory, entry.name))).size;
  }
  return total;
}
export async function writeLifecycleArtifact(path: string, value: unknown) {
  assertLifecycleProcessBudget("artifact-before");
  const root = resolve(".test-data/lifecycle-20261116/l3");
  if (
    !resolve(path).startsWith(root + "\\") ||
    resolve(path).startsWith(join(root, "sources") + "\\") ||
    resolve(path).startsWith(join(root, "data") + "\\")
  )
    throw new Error(
      "Research artifact must use its own budgeted output namespace",
    );
  const raw = Buffer.from(JSON.stringify(value)),
    hash = bytesHash(raw),
    compressed = gzipSync(raw);
  assertLifecycleProcessBudget("artifact-serialized");
  try {
    const prior = gunzipSync(await readFile(path));
    if (bytesHash(prior) !== hash)
      throw new Error(`Immutable checkpoint differs: ${path}`);
    assertLifecycleProcessBudget("artifact-existing");
    return hash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const tmp = `${path}.pending`;
  await mkdir(resolve(path, ".."), { recursive: true });
  try {
    const pending = await readFile(tmp);
    let decoded: Buffer | undefined;
    try {
      decoded = gunzipSync(pending);
    } catch {
      /* An interrupted gzip is not a retained fact. */
    }
    if (decoded && bytesHash(decoded) !== hash)
      throw new Error(
        "Complete interrupted artifact differs; preserve it for review",
      );
    if (decoded) {
      const existing =
        outputBudget.get(root) ?? (await researchOutputBytes(root));
      if (existing > 512 * 1024 * 1024)
        throw new Error(
          "Preregistered combined research output budget exceeds512MiB",
        );
      await rename(tmp, path);
      outputBudget.set(root, existing);
      assertLifecycleProcessBudget("artifact-recovered");
      return hash;
    }
    // Only this incomplete task-owned transient is recreated; source inputs remain untouched.
    await unlink(tmp);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const used = outputBudget.get(root) ?? (await researchOutputBytes(root));
  if (used + compressed.length > 512 * 1024 * 1024)
    throw new Error(
      "Preregistered combined research output budget exceeds512MiB (plans/parity/checkpoints/reports)",
    );
  await writeFile(tmp, compressed, { flag: "wx" });
  await rename(tmp, path);
  outputBudget.set(root, used + compressed.length);
  assertLifecycleProcessBudget("artifact-written");
  return hash;
}
const writeImmutable = writeLifecycleArtifact;
export async function verifyLifecycleClassicBase(
  bundle: LifecycleSourceBundle,
) {
  assertLifecycleProcessBudget("oracle-before");
  const root = resolve(".test-data/lifecycle-20261116/oracle"),
    manifest = JSON.parse(
      await readFile(join(root, "reconstruction-manifest.json"), "utf8"),
    );
  const raw = await readFile(join(root, "classic-five-base-targets.json"));
  if (
    bytesHash(raw) !== manifest.targetHash ||
    manifest.engineHash !==
      "4067092a8bb42f0198d38cb7b4c656eedc5f63e33ae6a5eaad415e1535045a18"
  )
    throw new Error("Reviewed reconstructed oracle identity differs");
  const expected = JSON.parse(raw.toString()),
    source = bundle.markets["cn-day"],
    series = new Map(
      source.request.instruments.map((s) => [s.symbol, s.signalBars]),
    );
  if (!source.bookFacts.classicWeeks?.length)
    return {
      available: false,
      reason: "missing-frozen-classic-panel",
      oracleHash: manifest.targetHash,
    };
  const actual = buildClassicSchedule(
    source.bookFacts.classicWeeks,
    {
      model: "classic-five",
      count: 20,
      risk: "volatility",
      startSignal: manifest.firstSignal,
    },
    (symbol, date) => {
      const bars =
        source.bookFacts.classicRiskSeries !== undefined
          ? source.bookFacts.classicRiskSeries.find((s) => s.symbol === symbol)
              ?.bars
          : series.get(symbol);
      return bars
        ? strategyBookReturns(bars, date, source.request.calendar)
        : null;
    },
  );
  if (
    !isDeepStrictEqual(actual.allocations, expected.allocations) ||
    !isDeepStrictEqual(actual.audit, expected.audit)
  )
    throw new Error(
      "Unified classic BASE targets differ from the independent reconstructed oracle",
    );
  assertLifecycleProcessBudget("oracle-complete");
  return {
    available: true,
    reason: null,
    weeks: actual.allocations.length,
    firstSignal: actual.allocations[0]?.date,
    lastSignal: actual.allocations.at(-1)?.date,
    oracleHash: manifest.targetHash,
    scope: "BASE targets only; governance overlays deliberately separate",
  };
}
async function diskBytes(directory: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(directory, { withFileTypes: true }))
    total += entry.isDirectory()
      ? await diskBytes(join(directory, entry.name))
      : (await stat(join(directory, entry.name))).size;
  return total;
}
function scaledCosts(
  request: LifecycleMarketSource["request"],
  scenario: Scenario,
) {
  if (!request.costs)
    throw new Error("Missing frozen execution cost assumptions");
  if (scenario !== "doubledCost") return request.costs;
  return {
    ...request.costs,
    commissionBps: request.costs.commissionBps * 2,
    minimumCommission: request.costs.minimumCommission * 2,
    sellTaxBps: request.costs.sellTaxBps * 2,
    slippageBps: request.costs.slippageBps * 2,
    ...(request.costs.sellTaxSchedule
      ? {
          sellTaxSchedule: {
            ...request.costs.sellTaxSchedule,
            multiplier: request.costs.sellTaxSchedule.multiplier * 2,
          },
        }
      : {}),
  };
}
const lowProjectionCache = new WeakMap<
  LifecycleSourceBundle,
  {
    id: string;
    market: ReturnType<typeof marketLowZoneSeries>;
    instruments: PortfolioRequest["instruments"];
  }
>();
function lowProjection(
  bundle: LifecycleSourceBundle,
  candidate: LifecycleMain,
) {
  const cached = lowProjectionCache.get(bundle);
  if (cached?.id === candidate.id) return cached;
  if (!candidate.detector || !bundle.lowZoneInput) return null;
  const projection = {
    id: candidate.id,
    ...projectLifecycleLowZone(
      sourceFor(bundle, candidate).request.instruments,
      bundle.lowZoneInput,
      candidate.detector,
    ),
  };
  lowProjectionCache.set(bundle, projection);
  return projection;
}
/** Prefix arrays share source bars and compact RPS observations; raw inputs are never cloned per trial. */
export function lifecycleWeeklySeed(
  calendar: readonly string[],
  start: string,
) {
  const week = (date: string) => {
    const d = new Date(date.slice(0, 10));
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  return calendar
    .filter(
      (date, i) =>
        date < start &&
        calendar[i + 1] &&
        week(date) !== week(calendar[i + 1]!),
    )
    .at(-1);
}
export function lifecycleRequest(
  bundle: LifecycleSourceBundle,
  candidate: LifecycleMain,
  segment: Pick<Segment, "start" | "end" | "scenario">,
): PortfolioRequest {
  const source = sourceFor(bundle, candidate),
    family = bundle.families[candidate.family]!;
  const low = lowProjection(bundle, candidate);
  const day = (date: string) =>
    portfolioObservationDay(
      candidate.strategy.market,
      candidate.strategy.period,
      date,
    );
  const calendar = source.request.calendar.filter((d) => day(d) <= segment.end);
  const facts = source.bookFacts;
  const seed = candidate.strategy.rebalance
    ? lifecycleWeeklySeed(calendar, segment.start)
    : undefined;
  return {
    ...source.request,
    start: segment.start,
    end: segment.end,
    calendar,
    observationDetail: "counts",
    strategies: [candidate.strategy],
    sleeves: [
      { id: candidate.strategy.sleeve, share: 1, ...candidate.sleevePolicy },
    ],
    costs: scaledCosts(source.request, segment.scenario),
    signalDelayBars: segment.scenario === "delayed" ? 1 : 0,
    instruments: (low?.instruments ?? source.request.instruments).map(
      (instrument) => ({
        ...instrument,
        bars: instrument.bars.filter((b) => day(b.date) <= segment.end),
        signalBars: instrument.signalBars.filter(
          (b) => day(b.date) <= segment.end,
        ),
        actions: instrument.actions?.filter((a) => a.date <= segment.end),
      }),
    ),
    memberships: source.request.memberships
      ?.filter((m) => day(m.date) <= segment.end)
      .map((m) => ({ ...m, strategyId: candidate.id })),
    bookFacts: {
      [candidate.id]: {
        ...facts,
        benchmark: facts.benchmark && {
          ...facts.benchmark,
          bars: facts.benchmark.bars.filter(
            (b) => b.date.slice(0, 10) <= segment.end,
          ),
        },
        classicWeeks: facts.classicWeeks?.filter((w) => w.date <= segment.end),
        ...(low ? { marketLowZone: low.market } : {}),
      },
    },
    ...(seed
      ? {
          bookSeeds: [
            {
              strategyId: candidate.id,
              date: seed,
              availableAt: seed,
              ...(family.firstSignal
                ? { selectionFrom: family.firstSignal }
                : {}),
            },
          ],
        }
      : {}),
  };
}
const missingScore = (
  axis: readonly string[],
  start: string,
  end: string,
): ValidationScore => ({
  return: null,
  excess: null,
  drawdown: null,
  trades: 0,
  events: { entries: 0, exits: 0, orders: 0, fills: 0, rejectionAttempts: 0 },
  dailyDates: axis.filter((d) => d >= start && d <= end),
  daily: axis.filter((d) => d >= start && d <= end).map(() => null),
});

export async function prepareLifecycleResearch(
  configPath = "research/configs/l3.json",
  output = ".test-data/lifecycle-20261116/l3",
  options: { decodeLowZoneFinancials?: boolean } = {},
) {
  const root = assertIsolatedOutput(output),
    bytes = await readFile(configPath);
  if (bytesHash(bytes) !== lifecycleConfigHash)
    throw new Error("Preregistered JSON bytes changed");
  if (
    !isDeepStrictEqual(JSON.parse(bytes.toString()), lifecyclePreregistration())
  )
    throw new Error("Registration generator differs from frozen menu");
  const source = await loadLifecycleSource(configPath, {
    outputRoot: join(root, "sources"),
    decodeLowZoneFinancials: options.decodeLowZoneFinancials === true,
  });
  assertLifecycleProcessBudget("source-return");
  const oracle = await verifyLifecycleClassicBase(source);
  assertLifecycleProcessBudget("oracle-return");
  let buildHash: string | null = null;
  try {
    buildHash = forwardExecutionBuildHash();
  } catch {
    /* A source-only plan can be reviewed while runtime build is pending. */
  }
  const plan = lifecycleExecutionPlan(source, buildHash);
  await mkdir(root, { recursive: true });
  const planPath = join(root, `execution-plan-${plan.contentHash}.json.gz`),
    parityPath = join(root, `classic-parity-${source.inputHash}.json.gz`);
  await writeImmutable(planPath, plan);
  await writeImmutable(parityPath, oracle);
  assertLifecycleProcessBudget("prepare-written");
  return { source, plan, oracle, planPath, parityPath };
}

/** Explicit CLI execution after the frozen source/work plan has been reviewed. */
export async function runLifecycleResearch(
  configPath: string,
  approvedPlanHash: string,
  output = ".test-data/lifecycle-20261116/l3",
  progress: (
    done: number,
    total: number,
    detail?: LifecycleProgress,
  ) => void = () => {},
  options: { decodeLowZoneFinancials?: boolean } = {},
) {
  const root = assertIsolatedOutput(output);
  await mkdir(root, { recursive: true });
  const lockPath = join(root, ".run.lock");
  let lease: Awaited<ReturnType<typeof open>>;
  try {
    lease = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const old = JSON.parse(await readFile(lockPath, "utf8")) as { pid: number };
    if (!Number.isInteger(old.pid) || old.pid <= 0)
      throw new Error("Unrecognized research lease; inspect before resuming");
    try {
      process.kill(old.pid, 0);
      throw new Error("Another lifecycle research process is active");
    } catch (probe) {
      if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
    }
    await unlink(lockPath);
    lease = await open(lockPath, "wx");
  }
  await lease.writeFile(
    JSON.stringify({ pid: process.pid, at: new Date().toISOString() }),
  );
  try {
    return await runLifecycleResearchLocked(
      configPath,
      approvedPlanHash,
      root,
      progress,
      options,
    );
  } finally {
    await lease.close();
    await unlink(lockPath);
  }
}
async function runLifecycleResearchLocked(
  configPath: string,
  approvedPlanHash: string,
  output: string,
  progress: (done: number, total: number, detail?: LifecycleProgress) => void,
  options: { decodeLowZoneFinancials?: boolean },
) {
  const root = assertIsolatedOutput(output),
    { source, plan, oracle } = await prepareLifecycleResearch(
      configPath,
      root,
      options,
    );
  if (
    !approvedPlanHash ||
    approvedPlanHash !== plan.contentHash ||
    !plan.buildHash
  )
    throw new Error(
      "A reviewed exact source/axis/build execution plan hash is required before returns",
    );
  const started = performance.now(),
    trials = lifecycleTrials(),
    allRows: {
      trial: Trial;
      row: ValidationRow;
      artifacts: SegmentArtifact[];
    }[] = [];
  const checkpoint = join(root, "checkpoints");
  await mkdir(checkpoint, { recursive: true });
  let checkpointBytes = await diskBytes(checkpoint),
    completed = 0,
    physicalCalls = 0,
    resumedCheckpoints = 0,
    insufficientSegments = 0;
  const totalSegments = plan.trials.reduce((n, t) => n + t.segments.length, 0);
  for (const trial of trials) {
    const declaration = plan.trials.find((t) => t.id === trial.candidate.id)!,
      missing = resolveLifecycleMissing(plan, declaration),
      family = source.families[trial.candidate.family]!;
    if (!family?.dailyAxis.length) {
      const absent = missingScore([], "", "");
      allRows.push({
        trial,
        artifacts: [],
        row: {
          id: trial.candidate.id,
          family: trial.candidate.family,
          entryParameterSensitivity: declaration.entryParameterSensitivity,
          inSample: absent,
          windows: [],
          holdout: {
            start: "",
            end: "",
            base: absent,
            doubledCost: absent,
            delayed: absent,
          },
          neighbors: [],
          positiveWindows: 0,
          stressPositiveWindows: 0,
          closedTrades: 0,
          reasons: [
            ...(missing.length ? ["source-evidence-missing"] : []),
            "missing-common-source-axis",
          ],
          passed: false,
        },
      });
      continue;
    }
    const split = lifecycleSegments(family.dailyAxis),
      artifacts: SegmentArtifact[] = [],
      preparation = createPortfolioPreparation();
    for (const segment of declaration.segments) {
      const path = join(checkpoint, `${segment.identity}.json.gz`);
      let artifact: SegmentArtifact;
      try {
        const envelope = JSON.parse(
          gunzipSync(await readFile(path)).toString(),
        ) as { artifact: SegmentArtifact; contentHash: string };
        artifact = envelope.artifact;
        if (
          artifact.identity !== segment.identity ||
          digest(artifact) !== envelope.contentHash
        )
          throw new Error("Checkpoint identity/content mismatch");
        resumedCheckpoints++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (missing.length) {
          insufficientSegments++;
          artifact = {
            identity: segment.identity,
            score: missingScore(family.dailyAxis, segment.start, segment.end),
            fills: [],
            orders: [],
            corporateActions: [],
          };
        } else {
          if (forwardExecutionBuildHash() !== plan.buildHash)
            throw new Error("Runtime build changed during research");
          assertLifecycleProcessBudget("segment-before");
          physicalCalls++;
          let lastProgress = performance.now();
          const request = lifecycleRequest(source, trial.candidate, segment),
            result = runPortfolio(
              request,
              (nativeDone, nativeTotal) => {
                assertLifecycleProcessBudget("segment-progress");
                if (performance.now() - lastProgress >= 15000) {
                  lastProgress = performance.now();
                  progress(completed, totalSegments, {
                    physicalCalls,
                    resumedCheckpoints,
                    insufficientSegments,
                    elapsedMs: performance.now() - started,
                    phase: "engine",
                    trialId: trial.candidate.id,
                    scenario: segment.scenario,
                    nativeDone,
                    nativeTotal,
                  });
                }
              },
              preparation,
            );
          assertLifecycleProcessBudget("segment-engine-return");
          artifact = {
            identity: segment.identity,
            score: scoreLifecycleResult(
              result,
              request,
              sourceFor(source, trial.candidate).benchmark,
              family.dailyAxis,
              trial.center,
            ),
            fills: result.fills,
            orders: result.orders,
            corporateActions: result.corporateActions,
          };
          assertLifecycleProcessBudget("segment-scored");
        }
        const envelope = { artifact, contentHash: digest(artifact) };
        const size = gzipSync(Buffer.from(JSON.stringify(envelope))).length;
        await writeImmutable(path, envelope);
        checkpointBytes += size;
      }
      artifacts.push(artifact);
      completed++;
      progress(completed, totalSegments, {
        physicalCalls,
        resumedCheckpoints,
        insufficientSegments,
        elapsedMs: performance.now() - started,
        phase: "checkpoint",
        trialId: trial.candidate.id,
        scenario: segment.scenario,
      });
      await new Promise<void>((done) => setImmediate(done));
    }
    const scoreAt = (
      kind: Segment["kind"],
      scenario: Scenario,
      start: string,
    ) =>
      artifacts[
        declaration.segments.findIndex(
          (s) =>
            s.kind === kind && s.scenario === scenario && s.start === start,
        )
      ]!.score;
    const runAt = (
      kind: "oos" | "holdout",
      start: string,
      end: string,
    ): ValidationRun => ({
      start,
      end,
      base: scoreAt(kind, "base", start),
      doubledCost: scoreAt(kind, "doubledCost", start),
      delayed: scoreAt(kind, "delayed", start),
    });
    const windows = split.windows.map((w) => runAt("oos", w.start, w.end)),
      holdout = runAt(
        "holdout",
        split.holdoutWindow.start,
        split.holdoutWindow.end,
      );
    allRows.push({
      trial,
      artifacts: artifacts.filter(
        (_, i) =>
          ["oos", "holdout"].includes(declaration.segments[i]!.kind) &&
          declaration.segments[i]!.scenario === "base",
      ),
      row: {
        id: trial.candidate.id,
        family: trial.candidate.family,
        entryParameterSensitivity: declaration.entryParameterSensitivity,
        inSample: scoreAt("in-sample", "base", split.inSample.start),
        holdout,
        windows,
        neighbors: [],
        positiveWindows: windows.filter((w) =>
          validationScorePasses(w.base, "risk-adjusted"),
        ).length,
        stressPositiveWindows: windows.filter(
          (w) =>
            validationScorePasses(w.doubledCost, "risk-adjusted") &&
            validationScorePasses(w.delayed, "risk-adjusted"),
        ).length,
        closedTrades: windows.reduce((n, w) => n + w.base.trades, 0),
        reasons: missing.length ? ["source-evidence-missing"] : [],
        passed: false,
      },
    });
  }
  const evaluated = assessValidationCandidates(
    allRows.map(({ trial, row }) => ({
      row,
      market: trial.candidate.strategy.market,
      sleeve: trial.candidate.strategy.sleeve,
      neighborhoodCenter: trial.center,
      ...(trial.perturbed ? { neighborhoodKind: trial.perturbed } : {}),
    })),
    {
      ...validationDefaults,
      trainBars: 20,
      testBars: 5,
      method: "lifecycle-2",
      purpose: "preregistered",
      clusterCorrelation: 0.95,
      maximumPbo: 0.5,
      minimumDsr: 0.95,
    },
  );
  const rows: ScoreboardRow[] = evaluated.map((entry) => {
    const { trial } = allRows.find((r) => r.row.id === entry.id)!,
      declaration = plan.trials.find((r) => r.id === entry.id)!,
      extra = declaration.missingRefs.length ? ["source-evidence-missing"] : [];
    const low = lifecycleLowZoneEvidence(
      trial.candidate,
      declaration,
      source.families[trial.candidate.family]?.dailyAxis ?? [],
      () => lowProjection(source, trial.candidate),
    );
    let cycles = 0,
      active = false;
    for (const point of low?.market ?? []) {
      if (point.entry === true) active = true;
      if (active && point.exit === true) {
        cycles++;
        active = false;
      }
    }
    const corroborated =
      !!low &&
      low.market
        .filter((p) => p.entry === true)
        .every(
          (p) =>
            p.synthetic.pePercentile !== null &&
            p.synthetic.pbPercentile !== null &&
            p.coverage.pe !== null &&
            p.coverage.pb !== null,
        );
    const lowReasons = trial.candidate.detector
      ? validationAdditionalReasons({
          minimumDsr: 0,
          dsr: 1,
          lowZone: { cycles, minimumCycles: 3, corroborated },
        })
      : [];
    const reasons = [
      ...new Set([
        ...entry.row.reasons,
        ...extra,
        ...lowReasons,
        ...(!trial.selectable ? ["registered-neighbor-not-selectable"] : []),
      ]),
    ];
    const score = entry.row.holdout.base;
    const knownDrawdowns = [
      ...entry.row.windows.map((w) => w.base.drawdown),
      score.drawdown,
    ].filter((d): d is number => d !== null);
    return {
      id: entry.id,
      strategyVersion: trial.candidate.strategy.version,
      level: "strategy",
      market: trial.candidate.strategy.market,
      sleeve: trial.candidate.strategy.sleeve,
      rule: trial.candidate.strategy.entry.kind,
      status: reasons.length ? "research" : "live-candidate",
      method: "lifecycle-2",
      purpose: "preregistered",
      methodLabel: "preregistered portfolio construction",
      return: score.return,
      excess: score.excess,
      drawdown: score.drawdown,
      trades: entry.row.closedTrades,
      oosWindows: entry.row.windows.length,
      positiveWindows: entry.row.positiveWindows,
      worstDrawdown: knownDrawdowns.length ? Math.max(...knownDrawdowns) : null,
      riskAdjusted: score.riskAdjusted,
      dsr: entry.testing?.selected.dsr ?? {
        value: null,
        reason: "missing-complete-family-evidence",
      },
      trainingNeighbors: entry.row.neighbors,
      biasTags: source.biasTags.map((code) => ({
        code,
        severity: "high",
        detail: source.source,
      })),
      bias: {
        universe: source.source,
        adjustment:
          "Frozen causal signal prices; actual fills use original raw prices",
        financial:
          "Original hashed factor panel / causal availableAt; missing low-zone inputs remain insufficient",
        execution:
          "Local OHLC paper model; historical venue limits, queue and cash arrival not certified",
      },
      reasons,
      ...(declaration.missingRefs.length
        ? { missingEvidenceRefs: declaration.missingRefs }
        : {}),
    };
  });
  const evidenceById = new Map<
    string,
    { request: PortfolioRequest; resultHash: string }
  >();
  for (const item of allRows.filter(
    (r) =>
      r.trial.selectable &&
      r.artifacts.length &&
      source.families[r.trial.candidate.family]!.dailyAxis.length,
  )) {
    const candidate = item.trial.candidate,
      axis = source.families[candidate.family]!.dailyAxis;
    const request = lifecycleRequest(source, candidate, {
      start: axis[0]!,
      end: axis.at(-1)!,
      scenario: "base",
    });
    const sourceContext = {
      inputHash: source.inputHash,
      buildHash: plan.buildHash,
      configHash: source.configHash,
      manifestPath: source.manifestPath,
      sourceKey:
        candidate.strategy.market === "cn-equity"
          ? ("cn-day" as const)
          : candidate.strategy.period === "4h"
            ? ("crypto-4h" as const)
            : ("crypto-day" as const),
      universeSymbols: request.instruments.map((s) => s.symbol),
      ...(sourceFor(source, candidate).rawUniverse
        ? { rawUniverse: sourceFor(source, candidate).rawUniverse }
        : {}),
      ...(candidate.detector ? { detector: candidate.detector } : {}),
    };
    const forwardArtifact = {
      version: "lifecycle-oos-distribution-1",
      strategy: candidate.strategy,
      inputHash: source.inputHash,
      buildHash: plan.buildHash,
      sourceManifest: source.manifestPath,
      executionPolicy: {
        initial: request.initial,
        sleeves: request.sleeves,
        costs: request.costs,
      },
      sourceContext,
      segments: item.artifacts,
    };
    const resultHash = await writeImmutable(
      join(root, "reports", `${candidate.id}-oos.json.gz`),
      forwardArtifact,
    );
    const row = rows.find((r) => r.id === candidate.id)!;
    row.evidenceScope = "candidate";
    row.evidence = {
      inputHash: source.inputHash,
      resultHash,
      buildHash: plan.buildHash,
    };
    evidenceById.set(candidate.id, { request, resultHash });
    const complete = item.artifacts.every(
      (a) => a.score.daily.length && a.score.daily.every((r) => r !== null),
    );
    if (complete) assertLifecycleProcessBudget("candidate-publication-before");
    if (complete)
      freezeLifecycleCandidateSource({
        strategy: candidate.strategy,
        definitionHash: forwardDefinitionHash(candidate.strategy),
        row,
        executionPolicy: forwardArtifact.executionPolicy,
        sourceContext: { ...sourceContext, resultHash },
      });
  }
  for (const row of rows) row.evidenceScope = "candidate";
  const report = {
    version: "lifecycle-report-2",
    configHash: source.configHash,
    inputHash: source.inputHash,
    buildHash: plan.buildHash,
    executionPlanHash: plan.contentHash,
    oracle,
    rows,
    diagnostics: evaluated.map(validationMethodEvidence),
    calls: physicalCalls,
    completedCheckpoints: completed,
    resumedCheckpoints,
    insufficientSegments,
    estimatedPhysicalEngineCalls: plan.estimatedPhysicalEngineCalls,
    checkpointBytes,
    missingEvidence: plan.missingEvidence,
    createdAt: Date.now(),
    runtimeMs: performance.now() - started,
  };
  assertLifecycleProcessBudget("report-before");
  const reportPath = join(root, "reports", `${digest(report)}.json.gz`);
  const reportHash = await writeImmutable(reportPath, report);
  assertLifecycleProcessBudget("report-written-publication-before");
  const strategies = new StrategyRepository();
  for (const trial of trials) strategies.saveStrategy(trial.candidate.strategy);
  for (const market of ["cn-equity", "crypto"] as const) {
    const declarations = plan.trials.filter(
      (trial) =>
        trials.find((t) => t.candidate.id === trial.id)!.candidate.strategy
          .market === market,
    );
    const references = [
      ...new Set(declarations.flatMap((trial) => trial.missingRefs)),
    ];
    saveValidationScoreboard({
      market,
      inputHash: source.inputHash,
      resultHash: reportHash,
      buildHash: plan.buildHash,
      rows: rows.filter((r) => r.market === market),
      missing: declarations
        .filter((t) => t.missingRefs.length)
        .map((t) => ({
          id: t.id,
          reason: "source-evidence-missing",
          refs: t.missingRefs,
        })),
      missingEvidence: Object.fromEntries(
        references.map((ref) => [ref, plan.missingEvidence[ref]!]),
      ),
      createdAt: report.createdAt,
      runtimeMs: report.runtimeMs,
      universe: source.source,
      gaps: source.biasTags,
    });
  }
  for (const item of allRows.filter((r) => r.trial.selectable)) {
    const row = rows.find((r) => r.id === item.row.id)!,
      evidence = evidenceById.get(item.row.id);
    if (!evidence) continue;
    const { request, resultHash } = evidence;
    assertLifecycleProcessBudget("forward-publication-before");
    const scores = item.artifacts.map((a) => a.score);
    if (
      scores.every(
        (s) =>
          s.dailyDates &&
          s.dailySignals &&
          s.daily.length === s.dailyDates.length &&
          s.daily.every((r) => r !== null) &&
          s.slippageBps,
      )
    )
      new ForwardReferenceRepository().freeze({
        strategy: item.trial.candidate.strategy,
        inputHash: source.inputHash,
        resultHash,
        buildHash: plan.buildHash,
        initial: request.initial,
        sizingPolicyHash: forwardSizingPolicyHash(request),
        backtestPassed: row.status === "live-candidate",
        method: "lifecycle-2",
        purpose: "preregistered",
        slippageBasis: "paper-model",
        source: `${source.source}; frozen common OOS daily axis; ${source.manifestPath}; ${resultHash}`,
        distribution: {
          days: scores.flatMap((s) =>
            s.dailyDates!.map((date, i) => ({
              date,
              return: s.daily[i]!,
              signals: s.dailySignals![i]!,
            })),
          ),
          tradeReturns: scores.flatMap((s) => s.tradeReturns ?? []),
          slippageBps: scores.flatMap((s) => s.slippageBps!),
        },
      });
    publishAccountExpectation({
      strategy: item.trial.candidate.strategy,
      request,
      fills: item.artifacts.flatMap((a) => a.fills),
      inputHash: source.inputHash,
      resultHash,
      buildHash: plan.buildHash,
      source: `${source.source}; actual OOS segment fills; independent capital per window`,
      limitations: source.biasTags,
      actionCoverage: sourceFor(source, item.trial.candidate).actionCoverage,
    });
  }
  assertLifecycleProcessBudget("run-complete");
  return { ...report, resultHash: reportHash, reportPath };
}
