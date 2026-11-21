import { strategyBuildHash } from "trading-strategies";
import { atomic } from "../db";
import { readJob } from "../db/jobs";
import { StrategyRepository } from "../db/strategy-repository";
import { saveValidationScoreboard } from "../db/validation-scoreboard";
import { validationInputSchema } from "./validation-model";
import { captureValidationInput } from "./validation-capture";
import { replayValidationInput, numericNeighbors } from "./validation-replay";
import {
  readValidationInput,
  writeValidationArtifact,
} from "./validation-artifacts";

export type ValidationWork = {
  type: "strategy-validation";
  root: string;
  input: unknown;
  frozenHash?: string;
  jobId?: string;
};
export async function executeValidationWork(
  work: ValidationWork,
  progress: (n: number, phase: string) => void = () => {},
  signal?: AbortSignal,
) {
  const controller = new AbortController();
  const replaySignal = signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
  const assertActive = () => {
    replaySignal.throwIfAborted();
    if (
      work.jobId &&
      !["queued", "running"].includes(readJob(work.jobId)?.status ?? "missing")
    )
      controller.abort(
        new DOMException(
          "Research task cancelled or no longer active",
          "AbortError",
        ),
      );
    replaySignal.throwIfAborted();
  };
  assertActive();
  const started = performance.now();
  const frozen = work.frozenHash
    ? await readValidationInput(work.frozenHash)
    : await captureValidationInput(
        validationInputSchema.parse(work.input),
        work.root,
        progress,
      );
  assertActive();
  const captureMs = performance.now() - started;
  const inputHash =
    work.frozenHash ?? (await writeValidationArtifact("input", frozen));
  progress(40, `输入已冻结 ${inputHash}`);
  assertActive();
  const result = replayValidationInput(
    frozen,
    (n, phase) => {
      progress(n, phase);
      assertActive();
    },
    replaySignal,
  );
  for (const dataset of frozen.datasets) {
    for (const source of dataset.sources ?? []) {
      const gap = source.terminalCoverage?.gap;
      if (gap)
        result.missing.push({
          id: `terminal-valuation:${source.symbol}:${dataset.period}`,
          reason: gap,
        });
    }
  }
  assertActive();
  const resultHash = await writeValidationArtifact("report", {
    inputHash,
    result,
  });
  // Qualification is a separate read model. No settings, subscriptions, mode,
  // account or outbox writes occur when publishing a scoreboard.
  const scoreboard = atomic(() => {
    assertActive();
    const repository = new StrategyRepository();
    for (const candidate of frozen.candidateMenu.flatMap((c) => [
      c,
      ...numericNeighbors(c, frozen.input.policy.method),
    ]))
      repository.saveStrategy(candidate.strategy);
    return saveValidationScoreboard({
      market: frozen.input.market,
      inputHash,
      resultHash,
      buildHash: strategyBuildHash,
      rows: result.rows,
      missing: result.missing,
      createdAt: Date.now(),
      runtimeMs: performance.now() - started,
      universe: frozen.universe?.grade ?? "current-spot-selection",
      gaps: [...(frozen.universe?.gaps ?? []), ...frozen.gaps],
    });
  });
  progress(100, "研究成绩单已保存");
  return {
    ...scoreboard,
    artifactVersion: result.version,
    timingStatus: result.timingStatus,
    schemaMigration: "unchanged" as const,
    captureMs,
    boundary: "Rule-check-only; no notifications or account/order API calls",
  };
}
