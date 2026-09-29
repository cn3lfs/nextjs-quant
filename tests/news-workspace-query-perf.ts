/** Paired readonly source fixture and metadata query measurements; no production DB. */
import Database from "better-sqlite3";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  newsWorkspacePage,
  newsArchivePage,
} from "../src/server/news/news-workspace-query";
import {
  seedNewsAnalyses,
  newsFixtureCutoff,
} from "./helpers/news-workspace-fixture";
const logs = join(tmpdir(), "logs", "quant-news");
const before = JSON.parse(readFileSync(join(logs, "sql-before.json"), "utf8"));
const results: unknown[] = [];
function queryPlan(
  db: Database.Database,
  run: () => unknown,
  args: (string | number)[],
) {
  const prepare = Database.prototype.prepare;
  let sql = "";
  // Capture the actual query, not a hand-maintained approximation of its plan.
  Database.prototype.prepare = function (
    this: Database.Database,
    text: string,
  ) {
    if (text.startsWith("WITH ")) sql = text;
    return prepare.call(this, text);
  } as typeof prepare;
  try {
    run();
  } finally {
    Database.prototype.prepare = prepare;
  }
  if (!sql) throw new Error("No materialized query captured");
  return { sql, plan: db.prepare("EXPLAIN QUERY PLAN " + sql).all(...args) };
}
function measure(fn: () => unknown) {
  const samples: number[] = [];
  let bytes = 0;
  for (let i = 0; i < 35; i++) {
    const start = performance.now();
    const value = fn();
    const ms = performance.now() - start;
    if (i >= 5) samples.push(ms);
    bytes = Buffer.byteLength(JSON.stringify(value));
  }
  samples.sort((a, b) => a - b);
  return { p50: samples[15], p95: samples[28], bytes };
}
for (const old of before.results.filter(
  (r: { kind: string }) => r.kind === "source",
)) {
  const path = join(old.directory, "news.sqlite");
  const db = new Database(path, { readonly: true, fileMustExist: true });
  const explain = queryPlan(
    db,
    () =>
      newsWorkspacePage(path, {
        cutoff: newsFixtureCutoff,
        historical: true,
        query: old.query,
      }),
    [
      (newsFixtureCutoff - 7 * 86400000) / 1000,
      newsFixtureCutoff / 1000,
      "2025-01-07 16:00:00",
      ...(old.query ? [old.query, old.query] : []),
    ],
  );
  db.close();
  results.push({
    kind: old.kind,
    count: old.count,
    indexed: old.indexed,
    query: old.query,
    before: { p50: old.p50, p95: old.p95, bytes: old.bytes },
    after: measure(() =>
      newsWorkspacePage(path, {
        cutoff: newsFixtureCutoff,
        historical: true,
        query: old.query,
      }),
    ),
    databaseBytes: statSync(path).size,
    explain,
  });
}
for (const count of [121, 1000]) {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,updated_at INTEGER); CREATE INDEX records_kind ON records(kind,updated_at)",
  );
  seedNewsAnalyses(db, count);
  for (const filter of [
    {},
    { query: "半导体" },
    { status: "partial" as const },
  ]) {
    results.push({
      kind: "archives",
      count,
      filter,
      explain: queryPlan(
        db,
        () => newsArchivePage(db, filter),
        "query" in filter
          ? [filter.query!]
          : "status" in filter
            ? [filter.status!]
            : [],
      ),
      ...measure(() => newsArchivePage(db, filter)),
    });
  }
  db.close();
}
writeFileSync(
  join(logs, "sql-after.json"),
  JSON.stringify(
    {
      node: process.version,
      note: "Same retained readonly source fixtures; 5 warmups,30 samples; archives use identical seeded payloads and existing records_kind index. No external index changes.",
      results,
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results));
