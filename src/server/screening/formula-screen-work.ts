import { requireRunningFormulaJob } from "../db/jobs";
import { putChangedBatch } from "../db";
import { screenFormula, type FormulaWork } from "./formula-screening";
import { serializeSnapshot } from "./snapshot-serializer";
import type { WorkProgress } from "~/lib/research/workflow/work-progress";
import type { Snapshot } from "~/lib/domain";
import type { FormulaScreenResult } from "./formula-screening";
import {
  createFormulaSnapshotSpool,
  clearFormulaSnapshotSpool,
  readFormulaSnapshots,
} from "./formula-snapshot-spool";

export type FormulaScreenOutput = Omit<
  FormulaScreenResult,
  "snapshots" | "snapshotFiles"
>;

/** Keep full-history snapshots in the compute worker. Transferring millions of
 * bar objects to the HTTP thread blocks every request during structured clone.
 * Only candidate metadata crosses back after its snapshots have been saved.
 */
export async function executeFormulaScreen(
  work: FormulaWork,
  jobId: string | undefined,
  progress?: (n: number, phase: string, counts?: WorkProgress) => void,
  batchSaved?: () => Promise<void>,
): Promise<FormulaScreenOutput> {
  if (!jobId) throw new Error("公式选股缺少任务身份");
  const requireRunning = () => requireRunningFormulaJob(jobId);
  requireRunning();
  const directory = await createFormulaSnapshotSpool(jobId);
  try {
    const result = await screenFormula(
      { ...work, snapshotDirectory: directory },
      progress,
    );
    const selected = new Set(
      result.candidates.map((candidate) => candidate.snapshotId),
    );
    let batch: Snapshot[] = [];
    const saveBatch = async () => {
      if (!batch.length) return;
      // The running check and writes share one immediate transaction.
      putChangedBatch("snapshot", batch, serializeSnapshot, requireRunning);
      batch = [];
      if (batchSaved) await batchSaved();
      else {
        progress?.(95, "保存公式候选快照");
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };
    for await (const snapshot of readFormulaSnapshots(
      jobId,
      result.snapshotFiles,
    )) {
      if (!selected.has(snapshot.id)) continue;
      batch.push(snapshot);
      if (batch.length === 50) await saveBatch();
    }
    await saveBatch();
    requireRunning();
    const {
      snapshots: _snapshots,
      snapshotFiles: _snapshotFiles,
      ...output
    } = result;
    return output;
  } finally {
    await clearFormulaSnapshotSpool(jobId);
  }
}
