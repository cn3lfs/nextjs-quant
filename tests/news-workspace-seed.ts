import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { migrate } from "../src/server/db/migrations";
import {
  seedNewsSource,
  seedNewsAnalyses,
} from "./helpers/news-workspace-fixture";
const dir = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(dir.startsWith(resolve(tmpdir()) + "\\quant-news-"));
mkdirSync(dir, { recursive: true });
const db = new Database(join(dir, "quant.sqlite"));
try {
  migrate(db);
  assert.equal(
    (db.prepare("SELECT count(*) n FROM records").get() as { n: number }).n,
    0,
  );
  const sourcePath = join(dir, "news.sqlite");
  const source = new Database(sourcePath);
  try {
    seedNewsSource(source, 10000, true);
  } finally {
    source.close();
  }
  seedNewsAnalyses(db, 121);
  const put = db.prepare("INSERT INTO records VALUES(?,?,?,?)");
  put.run(
    "settings",
    "settings",
    JSON.stringify({
      tdxRoot: "Z:\\quant-fixture-unavailable",
      clsDbPath: sourcePath,
      autoNewsAnalysis: false,
    }),
    1,
  );
  put.run(
    "intraday-config",
    "intraday-config",
    JSON.stringify({
      enabled: false,
      source: "tdx-local",
      pool: null,
      rpsPeriod: 50,
      minimumRps: 90,
      czscConfig: 0,
      noon: "11:20",
      late: "14:40",
    }),
    1,
  );
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  db.prepare("INSERT INTO signal_ledger_runs VALUES(?,?)").run(
    today,
    JSON.stringify({
      date: today,
      status: "cancelled",
      total: 0,
      scanned: 0,
      signals: 0,
      elapsedMs: 0,
      errors: [],
      calendarSource: "fixture",
      phase: "隔离验证",
    }),
  );
} finally {
  db.close();
}
