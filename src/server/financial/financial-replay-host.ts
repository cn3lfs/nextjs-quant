import { join } from "node:path";
import { readJob } from "../db/jobs";
import { runWorker } from "../jobs/jobs";
import { reportResearchJournalFailure } from "../research/research-run";
import {
  financialReplayRequestDirectory,
  financialReplayRequestLockPath,
} from "./financial-replay-source";
import type { FinancialReplayJobResult } from "./financial-replay-store";
import {
  appendFinancialReplayAttempt,
  withFinancialReplayHostLock,
  type FinancialReplayWork,
} from "./financial-replay-work";

/** Host boundary: owns the main-thread lock and records a forced worker
 * termination after the worker has settled. The worker cannot rely on its own
 * `finally` when the host terminates it. */
export async function runFinancialReplayJob(
  work: FinancialReplayWork,
  jobId: string,
  signal: AbortSignal,
): Promise<FinancialReplayJobResult> {
  const lockPath = financialReplayRequestLockPath(work.requestIdentity);
  try {
    const result = await withFinancialReplayHostLock(
      work.requestIdentity,
      lockPath,
      signal,
      () => runWorker<FinancialReplayJobResult>(work, jobId),
    );
    signal.throwIfAborted();
    return result;
  } catch (error) {
    const cancelled = signal.aborted || readJob(jobId)?.status === "cancelled";
    try {
      await appendFinancialReplayAttempt(work.requestIdentity, {
        at: new Date().toISOString(),
        requestIdentity: work.requestIdentity,
        status: cancelled ? "cancelled" : "failed",
        errorCode: cancelled ? "cancelled" : "worker-failed",
      });
    } catch (journalError) {
      reportResearchJournalFailure(
        join(
          financialReplayRequestDirectory(work.requestIdentity),
          "attempts.jsonl",
        ),
        journalError,
      );
    }
    throw error;
  }
}
