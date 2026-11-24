import {
  validationAdditionalReasons,
  validationNeighborhood,
  validationRowReasons,
  type ValidationPolicy,
  type ValidationRow,
} from "quant-backtest";
import { combinatoriallySymmetricCv } from "~/lib/backtest/backtest-overfit";
import {
  effectiveMultipleTesting,
  multipleTesting,
  sharpeDaily,
} from "~/lib/backtest/multiple-testing";

export type ValidationMethodCandidate = {
  row: ValidationRow;
  market: "cn-equity" | "crypto";
  sleeve: string;
  role?: "candidate" | "replay" | "terminal-accounting";
  neighborhoodCenter?: string;
  neighborhoodKind?: "entry" | "exit";
};
type OosTrial = {
  id: string;
  dates: string[];
  returns: (number | null)[];
};
export function validationOosTrial(row: ValidationRow): OosTrial {
  return {
    id: row.id,
    dates: row.windows.flatMap((w) => w.base.dailyDates ?? []),
    returns: row.windows.flatMap((w) => w.base.daily),
  };
}
function axesReason(trials: readonly OosTrial[]) {
  const dates = trials[0]?.dates;
  if (!dates?.length || dates.some((d, i) => i > 0 && d <= dates[i - 1]!))
    return "missing-or-invalid-oos-axis";
  return trials.some(
    (trial) =>
      trial.returns.length !== dates.length ||
      trial.dates.length !== dates.length ||
      trial.dates.some((date, i) => date !== dates[i]) ||
      trial.returns.some((r) => r === null || !Number.isFinite(r)),
  )
    ? "incomplete-or-misaligned-oos-returns"
    : null;
}
function isDailyDate(date: string) {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date)) &&
    new Date(date).toISOString().slice(0, 10) === date
  );
}
function correlation(
  a: readonly (number | null)[],
  b: readonly (number | null)[],
) {
  if (a.every((value, i) => value === b[i])) return 1;
  const left = a as readonly number[],
    right = b as readonly number[];
  const mean = (values: readonly number[]) =>
    values.reduce((sum, value) => sum + value / values.length, 0);
  const meanA = mean(left),
    meanB = mean(right);
  let numerator = 0,
    squareA = 0,
    squareB = 0;
  for (let i = 0; i < left.length; i++) {
    const x = left[i]! - meanA,
      y = right[i]! - meanB;
    numerator += x * y;
    squareA += x * x;
    squareB += y * y;
  }
  return squareA > 0 && squareB > 0
    ? numerator / Math.sqrt(squareA * squareB)
    : null;
}
/** Deterministic complete-link groups prevent a chain of weakly related trials
 * being declared one experiment. Missing returns are never zero-filled. */
export function clusterOosTrials(
  trials: readonly OosTrial[],
  threshold: number,
) {
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1)
    throw new Error("Invalid preregistered correlation threshold");
  const reason = axesReason(trials);
  if (reason)
    return { clusters: [] as string[][], effectiveTrials: null, reason };
  const clusters: OosTrial[][] = [];
  for (const trial of [...trials].sort((a, b) => a.id.localeCompare(b.id))) {
    const group = clusters.find((members) =>
      members.every(
        (member) =>
          (correlation(trial.returns, member.returns) ?? -Infinity) >=
          threshold,
      ),
    );
    if (group) group.push(trial);
    else clusters.push([trial]);
  }
  return {
    clusters: clusters.map((group) => group.map((trial) => trial.id)),
    effectiveTrials: clusters.length,
    reason: null,
  };
}

/** A frozen method declaration is mandatory. Prior results can only be
 * post-hoc diagnostics, irrespective of how attractive their corrected score. */
