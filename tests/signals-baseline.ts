import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/server/db/migrations";
import { seedSignals } from "./helpers/signals-fixture";
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-signals-"));
mkdirSync(directory, { recursive: true });
const db = new Database(join(directory, "quant.sqlite"));
try {
  migrate(db);
  assert.equal(
    (db.prepare("SELECT count(*) n FROM records").get() as { n: number }).n,
    0,
    "Use a fresh isolated directory",
  );
  seedSignals(db);
  db.prepare("INSERT INTO records VALUES('settings','settings',?,1)").run(
    JSON.stringify({
      tdxRoot: join(directory, "no-market"),
      clsDbPath: join(directory, "no-news.sqlite"),
      autoAnalysis: false,
      autoNewsAnalysis: false,
      outboundProxy: "",
    }),
  );
  const measurement = [];
  for (const [kind, limit] of [
    ["monitor", 200],
    ["signal", 100],
    ["delivery", 200],
  ] as const) {
    const q = db.prepare(
      "SELECT payload FROM records WHERE kind=? ORDER BY updated_at DESC LIMIT ?",
    );
    const times = [];
    let result: unknown[] = [];
    for (let i = 0; i < 35; i++) {
      const start = performance.now();
      result = (q.all(kind, limit) as { payload: string }[]).map((r) =>
        JSON.parse(r.payload),
      );
      if (i >= 5) times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    measurement.push({
      kind,
      returned: result.length,
      total: (
        db.prepare("SELECT count(*) n FROM records WHERE kind=?").get(kind) as {
          n: number;
        }
      ).n,
      p95: times[28],
      bytes: Buffer.byteLength(JSON.stringify(result)),
    });
  }
  const result = {
    measurement,
    totalPayloadBytes: db
      .prepare("SELECT sum(length(CAST(payload AS BLOB))) bytes FROM records")
      .get(),
    fixture: {
      monitors: 1000,
      signals: 10000,
      deliveries: 50000,
      enabledMonitors: 0,
      enabledChannels: 0,
    },
    node: process.version,
  };
  writeFileSync(
    join(tmpdir(), "logs/quant-signals/sql-before.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
