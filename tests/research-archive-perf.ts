/** Run with a fresh isolated QUANT_DATA_DIR and ARCHIVE_PHASE=before/after. */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { sqlite } from "../src/server/db";
import { reportHistory } from "../src/server/research/report-history";
import { researchHistory } from "../src/server/research/research-history";

assert.ok(process.env.QUANT_DATA_DIR);
assert.ok(
  resolve(process.env.QUANT_DATA_DIR!).startsWith(
    resolve(tmpdir()) + "\\quant-research-archive-",
  ),
);
const db = sqlite();
assert.equal(
  (db.prepare("SELECT count(*) n FROM records").get() as { n: number }).n,
  0,
);
const phase = process.env.ARCHIVE_PHASE ?? "before";
const kinds = ["report", "chan-report", "canslim-report", "wyckoff-report"];
const insert = db.prepare(
  "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,?,?,?)",
);
const results: unknown[] = [];
let archiveExplain: unknown[] = [];
for (const count of [1000, 10000]) {
  db.transaction(() => {
    db.prepare("DELETE FROM records").run();
    insert.run(
      "source",
      "snapshot",
      JSON.stringify({ symbol: "sh600519", name: "归档名称" }),
      1,
    );
    for (let i = 0; i < count; i++) {
      const kind = kinds[i % 4]!;
      const id = `${kind}-${i.toString(16).padStart(64, "0")}`;
      const createdAt = Date.parse("2026-09-28T04:00:00Z") + Math.floor(i / 8);
      const payload = {
        id,
        createdAt,
        contextId: "source",
        title: `研究 ${i}`,
        result: { title: `研究 ${i}` },
        model: "fixture",
        evidence: { symbol: "sh600519" },
        dossier: { symbol: "sh600519" },
        frames: { symbol: "sh600519" },
        raw: i < 4 ? "x".repeat(1_000_000) : "fixture",
      };
      insert.run(id, kind, JSON.stringify(payload), createdAt);
    }
  })();
  const cases: Record<string, () => unknown> = {
    general: () => reportHistory({}),
    method: () => researchHistory("chan-report"),
  };
  if (phase === "after") {
    const modulePath = "../src/server/research/archive-history";
    const { researchArchiveHistory } = await import(modulePath);
    cases.unified = () => researchArchiveHistory({});
    cases.filtered = () =>
      researchArchiveHistory({ symbol: "sh600519", keyword: "研究" });
    // Inspect the actual generated statement outside the timed samples.
    const prepare = db.prepare;
    db.prepare = ((sql: string) => {
      const statement = prepare.call(db, sql);
      if (sql.startsWith("WITH source")) {
        const all = statement.all.bind(statement);
        statement.all = (...parameters: unknown[]) => {
          const explainStatement = prepare.call(
            db,
            `EXPLAIN QUERY PLAN ${sql}`,
          );
          archiveExplain = Reflect.apply(
            explainStatement.all,
            explainStatement,
            parameters,
          );
          return Reflect.apply(all, statement, parameters);
        };
      }
      return statement;
    }) as typeof db.prepare;
    try {
      cases.filtered();
    } finally {
      db.prepare = prepare;
    }
  }
  for (const [name, run] of Object.entries(cases)) {
    for (let i = 0; i < 5; i++) run();
    const samples: number[] = [];
    let bytes = 0;
    for (let i = 0; i < 30; i++) {
      const start = performance.now();
      const result = run();
      samples.push(performance.now() - start);
      bytes = Buffer.byteLength(JSON.stringify(result));
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
    "EXPLAIN QUERY PLAN SELECT id FROM records WHERE kind='report' ORDER BY json_extract(payload,'$.createdAt') DESC,id DESC LIMIT 21",
  )
  .all();
const dir = join(tmpdir(), "logs", "quant-research-archive");
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, `sql-${phase}.json`),
  JSON.stringify({ phase, results, explain, archiveExplain }, null, 2),
);
console.log(
  JSON.stringify({
    phase,
    results: results.map(({ samples, ...value }: any) => value),
    explain,
    archiveExplain,
  }),
);
db.close();
