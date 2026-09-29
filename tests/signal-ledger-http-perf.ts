import Database from "better-sqlite3";
import SuperJSON from "superjson";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { seedLedger } from "./helpers/signal-ledger-fixture";
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-signal-ledger-"));
const base = process.env.BASE ?? "http://127.0.0.1:3222";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const db = new Database(join(directory, "quant.sqlite"));
db.pragma("busy_timeout=5000");
const tables = [
  "signal_ledger_outcomes",
  "signal_ledger",
  "signal_ledger_runs",
  "records",
] as const;
const backup = new Map(
  tables.map((table) => [
    table,
    db.prepare(`SELECT * FROM ${table}`).all() as Record<
      string,
      string | number | null
    >[],
  ]),
);
const results = [];
async function request(procedure: string, input: unknown) {
  const response = await fetch(
    `${base}/api/trpc/${procedure}?input=${encodeURIComponent(SuperJSON.stringify(input))}`,
    {
      headers: {
        "x-quant-client": "workbench",
        origin: base,
        connection: "close",
      },
    },
  );
  assert.equal(response.status, 200);
  const text = await response.text();
  return {
    value: SuperJSON.deserialize(JSON.parse(text).result.data) as {
      nextCursor: unknown;
      total: number;
    },
    bytes: Buffer.byteLength(text),
  };
}
try {
  for (const count of [1000, 10000]) {
    db.transaction(() => {
      for (const table of tables) db.prepare(`DELETE FROM ${table}`).run();
      seedLedger(db, count);
    })();
    const first = await request("ledgerHistory", {});
    assert.equal(first.value.total, count);
    for (const [name, procedure, input] of [
      ["all", "ledgerHistory", {}],
      ["filtered", "ledgerHistory", { state: "blank" }],
      ["page2", "ledgerHistory", { cursor: first.value.nextCursor }],
      ["analysis", "ledgerAnalysis", undefined],
    ] as const) {
      const samples: number[] = [];
      let bytes = 0;
      for (let i = 0; i < 35; i++) {
        const start = performance.now();
        const response = await request(procedure, input);
        const ms = performance.now() - start;
        if (i >= 5) samples.push(ms);
        bytes = response.bytes;
      }
      samples.sort((a, b) => a - b);
      results.push({ count, name, p50: samples[15], p95: samples[28], bytes });
    }
  }
  writeFileSync(
    join(tmpdir(), "logs", "quant-signal-ledger", "http-performance.json"),
    JSON.stringify({ results }, null, 2),
  );
} finally {
  db.transaction(() => {
    for (const table of tables) db.prepare(`DELETE FROM ${table}`).run();
    for (const table of [
      "signal_ledger",
      "signal_ledger_outcomes",
      "signal_ledger_runs",
      "records",
    ] as const) {
      for (const row of backup.get(table)!) {
        const keys = Object.keys(row);
        db.prepare(
          `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
        ).run(...keys.map((key) => row[key]));
      }
    }
  })();
  db.close();
}
