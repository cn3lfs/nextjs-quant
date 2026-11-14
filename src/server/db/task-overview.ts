import { sqlite } from "./index";

type TaskCounts = {
  total: number;
  running: number;
  queued: number;
  failed: number;
  cancelled: number;
  completedToday: number;
};
export type TaskOverview = TaskCounts & {
  revision: number;
  checkedAt: number;
  latestCompletedScan: { id: string; updatedAt: number } | null;
};

/** Whole-job statistics, using the existing covering metadata index. */
export const taskOverviewSql = `SELECT count(*) total,
      coalesce(sum(json_extract(payload,'$.status')='running'),0) running,
      coalesce(sum(json_extract(payload,'$.status')='queued'),0) queued,
      coalesce(sum(json_extract(payload,'$.status')='failed'),0) failed,
      coalesce(sum(json_extract(payload,'$.status')='cancelled'),0) cancelled,
      coalesce(sum(json_extract(payload,'$.status')='completed' AND json_extract(payload,'$.updatedAt')>=? AND json_extract(payload,'$.updatedAt')<?),0) completedToday
      FROM records WHERE kind='job'`;

/** Completion time, with a stable ID tie-breaker; never load scan input/results. */
export const latestCompletedScanSql = `SELECT id,
    json_extract(payload,'$.updatedAt') AS updatedAt
  FROM records INDEXED BY job_task_history
  WHERE kind='job' AND json_extract(payload,'$.type')='scan'
    AND json_extract(payload,'$.status')='completed'
  ORDER BY json_extract(payload,'$.updatedAt') DESC, id DESC LIMIT 1`;

/** Counts, latest completed scan and revision are from one read transaction. */
export function taskOverview(now = Date.now()): TaskOverview {
  const start =
    Math.floor((now + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
  const database = sqlite();
  return database.transaction(() => {
    const counts = database
      .prepare(taskOverviewSql)
      .get(start, start + 86400000) as TaskCounts;
    const latestCompletedScan =
      (database.prepare(latestCompletedScanSql).get() as
        NonNullable<TaskOverview["latestCompletedScan"]> | undefined) ?? null;
    const revision =
      (
        database
          .prepare(
            "SELECT revision FROM record_kind_revisions WHERE kind='job'",
          )
          .get() as { revision: number } | undefined
      )?.revision ?? 0;
    return { ...counts, latestCompletedScan, revision, checkedAt: now };
  })();
}
