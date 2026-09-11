import { analyzeCzsc } from "./czsc";
import { intradayDependencies, runIntradayTick } from "./intraday-service";
import { runClsReviewTick } from "./cls-review-scheduler";

/** Both download paths retain the same close confirmation and news review.
 * Each service owns its enabled setting and completed-item retry rules.
 */
export async function runCloseWorkflowFollowups() {
  // A failure in signal confirmation must not prevent independent news review.
  const failures: unknown[] = [];
  try {
    await runIntradayTick(intradayDependencies(analyzeCzsc));
  } catch (error) {
    failures.push(error);
  }
  try {
    await runClsReviewTick();
  } catch (error) {
    failures.push(error);
  }
  if (failures.length)
    throw new Error(
      `收盘后续任务失败：${failures.map((error) => (error instanceof Error ? error.message : "未知错误")).join("；")}`,
    );
}