export function assessValidationCandidates(
  candidates: readonly ValidationMethodCandidate[],
  policy: ValidationPolicy & { minimumDsr: number },
  devOosDates?: readonly string[],
) {
  if (
    policy.method !== "lifecycle-2" ||
    policy.clusterCorrelation === undefined ||
    policy.maximumPbo === undefined ||
    !policy.purpose ||
    (policy.returnCriterion !== undefined &&
      policy.returnCriterion !== "risk-adjusted") ||
    !Number.isFinite(policy.maximumPbo) ||
    policy.maximumPbo < 0 ||
    policy.maximumPbo > 1
  )
    throw new Error("Missing declared lifecycle method parameters / purpose");
  if (new Set(candidates.map((c) => c.row.id)).size !== candidates.length)
    throw new Error("Duplicate method candidate IDs");
  if (
    devOosDates &&
    (!isDailyDate(policy.holdoutStart ?? "") ||
      !devOosDates.length ||
      devOosDates.some(
        (date, i) =>
          !isDailyDate(date) ||
          date >= policy.holdoutStart! ||
          (i > 0 && date <= devOosDates[i - 1]!),
      ))
  )
    throw new Error("Expected strictly pre-cut development OOS daily axis");
  const familyKey = (candidate: ValidationMethodCandidate) =>
    `${candidate.market}:${candidate.sleeve}`;
  const centerOf = (candidate: ValidationMethodCandidate) =>
    candidate.neighborhoodCenter ??
    candidate.row.id.replace(/-neighbor-(?:entry-)?\d+$/, "");
  const provenance = new Map(
    candidates.flatMap((c) =>
      c.neighborhoodKind ? [[c.row.id, c.neighborhoodKind] as const] : [],
    ),
  );
  const families = [...new Set(candidates.map(familyKey))].map((family) => {
    const members = candidates.filter(
      (candidate) => familyKey(candidate) === family,
    );
    const excluded: { id: string; reason: string }[] = [];
    const unique = new Map<string, OosTrial>();
    for (const member of members) {
      if (member.role && member.role !== "candidate") {
        excluded.push({ id: member.row.id, reason: member.role });
        continue;
      }
      const baseId = centerOf(member);
      const base =
        baseId === member.row.id
          ? undefined
          : members.find((candidate) => candidate.row.id === baseId);
      if (base) {
        const neighbor = validationNeighborhood(
          base.row,
          [member.row],
          policy,
          provenance,
        )[0]!;
        if (!neighbor.testable) {
          excluded.push({ id: member.row.id, reason: neighbor.reason! });
          continue;
        }
      }
      const trial = validationOosTrial(member.row);
      if (
        devOosDates &&
        (trial.dates.length !== devOosDates.length ||
          trial.dates.some((day, i) => day !== devOosDates[i]) ||
          axesReason([trial]) ||
          member.row.windows.some(
            (w) =>
              !w.base.dailyDates?.length ||
              w.base.dailyDates.length !== w.base.daily.length ||
              w.base.dailyDates[0] !== w.start ||
              w.base.dailyDates.at(-1) !== w.end,
          ))
      ) {
        excluded.push({
          id: trial.id,
          reason: "incomplete-or-misaligned-oos-returns",
        });
        continue;
      }
      const identity = JSON.stringify([trial.dates, trial.returns]);
      if (unique.has(identity))
        excluded.push({ id: trial.id, reason: "identical-oos-series" });
      else unique.set(identity, trial);
    }
    const trials = [...unique.values()];
    const cluster = clusterOosTrials(trials, policy.clusterCorrelation!);
    const cscv = combinatoriallySymmetricCv({
      returns: cluster.reason ? [] : trials.map((trial) => trial.returns),
      metric: "sharpe",
      splits: 10,
    });
    return {
      family,
      members: members.map((c) => c.row.id),
      trials,
      excluded,
      cluster,
      cscv,
    };
  });
  return candidates.map((candidate) => {
    const family = families.find(
      (group) => group.family === familyKey(candidate),
    )!;
    const center = centerOf(candidate);
    const siblings = candidates.filter(
      (other) =>
        familyKey(other) === family.family &&
        other.row.id !== candidate.row.id &&
        centerOf(other) === center,
    );
    const neighbors = validationNeighborhood(
      candidate.row,
      siblings.map((s) => s.row),
      policy,
      provenance,
    );
    const returns = devOosDates
      ? (family.trials.find((trial) => trial.id === candidate.row.id)
          ?.returns ?? [])
      : validationOosTrial(candidate.row).returns;
    const testing = family.cluster.effectiveTrials
      ? effectiveMultipleTesting(
          returns,
          family.trials.map((trial) => sharpeDaily(trial.returns)),
          family.cluster.effectiveTrials,
          candidate.market === "crypto" ? 365 : 252,
        )
      : multipleTesting(returns, [], candidate.market === "crypto" ? 365 : 252);
    const reasons = [
      ...validationRowReasons({ ...candidate.row, neighbors }, policy),
      ...validationAdditionalReasons({
        minimumDsr: policy.minimumDsr,
        dsr: testing?.selected.dsr.value ?? null,
        pbo: { value: family.cscv.pbo.value, maximum: policy.maximumPbo! },
        purpose: policy.purpose,
      }),
      ...(family.cluster.reason ? [family.cluster.reason] : []),
      ...(family.excluded.some((row) => row.id === candidate.row.id)
        ? ["statistical-trial-excluded"]
        : []),
    ];
    return {
      id: candidate.row.id,
      method: "lifecycle-2" as const,
      purpose: policy.purpose,
      label:
        policy.purpose === "post-hoc"
          ? "post-hoc re-evaluation"
          : "preregistered method evaluation",
      row: {
        ...candidate.row,
        neighbors,
        reasons,
        passed: reasons.length === 0,
      },
      testing,
      family,
      approximation:
        "Correlation clusters approximate effective trials; they do not prove independence",
    };
  });
}

/** Persist compact diagnostics once per candidate, without copying every
 * family's full return matrix into every scoreboard row. */
export function validationMethodEvidence(
  result: ReturnType<typeof assessValidationCandidates>[number],
) {
  return {
    method: result.method,
    purpose: result.purpose,
    label: result.label,
    family: result.family.family,
    trials: result.family.trials.map((trial) => ({
      id: trial.id,
      start: trial.dates[0],
      end: trial.dates.at(-1),
      observations: trial.returns.length,
    })),
    excluded: result.family.excluded,
    clusters: result.family.cluster,
    cscv: result.family.cscv,
    testing: result.testing,
    approximation: result.approximation,
  };
}
