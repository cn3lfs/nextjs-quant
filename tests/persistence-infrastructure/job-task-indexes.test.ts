import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "~/server/db/migrations";
import { jobSummariesSql } from "~/server/db/job-summaries";
import { taskHistorySql } from "~/server/db/task-history";
import {
  taskOverviewSql,
  latestCompletedScanSql,
} from "~/server/db/task-overview";

/**
 * The indexes only help while query expressions match them and are selected
 * as plain columns (wrapping them in json_object() forces a table read).
 */
it("task overview, history and recent summaries read the job metadata indexes", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const plan = (sql: string, ...args: unknown[]) =>
      (
        db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as {
          detail: string;
        }[]
      )
        .map((r) => r.detail)
        .join(" | ");
    expect(plan(taskOverviewSql, 0, 1)).toMatch(
      /COVERING INDEX job_(task_history|recent_summary)/,
    );
    expect(plan(latestCompletedScanSql)).toContain(
      "COVERING INDEX job_task_history",
    );
    const history = plan(taskHistorySql("kind = 'job'"));
    expect(history).toContain("COVERING INDEX job_task_history");
    expect(history).not.toContain("TEMP B-TREE");
    expect(
      plan(
        taskHistorySql(
          "kind = 'job' AND json_extract(payload, '$.status') = ?",
        ),
        "failed",
      ),
    ).toContain("INDEX job_task_history");
    expect(plan(jobSummariesSql)).toContain(
      "COVERING INDEX job_recent_summary",
    );
  } finally {
    db.close();
  }
});
