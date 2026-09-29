import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { migrate } from "../src/server/db/migrations";
import { ClsReviewStore } from "../src/server/news/cls-review-store";
import { seedClsReview } from "./helpers/cls-review-fixture";

const logs = join(tmpdir(), "logs", "quant-cls-review");
mkdirSync(logs, { recursive: true });
const directory = process.env.QUANT_DATA_DIR;
if (!directory || !directory.includes("quant-cls-review"))
  throw new Error("Explicit isolated QUANT_DATA_DIR required");
mkdirSync(directory, { recursive: true });
const db = new Database(join(directory, "quant.sqlite"));
try {
  migrate(db);
  const existing = db.prepare("SELECT count(*) count FROM records").get() as {
    count: number;
  };
  if (existing.count)
    throw new Error("Use an empty isolated fixture directory");
  seedClsReview(db);
  const store = new ClsReviewStore(db);
  const measure = (run: () => unknown) => {
    for (let i = 0; i < 5; i++) run();
    const values = Array.from({ length: 30 }, () => {
      const start = performance.now();
      run();
      return performance.now() - start;
    }).sort((a, b) => a - b);
    return { p50: values[15], p95: values[28], max: values[29] };
  };
  const baseline = {
    node: process.version,
    fixture: { reports: 1000, facts: 10000, verifications: 10000 },
    bytes: db
      .prepare("SELECT SUM(length(CAST(payload AS BLOB))) bytes FROM records")
      .get(),
    reports: measure(() => store.reports()),
    facts: measure(() => store.facts("cls-review-report:fixture-00000")),
    verifications: measure(() => store.verifications("2020-01-01")),
    summary: measure(() => store.outcomeSummary()),
  };
  writeFileSync(
    join(logs, "sql-before.json"),
    JSON.stringify(baseline, null, 2),
  );
  console.log(JSON.stringify(baseline));
} finally {
  db.close();
}
