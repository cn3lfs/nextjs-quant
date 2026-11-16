import {
  runPortfolio,
  createPortfolioPreparation,
  type PortfolioRequest,
} from "./portfolio-engine.js";
import { marketRules } from "trading-strategy-core/market-rules";
import type { StrategyObjectInput } from "trading-strategies";

/** External projected decisions need the original rule's declaration. Native
 * warmup origins/configuration are fixed evidence, not trading parameters. */
export function validationEntryParameterSensitivity(
  strategies: readonly StrategyObjectInput[],
): "required" | "not-applicable" | undefined {
  if (strategies.some((s) => s.entry.kind === "external")) return undefined;
  return strategies.some(
    ({ entry }) =>
      entry.kind === "dual-ma" ||
      entry.kind === "rps" ||
      entry.kind === "screening-metrics" ||
      (entry.kind === "factor" &&
        entry.strategy.entry.conditions.some(
          (condition) =>
            Object.keys(condition.left.parameters ?? {}).length > 0 ||
            ("factor" in condition.right
              ? Object.keys(condition.right.factor.parameters ?? {}).length > 0
              : condition.right.constant !== 0),
        )) ||
      entry.kind === "historical-low" ||
      (entry.kind === "formula" &&
        Object.keys(entry.parameters ?? {}).length > 0),
  )
    ? "required"
    : "not-applicable";
}

export type ValidationScore = {
  /** Present only in the declared lifecycle method; legacy artifacts stay exact. */
  dailyDates?: string[];
  tradeListHash?: string;
  /** Same-version reference distributions; missing is not a zero sample. */
  dailySignals?: number[];
  tradeReturns?: number[];
  slippageBps?: number[];
  riskAdjusted?: {
    sharpe: number | null;
    benchmarkSharpe: number | null;
    sharpeDifference: number | null;
    calmar: number | null;
    benchmarkCalmar: number | null;
    calmarDifference: number | null;
    basis: string;
  };
  return: number | null;
  excess: number | null;
  drawdown: number | null;
  trades: number;
  events: {
    entries: number;
    exits: number;
    orders: number;
    fills: number;
    rejectionAttempts: number;
  };
  daily: (number | null)[];
};
export type ValidationPolicy = {
  method?: "legacy" | "lifecycle-2";
  purpose?: "preregistered" | "post-hoc";
  clusterCorrelation?: number;
  maximumPbo?: number;
  returnCriterion?: "risk-adjusted" | "raw-excess";
  holdoutStart?: string;
  trainBars: number;
  testBars: number;
  minimumWindows: number;
  minimumTrades: number;
  maximumDrawdown: number;
  minimumPositiveWindows: number;
  minimumStableNeighbors: number;
};
export const validationDefaults = {
  returnCriterion: "risk-adjusted",
  minimumWindows: 3,
  minimumTrades: 30,
  maximumDrawdown: 0.25,
  minimumPositiveWindows: 0.6,
  minimumStableNeighbors: 0.5,
} as const;
export function validationScorePasses(
  score: ValidationScore,
  criterion: ValidationPolicy["returnCriterion"] = validationDefaults.returnCriterion,
) {
  const positive = (value: number | null | undefined) =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  return criterion === "raw-excess"
    ? positive(score.excess)
    : positive(score.return) && positive(score.riskAdjusted?.sharpeDifference);
}

