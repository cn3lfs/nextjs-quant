import {
  runPortfolio,
  runValidationSuite,
  validationRowReasons,
  type ValidationCandidate,
  type ValidationPolicy,
  type ValidationRow,
} from "quant-backtest";
import { multipleTesting, sharpeDaily } from "~/lib/backtest/multiple-testing";
import { scoreValidationResult } from "./validation-replay";
import type { ValidationDataset } from "./validation-capture";

export type CandidateCheckpoint = {
  row: ValidationRow;
  training: { start: string; end: string; score: ValidationRow["inSample"] }[];
  fullPeriod: ValidationRow["inSample"];
  elapsedMs: number;
};

/** Candidate execution is independent; selection and multiplicity are joined
 * only after all checkpoints exist. A partition never gets its own DSR gate.
 */
export function runCandidateCheckpoint(
  candidate: ValidationCandidate,
  dataset: ValidationDataset,
  policy: ValidationPolicy,
): CandidateCheckpoint {
  const started = performance.now();
  candidate = {
    ...candidate,
    request: { ...candidate.request, observationDetail: "counts" },
  };
  const suite = runValidationSuite(
    [candidate],
    dataset.dates,
    policy,
    (result, request) => scoreValidationResult(result, request, dataset),
  );
  return {
    row: suite.rows[0]!,
    training: suite.selection.map((window) => ({
      start: window.trainStart,
      end: window.trainEnd,
      score: window.families[0]!.training,
    })),
    fullPeriod: scoreValidationResult(
      runPortfolio(candidate.request),
      candidate.request,
      dataset,
    ),
    elapsedMs: performance.now() - started,
  };
}

export function joinCandidateCheckpoints(
  checkpoints: readonly CandidateCheckpoint[],
  policy: ValidationPolicy & { minimumDsr: number },
) {
  if (
    !checkpoints.length ||
    new Set(checkpoints.map((c) => c.row.id)).size !== checkpoints.length
  )
    throw new Error("Missing / duplicate candidate checkpoints");
  const trials = checkpoints.map((c) => sharpeDaily(c.fullPeriod.daily));
  return checkpoints.map((checkpoint) => {
    const original = checkpoint.row;
    const center = original.id.replace(/-neighbor-\d+$/, "");
    const neighbors = checkpoints
      .filter(
        (c) =>
          c.row.id !== original.id &&
          c.row.id.replace(/-neighbor-\d+$/, "") === center,
      )
      .map((c) => ({ id: c.row.id, excess: c.row.inSample.excess }));
    const reasons = validationRowReasons({ ...original, neighbors }, policy);
    const testing = multipleTesting(
      original.windows.flatMap((w) => w.base.daily),
      trials,
    );
    if (
      testing.selected.dsr.value === null ||
      testing.selected.dsr.value < policy.minimumDsr
    )
      reasons.push(`multiple-testing-dsr-${policy.minimumDsr}`);
    return {
      ...checkpoint,
      row: { ...original, neighbors, reasons, passed: !reasons.length },
      testing,
    };
  });
}

/** Reconstruct exactly the original family training selector across shards. */
export function checkpointFamilySelection(
  checkpoints: readonly CandidateCheckpoint[],
) {
  const families = [...new Set(checkpoints.map((c) => c.row.family))];
  return families.map((family) => {
    const candidates = checkpoints.filter((c) => c.row.family === family);
    const count = candidates[0]!.training.length;
    if (candidates.some((c) => c.training.length !== count))
      throw new Error("Training window count mismatch");
    return {
      family,
      windows: Array.from({ length: count }, (_, index) => {
        const sorted = candidates
          .map((c) => ({ id: c.row.id, ...c.training[index]! }))
          .sort(
            (a, b) =>
              (b.score.excess ?? -Infinity) - (a.score.excess ?? -Infinity) ||
              (a.score.drawdown ?? Infinity) - (b.score.drawdown ?? Infinity) ||
              a.id.localeCompare(b.id),
          );
        if (
          sorted.some(
            (c) => c.start !== sorted[0]!.start || c.end !== sorted[0]!.end,
          )
        )
          throw new Error("Training axes mismatch");
        const selected = sorted[0]!;
        const window = candidates.find((c) => c.row.id === selected.id)!.row
          .windows[index]!;
        return {
          trainStart: selected.start,
          trainEnd: selected.end,
          selectedId: selected.id,
          training: selected.score,
          result: window,
        };
      }),
    };
  });
}
