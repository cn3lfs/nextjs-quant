/** Isolated, deterministic SQL/serialization benchmark. Never use the production DB. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sqlite } from "../src/server/db";
import * as tasks from "../src/server/jobs/task-history";
import { jobSummaries } from "../src/server/jobs/job-summaries";

assert.ok(process.env.QUANT_DATA_DIR);
assert.ok(
  resolve(process.env.QUANT_DATA_DIR!).startsWith(
    resolve(tmpdir()) + "\\quant-task-center-",
  ),
);
const phase = process.env.TASK_PHASE ?? "before";
const db = sqlite();
assert.equal(
  (
    db.prepare("SELECT count(*) n FROM records WHERE kind='job'").get() as {
      n: number;
    }
  ).n,
  0,
  "Use a fresh isolated directory for each benchmark; existing jobs would contaminate smaller datasets",
);
const stamp = Date.parse("2026-09-28T12:00:00+08:00");
const insert = db.prepare(
  "INSERT OR REPLACE INTO records(id,kind,payload,updated_at) VALUES(?,'job',?,?)",
);
const results: unknown[] = [];
for (const count of [100, 1000, 10000]) {
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const id = `task-perf-${String(i).padStart(5, "0")}`;
      insert.run(
        id,
        JSON.stringify({
          id,
          type: i % 2 ? "screen" : "research",
          status: i % 3 ? "completed" : "failed",
          progress: 100,
          createdAt: stamp + i,
          updatedAt: stamp + i,
          phase: "合成任务基线",
          error: i % 3 ? undefined : "合成错误",
          input: { private: "not-for-ui" },
          result: i === 0 ? { payload: "x".repeat(1000000) } : {},
        }),
        stamp + i,
      );
    }
  })();
  const cases: Record<string, () => unknown> = {
    history: () => tasks.taskHistory({}),
    filtered: () => tasks.taskHistory({ status: "failed" }),
    detail: () => tasks.taskState("task-perf-00000"),
    summaries: jobSummaries,
  };
  if ("taskOverview" in tasks)
    cases.overview = () =>
      (tasks as unknown as { taskOverview: () => unknown }).taskOverview();
  for (const [name, run] of Object.entries(cases)) {
    for (let i = 0; i < 5; i++) run();
    const samples = [];
    let bytes = 0;
    for (let i = 0; i < 30; i++) {
      const at = performance.now();
      const result = run();
      bytes = Buffer.byteLength(JSON.stringify(result));
      samples.push(performance.now() - at);
    }
    const sorted = [...samples].sort((a, b) => a - b);
    results.push({
      count,
      name,
      bytes,
      median: sorted[15],
      p95: sorted[28],
      samples,
    });
  }
}
const explain = db
  .prepare(
    "EXPLAIN QUERY PLAN SELECT id FROM records WHERE kind='job' ORDER BY json_extract(payload,'$.createdAt') DESC,id DESC LIMIT 21",
  )
  .all();
const dir = join(tmpdir(), "logs", "quant-task-center");
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, `sql-${phase}.json`),
  JSON.stringify({ phase, results, explain }, null, 2),
);
console.log(
  JSON.stringify({
    phase,
    results: results.map(({ samples, ...value }: any) => value),
    explain,
  }),
);
db.close();
