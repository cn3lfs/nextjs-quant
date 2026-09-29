/** Baseline current UI query path, not model latency; isolated source files only. */
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readClsNews } from "../src/server/data-sources/cls/cls-news";
import type { NewsAnalysis } from "../src/server/news/news-analysis";
import {
  seedNewsSource,
  seedNewsAnalyses,
  newsFixtureCutoff,
  newsFixtureContent,
} from "./helpers/news-workspace-fixture";

const logs = join(tmpdir(), "logs", "quant-news");
mkdirSync(logs, { recursive: true });
const results = [];
for (const indexed of [false, true])
  for (const count of [100, 1000, 10000]) {
    const directory = mkdtempSync(join(tmpdir(), "quant-news-baseline-")),
      file = join(directory, "news.sqlite");
    const source = new Database(file);
    seedNewsSource(source, count, indexed);
    source.close();
    for (const query of ["", "末尾关键词"]) {
      const samples = [];
      let bytes = 0;
      for (let i = 0; i < 35; i++) {
        const start = performance.now();
        const response = readClsNews(file, {
          cutoff: newsFixtureCutoff,
          historical: true,
          query,
        });
        const elapsed = performance.now() - start;
        if (i >= 5) samples.push(elapsed);
        bytes = Buffer.byteLength(JSON.stringify(response));
      }
      samples.sort((a, b) => a - b);
      results.push({
        kind: "source",
        indexed,
        count,
        query,
        p50: samples[15],
        p95: samples[28],
        bytes,
        directory,
      });
    }
  }
for (const count of [121, 1000]) {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,updated_at INTEGER); CREATE INDEX records_kind ON records(kind,updated_at)",
  );
  seedNewsAnalyses(db, count);
  const samples = [];
  let bytes = 0;
  let visible = 0;
  for (let i = 0; i < 35; i++) {
    const start = performance.now();
    const seen = new Set<string>();
    // Mirrors the existing newsAnalyses endpoint: limit full payloads, deduplicate, then project.
    const result = (
      db
        .prepare(
          "SELECT payload FROM records WHERE kind=? ORDER BY updated_at DESC LIMIT 50",
        )
        .all("news-analysis") as { payload: string }[]
    )
      .map((row) => JSON.parse(row.payload) as NewsAnalysis)
      .filter((record) => {
        const key = JSON.stringify({
          news: record.news.map((n) => n.hash),
          method: record.method,
          model: record.model,
        });
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ id, createdAt, model, news, input }) => ({
        id,
        createdAt,
        model,
        count: news.length,
        query: input.query,
      }));
    const elapsed = performance.now() - start;
    if (i >= 5) samples.push(elapsed);
    bytes = Buffer.byteLength(JSON.stringify(result));
    visible = result.length;
  }
  samples.sort((a, b) => a - b);
  results.push({
    kind: "archives",
    count,
    p50: samples[15],
    p95: samples[28],
    bytes,
    visible,
  });
  db.close();
}
writeFileSync(
  join(logs, "sql-before.json"),
  JSON.stringify(
    {
      node: process.version,
      bodyBytes: Buffer.byteLength(newsFixtureContent),
      results,
      note: "5 warmups,30 samples; source read includes readonly open/count/full 50 rows/hash; archives mirrors current endpoint not HTTP; temporary source files retained for paired comparison",
    },
    null,
    2,
  ),
);
console.log(JSON.stringify(results));
