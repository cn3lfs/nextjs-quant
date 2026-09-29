import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { clsFixtureReport } from "./helpers/cls-review-fixture";
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-cls-review-"));
const backup = join(tmpdir(), "logs/quant-cls-review/stress-backup.json");
const db = new Database(join(directory, "quant.sqlite"));
db.pragma("busy_timeout=5000");
type Row = { id: string; kind: string; payload: string; updated_at: number };
try {
  const insert = db.prepare("INSERT INTO records VALUES(?,?,?,?)");
  if (process.argv.includes("--restore")) {
    const rows = JSON.parse(readFileSync(backup, "utf8")) as Row[];
    db.transaction(() => {
      db.prepare(
        "DELETE FROM records WHERE id LIKE 'cls-review-stress:%'",
      ).run();
      const update = db.prepare(
        "UPDATE records SET payload=?,updated_at=? WHERE id=? AND kind=?",
      );
      for (const row of rows)
        update.run(row.payload, row.updated_at, row.id, row.kind);
    })();
    console.log("Restored stress fixture changes; retained backup for audit");
  } else {
    const existingStress = db.prepare("SELECT count(*) count FROM records WHERE id LIKE 'cls-review-stress:%'").get() as { count: number };
    assert.equal(existingStress.count, 0, "Restore the previous stress fixture first");
    const rows = db
      .prepare("SELECT * FROM records WHERE kind='cls-review-verification'")
      .all() as Row[];
    if (existsSync(backup)) assert.deepEqual(rows, JSON.parse(readFileSync(backup, "utf8")), "Existing backup must match restored verification records");
    else writeFileSync(backup, JSON.stringify(rows));
    const claims = Array.from(
      { length: 10000 },
      (_, i) => `合成事实${String(i).padStart(5, "0")}。`,
    ).join("\n");
    const body =
      claims +
      "\n" +
      "大正文。".repeat(
        Math.floor((2 * 1024 * 1024 - 512 - Buffer.byteLength(claims)) / 12),
      );
    db.transaction(() => {
      for (let i = 0; i < 20; i++) {
        const report = clsFixtureReport(2000 + i, body);
        report.id = `cls-review-stress:report-${i}`;
        report.importedAt = Date.parse("2026-09-20T08:00:00+08:00") + i;
        insert.run(
          report.id,
          "cls-review-report",
          JSON.stringify(report),
          report.importedAt,
        );
        if (i === 0) {
          for (let f = 0; f < 10000; f++) {
            const fact = {
              id: `cls-review-stress:fact-${f}`,
              reportId: report.id,
              sectionId: report.report.sections[0]!.id,
              quote: `合成事实${String(f).padStart(5, "0")}。`,
              evidence: "合成证据。".repeat(80),
              verdict: f % 2 ? "supported" : "unresolved",
              reviewedAt: f,
            };
            insert.run(fact.id, "cls-review-fact", JSON.stringify(fact), f);
          }
        }
      }
      const update = db.prepare("UPDATE records SET payload=? WHERE id=?");
      for (const row of rows) {
        const value = JSON.parse(row.payload);
        const bars = Array.from({ length: 12 }, (_, i) => ({
          date: new Date(Date.parse(value.date) + i * 86400000)
            .toISOString()
            .slice(0, 10),
          open: 10,
          high: 12,
          low: 9,
          close: 11,
          volume: 1000,
          amount: 11000,
        }));
        value.bars = bars;
        value.benchmark = bars;
        value.calendar = bars.map((bar) => bar.date);
        update.run(JSON.stringify(value), row.id);
      }
    })();
    const size = db
      .prepare(
        "SELECT SUM(length(CAST(payload AS BLOB))) bytes FROM records WHERE kind LIKE 'cls-review-%'",
      )
      .get() as { bytes: number };
    assert.ok(size.bytes < 256 * 1024 * 1024);
    writeFileSync(
      join(tmpdir(), "logs/quant-cls-review/stress-size.json"),
      JSON.stringify(
        {
          reports: 1020,
          largeReports: 20,
          largeSourceBytes: Buffer.byteLength(body),
          facts: 20000,
          verifications: rows.length,
          bytes: size.bytes,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify(size));
  }
} finally {
  db.close();
}
