import { join } from "node:path";
import {
  financialReplayBoundary,
  financialReplayTargets,
  type FinancialReplayInput,
} from "~/lib/financial/financial-replay";
import {
  appendResearchAttempt,
  assertResearchIdentity,
  assertResearchRunActive,
  ensureResearchRegistration,
  reportResearchJournalFailure,
  ResearchRunAbortedError,
  withResearchRunLock,
  type ResearchRunBudget,
} from "../research/research-run";
import {
  financialReplayPublicationFence,
  financialReplayRequestDirectory,
  financialReplayRequestIdentity,
  financialReplayRequestLockPath,
  financialReplayRunDirectory,
  financialReplayYearCache,
  resolveFinancialReplayRun,
} from "./financial-replay-source";
import {
  assembleFinancialReplayResult,
  runFinancialReplayCore,
} from "./financial-replay-core";
import { prepareFinancialReplay } from "./financial-replay-prepare";
import {
  financialReplayJobResult,
  indexFinancialReplay,
  reuseFinancialReplayResult,
  writeFinancialReplayResult,
  type FinancialReplayJobResult,
} from "./financial-replay-store";

export { financialReplayTargets };
export { financialReplayRequestLockPath, financialReplayRunDirectory };
export {
  financialReplayHistory,
  financialReplayJobResult,
  financialReplayTasks,
  financialReplayView,
  readFinancialReplay,
  readFinancialReplayResult,
} from "./financial-replay-store";
export type {
  FinancialReplayIndex,
  FinancialReplayJobResult,
  FinancialReplayTask,
} from "./financial-replay-store";
export type { FinancialReplayResult } from "./financial-replay-core";

export type FinancialReplayWork = {
  type: "financial-replay";
  root: string;
  input: FinancialReplayInput;
  /** Light normalized input identity; final source identity is computed in the worker. */
  requestIdentity: string;
};

const hostLocks = new Map<string, Promise<void>>();

/** Host-owned serialization for same-process retries. It waits on the prior
 * run's settlement without inspecting error strings; cross-process contention
 * is surfaced by the shared lock and never retried here. */
export async function withFinancialReplayHostLock<T>(
  requestIdentity: string,
  lockPath: string,
  signal: AbortSignal,
  run: () => Promise<T>,
): Promise<T> {
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Install this waiter at the tail before awaiting the prior owner. Otherwise
  // two waiters can both observe the same previous tail, then race the file lock.
  const previous = hostLocks.get(requestIdentity);
  hostLocks.set(requestIdentity, current);
  try {
    if (previous) {
      await previous;
      signal.throwIfAborted();
    }
    return await withResearchRunLock(lockPath, () => {
      signal.throwIfAborted();
      return run();
    });
  } finally {
    release();
    if (hostLocks.get(requestIdentity) === current)
      hostLocks.delete(requestIdentity);
  }
}

export async function appendFinancialReplayAttempt(
  requestIdentity: string,
  record: Record<string, unknown>,
) {
  await appendResearchAttempt(
    join(financialReplayRequestDirectory(requestIdentity), "attempts.jsonl"),
    record,
  );
}

function failureCode(error: unknown): string {
  if (error instanceof ResearchRunAbortedError) return error.reason;
  if (error instanceof Error && error.name === "ZodError")
    return "input-invalid";
  return "financial-replay-failed";
}

/** Worker orchestration. The host acquires the main-thread run lock and keeps
 * it until `runWorker` settles; this function only uses immutable checkpoints
 * and source-complete result reuse. */
export async function executeFinancialReplayWork(
  work: FinancialReplayWork,
  progress: (value: number, phase: string) => void = () => {},
  budget: ResearchRunBudget = {},
): Promise<FinancialReplayJobResult> {
  const journalPath = join(
      financialReplayRequestDirectory(work.requestIdentity),
      "attempts.jsonl",
    ),
    attempt = (status: string, extra: Record<string, unknown> = {}) =>
      appendFinancialReplayAttempt(work.requestIdentity, {
        at: new Date().toISOString(),
        requestIdentity: work.requestIdentity,
        status,
        ...extra,
      });
  try {
    await attempt("started", { input: work.input });
  } catch (error) {
    reportResearchJournalFailure(journalPath, error);
  }
  try {
    progress(0, "准备财务来源身份");
    const plan = await resolveFinancialReplayRun(work.input, work.root, budget);
    assertResearchIdentity(
      work.requestIdentity,
      financialReplayRequestIdentity(plan.config.input, work.root),
      "财务回放请求身份变化",
    );
    assertResearchRunActive(budget);
    const directory = financialReplayRunDirectory(plan.identity);
    await ensureResearchRegistration(join(directory, "registration.json"), {
      version: "financial-replay-registration-v1",
      identity: plan.identity,
      config: plan.config,
      years: plan.years,
      boundary: financialReplayBoundary,
    });
    const prepared = await prepareFinancialReplay(
      plan,
      progress,
      budget,
      financialReplayYearCache(plan.config.root, plan.identity, budget, {
        poolHash: plan.config.poolHash,
        calendarHash: plan.config.calendarHash,
        researchCodeHash: plan.config.researchCodeHash,
        financialSourceHash: plan.config.financialSourceHash,
      }),
    );
    if (prepared.kind === "ready") {
      const reused = await reuseFinancialReplayResult({
        resultIdentity: prepared.resultIdentity,
        annualIdentity: plan.identity,
        financialSourceHash: plan.config.financialSourceHash,
        calendarHash: plan.config.calendarHash,
        researchCodeHash: plan.config.researchCodeHash,
        poolHash: plan.config.poolHash,
        input: plan.config.input,
      });
      if (reused) {
        await financialReplayPublicationFence(plan, budget)();
        indexFinancialReplay(reused);
        try {
          await attempt("reused", {
            resultIdentity: reused.identity,
            hash: reused.hash,
          });
        } catch (error) {
          reportResearchJournalFailure(journalPath, error);
        }
        return financialReplayJobResult(reused);
      }
    }
    const result = assembleFinancialReplayResult(
      prepared,
      prepared.kind === "ready"
        ? runFinancialReplayCore(prepared, progress, budget)
        : undefined,
    );
    const stored = await writeFinancialReplayResult(
      result,
      financialReplayPublicationFence(plan, budget),
    );
    try {
      await appendResearchAttempt(join(directory, "attempts.jsonl"), {
        at: new Date().toISOString(),
        identity: plan.identity,
        resultIdentity: stored.identity,
        status: stored.status,
        hash: stored.hash,
        years: stored.years.length,
        actualCalls: stored.diagnostics.actualCalls,
        restoredCheckpoints: stored.diagnostics.restoredCheckpoints,
        blockedReason: stored.blockedReason,
      });
    } catch (error) {
      reportResearchJournalFailure(join(directory, "attempts.jsonl"), error);
    }
    indexFinancialReplay(stored);
    try {
      await attempt(stored.status, {
        resultIdentity: stored.identity,
        hash: stored.hash,
        blocked: !!stored.blockedReason,
        blockedYears: stored.years.filter((year) => year.status === "blocked")
          .length,
      });
    } catch (error) {
      reportResearchJournalFailure(journalPath, error);
    }
    return financialReplayJobResult(stored);
  } catch (error) {
    const cancelled =
      error instanceof ResearchRunAbortedError && error.reason === "cancelled";
    try {
      await attempt(cancelled ? "cancelled" : "failed", {
        errorCode: failureCode(error),
      });
    } catch (journalError) {
      reportResearchJournalFailure(journalPath, journalError);
    }
    throw error;
  }
}
