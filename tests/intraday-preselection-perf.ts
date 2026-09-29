/** Isolated preselection SQL baseline; no app database or market connections. */
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { intradaySummaryIndexes } from "../src/server/db/migrations";
import { IntradayStore } from "../src/server/monitoring/intraday-store";
import { intradayHistory } from "../src/server/monitoring/intraday-history";
import type { IntradayObservation } from "../src/server/monitoring/intraday-store";

const db = new Database(":memory:");
db.exec(
  "CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,updated_at INTEGER); CREATE INDEX records_kind ON records(kind,updated_at)",
);
const store = new IntradayStore(db);
const insert = db.prepare("INSERT INTO records VALUES(?,?,?,?)");
const results: unknown[] = [];
const phase = process.env.INTRADAY_PHASE ?? "before";
if (phase === "indexed") db.exec(intradaySummaryIndexes);

for (const count of [100, 1000, 10000]) {
  const started = performance.now();
  const batchCount = count === 10000 ? 500 : 100;
  db.transaction(() => {
    db.exec("DELETE FROM records");
    for (let batch = 0; batch < batchCount; batch++)
      insert.run(
        `run-${batch}`,
        "intraday-run",
        JSON.stringify({
          id: `run-${batch}`,
          date: "2026-09-28",
          slot: batch % 2 ? "noon" : "late",
          status: "complete",
          startedAt: 1790565600000,
          config: {
            enabled: false,
            source: "tdx-local",
            pool: null,
            rpsPeriod: 50,
            minimumRps: 90,
            czscConfig: 0,
            noon: "11:20",
            late: "14:40",
          },
          pool: {
            rows: Array.from({ length: Math.ceil(count / batchCount) }, () => ({
              symbol: "sh600000",
              rps: 95,
            })),
          },
          results: [],
        }),
        1790565600000,
      );
    for (let i = 0; i < count; i++) {
      const value: IntradayObservation = {
        sessionId: `run-${i % batchCount}`,
        engineVersion: "fixture",
        rpsDate: "2026-09-25",
        rps: 95,
        poolHash: "fixture",
        observedAt: 1790565600000 + i,
        barCutoff: "2026-09-28T11:20:00+08:00",
        snapshotHash: `h-${i}`,
        snapshot: {
          symbol: "sh600000",
          source: "tdx-local",
          adjustment: "none",
          bars: Array.from({ length: 250 }, (_, n) => ({
            date: new Date(Date.UTC(2025, 0, 1 + n)).toISOString().slice(0, 10),
            open: 10,
            high: 12,
            low: 9,
            close: 11,
            volume: 1000,
            amount: 11000,
          })),
        },
        signals:
          i % 2
            ? []
            : [
                {
                  key: "buy",
                  strategy: "czsc",
                  endpointDate: "2026-09-28",
                  strategyVersion: "fixture",
                  evidence: "{}",
                },
              ],
      };
      insert.run(
        `p-${i}`,
        "intraday-preview",
        JSON.stringify(value),
        value.observedAt,
      );
      if (i % 3)
        insert.run(
          `c-${i}`,
          "intraday-close",
          JSON.stringify({
            observationId: `p-${i}`,
            close: {
              observedAt: value.observedAt + 1,
              signalKeys: i % 3 === 1 ? null : ["buy"],
              reason: i % 3 === 1 ? "missing" : null,
              snapshot: value.snapshot,
            },
            signals: [],
          }),
          value.observedAt + 1,
        );
    }
  })();
  const seedMs = performance.now() - started;
  const oldStatus = () => ({
    storage: store.usage(),
    rows: store.page().map((row) => ({
      ...row,
      value: {
        ...row.value,
        snapshot: { ...row.value.snapshot, bars: undefined },
      },
      attempts: row.attempts.map((a) => ({
        ...a,
        close: { ...a.close, snapshot: undefined },
      })),
    })),
  });
  const query = phase !== "before" ? () => intradayHistory(db, {}) : oldStatus;
  for (let i = 0; i < 5; i++) query();
  const samples: number[] = [];
  for (let i = 0; i < 30; i++) {
    const at = performance.now();
    query();
    samples.push(performance.now() - at);
  }
  samples.sort((a, b) => a - b);
  results.push({
    count,
    batchCount,
    seedMs,
    sqliteBytes:
      Number(db.pragma("page_count", { simple: true })) *
      Number(db.pragma("page_size", { simple: true })),
    p50: samples[14],
    p95: samples[28],
    bytes: Buffer.byteLength(JSON.stringify(query())),
    note:
      phase !== "before"
        ? "metadata history with full matching counts; excludes separate capacity and batch reads"
        : "legacy page+usage; excludes batch payload, lower bound for status",
  });
}
const dir = join(tmpdir(), "logs", "quant-intraday");
mkdirSync(dir, { recursive: true });
writeFileSync(
  join(dir, `sql-${phase}.json`),
  JSON.stringify(
    { cpu: cpus()[0]?.model, node: process.version, results },
    null,
    2,
  ),
);
console.log(JSON.stringify(results));
db.close();
