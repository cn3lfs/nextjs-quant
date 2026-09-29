import Database from "better-sqlite3";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
import { migrate } from "../src/server/db/migrations";
import { SignalLedgerStore } from "../src/server/monitoring/signal-ledger-store";
import { aggregateLedger } from "../src/lib/strategy-facts/signal-ledger";
import { signalInformation } from "../src/lib/strategy-facts/signal-information";
import { seedLedger } from "./helpers/signal-ledger-fixture";
import {
  ledgerHistory,
  ledgerAnalysis,
  ledgerDetail,
} from "../src/server/monitoring/signal-ledger-query";

const logs = join(tmpdir(), "logs", "quant-signal-ledger");
mkdirSync(logs, { recursive: true });
if (process.env.LEDGER_SEED === "1") {
  const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
  assert.ok(directory.startsWith(resolve(tmpdir()) + "\\quant-signal-ledger-"));
  mkdirSync(directory, { recursive: true });
  const db = new Database(join(directory, "quant.sqlite"));
  try {
    migrate(db);
    assert.equal(
      (
        db.prepare("SELECT count(*) AS n FROM signal_ledger").get() as {
          n: number;
        }
      ).n,
      0,
    );
    seedLedger(db, 121);
  } finally {
    db.close();
  }
} else {
  const phase = process.env.LEDGER_PHASE ?? "before";
  const results = [];
  for (const count of [100, 1000, 10000]) {
    const db = new Database(":memory:");
    try {
      migrate(db);
      seedLedger(db, count);
      const store = new SignalLedgerStore(db);
      const samples: number[] = [];
      let bytes = 0;
      for (let i = 0; i < 35; i++) {
        const start = performance.now();
        let response: unknown;
        if (phase === "after") response = ledgerHistory(db, {});
        else if (phase === "analysis") response = ledgerAnalysis(db);
        else if (phase === "detail")
          response = ledgerDetail(db, "fixture:000000");
        else {
          const rows = store.rows();
          response = {
            rows: rows.slice(0, 100),
            groups: aggregateLedger(rows),
            information: signalInformation(rows),
            runs: store.runs(),
          };
        }
        const ms = performance.now() - start;
        if (i >= 5) samples.push(ms);
        if (i === 34) bytes = Buffer.byteLength(JSON.stringify(response));
      }
      samples.sort((a, b) => a - b);
      const result = { count, p50: samples[15], p95: samples[28], bytes };
      results.push(result);
      console.log(JSON.stringify(result));
    } finally {
      db.close();
    }
  }
  writeFileSync(
    join(logs, `sql-${phase}.json`),
    JSON.stringify(
      {
        results,
        note:
          phase === "before"
            ? "old rows+aggregate+information+runs, excludes duplicate page notifications read; bytes are JSON equivalent, not RSC wire bytes"
            : phase === "after"
              ? "metadata history and whole-filter counts; analytics separate"
              : phase === "detail"
                ? "single full-evidence detail and exact notification association"
                : "full-population analytics without raw signal evidence",
      },
      null,
      2,
    ),
  );
}