/** Reassessment consumes frozen scores without replaying or retuning signals. */
export function validationRowReasons(
  row: ValidationRow,
  policy: ValidationPolicy,
) {
  const criterion =
    policy.method === "lifecycle-2"
      ? "risk-adjusted"
      : (policy.returnCriterion ?? validationDefaults.returnCriterion);
  const reasons: string[] = [];
  const count = row.windows.length;
  if (count < policy.minimumWindows) reasons.push("insufficient-oos-windows");
  const positive = row.windows.filter((w) =>
    validationScorePasses(w.base, criterion),
  ).length;
  if (!count || positive / count < policy.minimumPositiveWindows)
    reasons.push(
      criterion === "raw-excess"
        ? "oos-positive-excess-majority"
        : "oos-positive-risk-adjusted-majority",
    );
  // Each stress must independently pass a majority; their passing windows need
  // not coincide. The holdout must pass both stresses.
  if (
    !count ||
    (criterion === "raw-excess" &&
      row.windows.filter((w) =>
        [w.doubledCost, w.delayed].every((s) =>
          validationScorePasses(s, criterion),
        ),
      ).length /
        count <
        policy.minimumPositiveWindows) ||
    (["doubledCost", "delayed"] as const).some(
      (kind) =>
        row.windows.filter((w) => validationScorePasses(w[kind], criterion))
          .length /
          count <
          policy.minimumPositiveWindows ||
        !validationScorePasses(row.holdout[kind], criterion),
    )
  )
    reasons.push("cost-or-delay-stress");
  if (row.closedTrades < policy.minimumTrades)
    reasons.push("insufficient-closed-trades");
  if (
    [
      ...row.windows.flatMap((w) => [w.base, w.doubledCost, w.delayed]),
      row.holdout.base,
      row.holdout.doubledCost,
      row.holdout.delayed,
    ].some((s) => s.drawdown === null || s.drawdown > policy.maximumDrawdown)
  )
    reasons.push("drawdown-bound");
  if (!validationScorePasses(row.holdout.base, criterion))
    reasons.push(
      criterion === "raw-excess"
        ? "holdout-positive-excess"
        : "holdout-positive-risk-adjusted",
    );
  const testableNeighbors =
    policy.method === "lifecycle-2"
      ? row.neighbors.filter((n) => n.testable === true)
      : row.neighbors;
  if (
    !testableNeighbors.length ||
    testableNeighbors.filter((n) =>
      policy.method === "lifecycle-2"
        ? n.oosPassed === true
        : n.excess !== null && n.excess > 0,
    ).length /
      testableNeighbors.length <
      policy.minimumStableNeighbors
  )
    reasons.push("parameter-neighborhood");
  if (
    policy.method === "lifecycle-2" &&
    row.entryParameterSensitivity === undefined
  )
    reasons.push("missing-entry-parameter-declaration");
  if (
    policy.method === "lifecycle-2" &&
    row.entryParameterSensitivity === "required" &&
    !testableNeighbors.some((n) => n.perturbed === "entry")
  )
    reasons.push("entry-neighborhood-not-testable");
  return reasons;
}

/** All consumers share eligibility reasons; statistical calculations stay with
 * their owning pure modules and supply explicit evidence, never defaults. */
export function validationAdditionalReasons(input: {
  minimumDsr: number;
  dsr: number | null;
  pbo?: { value: number | null; maximum: number };
  lowZone?: { cycles: number; minimumCycles: number; corroborated: boolean };
  purpose?: "preregistered" | "post-hoc";
}) {
  const reasons: string[] = [];
  if (
    input.dsr === null ||
    !Number.isFinite(input.dsr) ||
    input.dsr < input.minimumDsr
  )
    reasons.push(`multiple-testing-dsr-${input.minimumDsr}`);
  if (
    input.pbo &&
    (input.pbo.value === null ||
      !Number.isFinite(input.pbo.value) ||
      input.pbo.value > input.pbo.maximum)
  )
    reasons.push("family-cscv-pbo");
  if (input.lowZone) {
    if (input.lowZone.cycles < input.lowZone.minimumCycles)
      reasons.push("insufficient-complete-market-cycles");
    if (!input.lowZone.corroborated) reasons.push("low-zone-input-confidence");
  }
  if (input.purpose === "post-hoc")
    reasons.push("post-hoc-re-evaluation-not-promotable");
  return reasons;
}
export type ValidationCandidate = {
  entryParameterSensitivity?: "required" | "not-applicable";
  id: string;
  family: string;
  request: PortfolioRequest;
  neighborIds?: readonly string[];
};
export type ValidationRun = {
  start: string;
  end: string;
  base: ValidationScore;
  doubledCost: ValidationScore;
  delayed: ValidationScore;
};
export type ValidationRow = {
  entryParameterSensitivity?: "required" | "not-applicable";
  id: string;
  family: string;
  inSample: ValidationScore;
  holdout: ValidationRun;
  windows: ValidationRun[];
  neighbors: {
    id: string;
    excess: number | null;
    testable?: boolean;
    oosPassed?: boolean;
    perturbed?: "entry" | "exit";
    reason?: string;
  }[];
  positiveWindows: number;
  stressPositiveWindows: number;
  closedTrades: number;
  reasons: string[];
  passed: boolean;
};

