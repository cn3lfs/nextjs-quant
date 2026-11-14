import { requireRunningFormulaJob } from "../db/jobs";
import { putChangedBatch } from "../db";
import { screenFormula, type FormulaWork } from "./formula-screening";
import { serializeSnapshot } from "./snapshot-serializer";
import type { WorkProgress } from "~/lib/research/workflow/work-progress";
import type { ScreeningResult } from "./screening-result";

export type FormulaScreenOutput = Omit<ScreeningResult, "snapshots">;

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
  const result = await screenFormula(work, progress);
  for (let i = 0; i < result.snapshots.length; i += 50) {
    // The status check and snapshot writes share the same immediate transaction,
    // so another connection cannot commit cancellation between them.
    putChangedBatch(
      "snapshot",
      result.snapshots.slice(i, i + 50),
      serializeSnapshot,
      requireRunning,
    );
    if (batchSaved) await batchSaved();
    else {
      progress?.(95, "保存公式候选快照");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  requireRunning();
  const { snapshots: _snapshots, ...output } = result;
  return output;
}
