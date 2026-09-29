import Database from "better-sqlite3";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrate } from "../src/server/db/migrations";
import { seedLedger } from "./helpers/signal-ledger-fixture";
import { ledgerHistory } from "../src/server/monitoring/signal-ledger-query";
let capture = false;
const statements = new Set<string>();
const db = new Database(":memory:", {
  verbose: (statement) => {
    if (
      capture &&
      typeof statement === "string" &&
      statement.trimStart().startsWith("SELECT")
    )
      statements.add(statement);
  },
});
try {
  migrate(db);
  seedLedger(db, 10000);
  capture = true;
  ledgerHistory(db, {});
  ledgerHistory(db, { state: "blank" });
  capture = false;
  const plans = [...statements].map((sql) => ({
    sql,
    plan: db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(),
  }));
  const payload = db
    .prepare("SELECT payload FROM signal_ledger LIMIT 1")
    .get() as { payload: string };
  const evidenceBytes = Buffer.byteLength(JSON.parse(payload.payload).evidence);
  const bytes =
    Number(db.pragma("page_count", { simple: true })) *
    Number(db.pragma("page_size", { simple: true }));
  writeFileSync(
    join(tmpdir(), "logs", "quant-signal-ledger", "query-plans.json"),
    JSON.stringify(
      {
        sqlite: db.prepare("SELECT sqlite_version() AS version").get(),
        evidenceBytes,
        bytes,
        plans,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