export function validationNeighborhood(
  row: ValidationRow,
  neighbors: readonly ValidationRow[],
  policy: ValidationPolicy,
): ValidationRow["neighbors"] {
  if (policy.method !== "lifecycle-2")
    return neighbors.map((n) => ({ id: n.id, excess: n.inSample.excess }));
  return neighbors.map((neighbor) => {
    const hashes = row.windows.map((w) => w.base.tradeListHash);
    const other = neighbor.windows.map((w) => w.base.tradeListHash);
    const evidence =
      hashes.length > 0 &&
      hashes.length === other.length &&
      [...hashes, ...other].every((hash) => typeof hash === "string");
    const identical = evidence && hashes.every((hash, i) => hash === other[i]);
    const testable = evidence && !identical;
    return {
      id: neighbor.id,
      excess: neighbor.inSample.excess,
      testable,
      oosPassed:
        testable &&
        neighbor.windows.filter((w) =>
          validationScorePasses(w.base, "risk-adjusted"),
        ).length /
          neighbor.windows.length >=
          policy.minimumPositiveWindows,
      perturbed: neighbor.id.includes("-neighbor-entry-")
        ? ("entry" as const)
        : ("exit" as const),
      ...(!testable
        ? {
            reason: identical
              ? "identical-oos-trades"
              : "missing-oos-trade-evidence",
          }
        : {}),
    };
  });
}

/** Only the training prefix is supplied to the engine and ranking callback.
 * Each segment starts with independent capital, preserving earlier features but
 * no inherited positions. The separate last-20% split overlaps rolling OOS;
 * it is a diagnostic, never an extra independent statistical trial.
 */
