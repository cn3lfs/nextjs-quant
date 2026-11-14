/** Real local tRPC measurements. Restores isolated fixture records in finally. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import SuperJSON from "superjson";
const Database = createRequire(import.meta.url)("better-sqlite3");
const data = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.ok(data.startsWith(resolve(tmpdir()) + "\\quant-intraday-"));
const base = process.env.BASE ?? "http://127.0.0.1:3221";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
const db = new Database(join(data, "quant.sqlite"));
db.pragma("busy_timeout=5000");
assert.equal(db.pragma("user_version", { simple: true }), 11);
const backup = db
  .prepare("SELECT * FROM records WHERE kind LIKE 'intraday-%'")
  .all();
const insert = db.prepare("INSERT OR REPLACE INTO records VALUES(?,?,?,?)");
const results = [];
const bars = Array.from({ length: 250 }, (_, n) => ({
  date: new Date(Date.UTC(2025, 0, 1 + n)).toISOString().slice(0, 10),
  open: 10,
  high: 12,
  low: 9,
  close: 11,
  volume: 1000,
  amount: 11000,
}));
async function request(input) {
  const response = await fetch(
    `${base}/api/trpc/intradayHistory?input=${encodeURIComponent(SuperJSON.stringify(input))}`,
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
    value: SuperJSON.deserialize(JSON.parse(text).result.data),
    bytes: Buffer.byteLength(text),
  };
}
try {
  for (const count of [1000, 10000]) {
    db.transaction(() => {
      db.prepare(
        "DELETE FROM records WHERE kind IN ('intraday-preview','intraday-close','intraday-run')",
      ).run();
      const batchCount = count === 10000 ? 500 : 100;
      for (let j = 0; j < batchCount; j++)
        insert.run(
          `run-${j}`,
          "intraday-run",
          JSON.stringify({
            slot: j % 2 ? "noon" : "late",
            date: "2026-09-28",
            status: "complete",
            startedAt: 1790565600000,
            results: [],
          }),
          1790565600000,
        );
      for (let i = 0; i < count; i++) {
        const id = "intraday-preview:" + i.toString(16).padStart(64, "0");
        const snapshot = {
          symbol: "sh600000",
          source: "tdx-local",
          adjustment: "none",
          bars,
        };
        insert.run(
          id,
          "intraday-preview",
          JSON.stringify({
            sessionId: `run-${i % batchCount}`,
            snapshot,
            barCutoff: "2026-09-28T11:20:00+08:00",
            observedAt: 1790565600000 + i,
            rps: 95,
            rpsDate: "2026-09-25",
            signals:
              i % 2
                ? []
                : [
                    {
                      key: "buy",
                      strategy: "czsc",
                      strategyVersion: "fixture",
                      evidence: "{}",
                    },
                  ],
          }),
          1790565600000 + i,
        );
        if (i % 3)
          insert.run(
            `c-${i}`,
            "intraday-close",
            JSON.stringify({
              observationId: id,
              close: {
                signalKeys: i % 3 === 1 ? null : ["buy"],
                snapshot,
                reason: i % 3 === 1 ? "missing" : null,
              },
              signals: [],
            }),
            1790565600001 + i,
          );
      }
    })();
    const first = await request({});
    assert.equal(first.value.total, count);
    for (const [name, input, total] of [
      ["all", {}, count],
      ["filtered", { signalsOnly: true, slot: "late" }, count / 2],
      ["page2", { cursor: first.value.nextCursor }, count],
    ]) {
      const samples = [];
      let bytes = 0;
      for (let i = 0; i < 35; i++) {
        const at = performance.now();
        const response = await request(input);
        const elapsed = performance.now() - at;
        assert.equal(response.value.total, total);
        assert.equal(response.value.rows.length, 20);
        assert.ok(!JSON.stringify(response.value).includes('"bars"'));
        if (i >= 5) samples.push(elapsed);
        bytes = response.bytes;
      }
      samples.sort((a, b) => a - b);
      results.push({ count, name, p50: samples[14], p95: samples[28], bytes });
    }
  }
  writeFileSync(
    join(tmpdir(), "logs", "quant-intraday", "http-performance.json"),
    JSON.stringify({ results }, null, 2),
  );
  console.log(JSON.stringify(results));
} finally {
  db.transaction(() => {
    db.prepare("DELETE FROM records WHERE kind LIKE 'intraday-%'").run();
    for (const row of backup)
      insert.run(row.id, row.kind, row.payload, row.updated_at);
  })();
  db.close();
}