export function runValidationSuite(
  candidates: readonly ValidationCandidate[],
  dates: readonly string[],
  policy: ValidationPolicy,
  score: (
    result: ReturnType<typeof runPortfolio>,
    request: PortfolioRequest,
  ) => ValidationScore,
  progress: (done: number, total: number) => void = () => {},
) {
  if (
    !candidates.length ||
    (policy.returnCriterion !== undefined &&
      !["risk-adjusted", "raw-excess"].includes(policy.returnCriterion)) ||
    new Set(candidates.map((c) => c.id)).size !== candidates.length ||
    dates.length < 10 ||
    policy.trainBars >= dates.length ||
    dates.some(
      (d, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        !Number.isFinite(Date.parse(d)) ||
        (i > 0 && d <= dates[i - 1]!),
    ) ||
    ![
      policy.trainBars,
      policy.testBars,
      policy.minimumWindows,
      policy.minimumTrades,
    ].every((n) => Number.isInteger(n) && n > 0) ||
    ![
      policy.maximumDrawdown,
      policy.minimumPositiveWindows,
      policy.minimumStableNeighbors,
    ].every((n) => Number.isFinite(n) && n > 0 && n <= 1)
  )
    throw new Error("Invalid validation candidates / dates / policy");
  const windows: {
    trainStart: string;
    trainEnd: string;
    start: string;
    end: string;
  }[] = [];
  for (
    let i = policy.trainBars;
    i + policy.testBars <= dates.length;
    i += policy.testBars
  )
    windows.push({
      trainStart: dates[i - policy.trainBars]!,
      trainEnd: dates[i - 1]!,
      start: dates[i]!,
      end: dates[i + policy.testBars - 1]!,
    });
  const split =
    policy.holdoutStart === undefined
      ? Math.floor(dates.length * 0.8)
      : dates.findIndex((d) => d >= policy.holdoutStart!);
  if (
    split < 1 ||
    !dates[split] ||
    (policy.holdoutStart !== undefined &&
      !Number.isFinite(Date.parse(policy.holdoutStart)))
  )
    throw new Error("Invalid holdout start");
  let prefix:
    | {
        candidate: ValidationCandidate;
        end: string;
        request: PortfolioRequest;
        preparation: ReturnType<typeof createPortfolioPreparation>;
      }
    | undefined;
  const run = (
    candidate: ValidationCandidate,
    start: string,
    end: string,
    costMultiplier = 1,
    delay: 0 | 1 = 0,
  ) => {
    const original = candidate.request;
    const costs = original.costs ?? marketRules[original.market].costs;
    if (!costs) throw new Error("Missing market cost assumptions");
    if (prefix?.candidate !== candidate || prefix.end !== end) {
      const frozenPrefix: PortfolioRequest = {
        ...original,
        start,
        end,
        calendar: original.calendar.filter((d) => d.slice(0, 10) <= end),
        instruments: original.instruments.map((instrument) => ({
          ...instrument,
          bars: instrument.bars.filter((b) => b.date.slice(0, 10) <= end),
          signalBars: instrument.signalBars.filter(
            (b) => b.date.slice(0, 10) <= end,
          ),
          actions: instrument.actions?.filter((a) => a.date <= end),
          external: instrument.external && {
            ...instrument.external,
            rps: instrument.external.rps?.filter(
              (r) => r.date.slice(0, 10) <= end,
            ),
            chan: instrument.external.chan?.filter(
              (r) => r.date.slice(0, 10) <= end,
            ),
            signals: instrument.external.signals?.filter(
              (r) => r.date.slice(0, 10) <= end,
            ),
            levels: instrument.external.levels?.filter(
              (r) => r.date.slice(0, 10) <= end,
            ),
            lowZone: instrument.external.lowZone?.filter(
              (r) => r.date.slice(0, 10) <= end,
            ),
          },
        })),
        positionWeights: original.positionWeights?.filter(
          (w) => w.date.slice(0, 10) <= end,
        ),
        memberships: original.memberships?.filter(
          (m) => m.date.slice(0, 10) <= end,
        ),
        sleeveTargets: original.sleeveTargets?.filter(
          (t) => t.date.slice(0, 10) <= end,
        ),
      };
      prefix = {
        candidate,
        end,
        request: frozenPrefix,
        preparation: createPortfolioPreparation(),
      };
    }
    const request: PortfolioRequest = {
      ...prefix.request,
      start,
      end,
      signalDelayBars: delay,
      costs: Object.fromEntries(
        Object.entries(costs).map(([key, value]) => [
          key,
          key === "sellTaxSchedule" && costs.sellTaxSchedule
            ? {
                ...costs.sellTaxSchedule,
                multiplier: costs.sellTaxSchedule.multiplier * costMultiplier,
              }
            : typeof value === "number"
              ? value * costMultiplier
              : value,
        ]),
      ) as typeof costs,
    };
    return score(runPortfolio(request, undefined, prefix.preparation), request);
  };
  const stress = (
    c: ValidationCandidate,
    start: string,
    end: string,
  ): ValidationRun => ({
    start,
    end,
    base: run(c, start, end),
    doubledCost: run(c, start, end, 2),
    delayed: run(c, start, end, 1, 1),
  });
  const training = windows.map((window) =>
    candidates.map((c) => run(c, window.trainStart, window.trainEnd)),
  );
  const selection = windows.map((window, index) => ({
    ...window,
    families: [...new Set(candidates.map((c) => c.family))].map((family) => {
      const eligible = candidates
        .map((c, i) => ({ c, i, score: training[index]![i]! }))
        .filter((x) => x.c.family === family);
      eligible.sort(
        (a, b) =>
          (b.score.excess ?? -Infinity) - (a.score.excess ?? -Infinity) ||
          (a.score.drawdown ?? Infinity) - (b.score.drawdown ?? Infinity) ||
          a.c.id.localeCompare(b.c.id),
      );
      return {
        family,
        selectedId: eligible[0]!.c.id,
        training: eligible[0]!.score,
      };
    }),
  }));
  const rows: ValidationRow[] = candidates.map((candidate, index) => {
    const evaluated = windows.map((w) => stress(candidate, w.start, w.end));
    const positiveWindows = evaluated.filter((w) =>
      validationScorePasses(w.base, policy.returnCriterion),
    ).length;
    const stressPositiveWindows = evaluated.filter((w) =>
      [w.doubledCost, w.delayed].every((s) =>
        validationScorePasses(s, policy.returnCriterion),
      ),
    ).length;
    const closedTrades = evaluated.reduce((n, w) => n + w.base.trades, 0);
    progress(index + 1, candidates.length);
    return {
      ...(policy.method === "lifecycle-2"
        ? {
            entryParameterSensitivity:
              candidate.entryParameterSensitivity ??
              validationEntryParameterSensitivity(candidate.request.strategies),
          }
        : {}),
      id: candidate.id,
      family: candidate.family,
      inSample: run(candidate, dates[0]!, dates[policy.trainBars - 1]!),
      holdout: stress(candidate, dates[split]!, dates.at(-1)!),
      windows: evaluated,
      neighbors: [],
      positiveWindows,
      stressPositiveWindows,
      closedTrades,
      reasons: [],
      passed: false,
    };
  });
  for (const row of rows) {
    const neighbors = candidates.find((c) => c.id === row.id)!.neighborIds;
    const related = rows.filter((r) =>
      neighbors
        ? neighbors.includes(r.id)
        : r.family === row.family && r.id !== row.id,
    );
    row.neighbors = validationNeighborhood(row, related, policy);
    const reasons = validationRowReasons(row, policy);
    row.reasons = reasons;
    row.passed = reasons.length === 0;
  }
  return {
    version: "validation-suite-1" as const,
    policy,
    windows,
    selection,
    rows,
    selectedOos: selection.map((s, index) => ({
      start: s.start,
      end: s.end,
      families: s.families.map((f) => ({
        ...f,
        result: rows.find((r) => r.id === f.selectedId)!.windows[index]!,
      })),
    })),
  };
}
