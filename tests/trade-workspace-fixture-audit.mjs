import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { migrate } from "../src/server/db/migrations.ts";
import { seedTradeWorkspace } from "./helpers/trade-workspace-fixture.ts";
const db = new Database(join(tmpdir(), "quant-trade-ledger-s0b/quant.sqlite"), {
  readonly: true,
});
const expected = new Database(":memory:"),
  results = [];
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
try {
  migrate(expected);
  const fixture = seedTradeWorkspace(expected);
  for (const table of [
    "trade_ledger",
    "trade_adjustments",
    "signal_ledger",
    "signal_ledger_outcomes",
    "signal_ledger_runs",
  ]) {
    const actual = db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
      original = expected.prepare(`SELECT * FROM ${table} ORDER BY 1`).all();
    assert.equal(
      hash(actual),
      hash(original),
      table + " fixture facts restored",
    );
    results.push({ table, count: actual.length, hash: hash(actual) });
  }
  for (const row of expected
    .prepare("SELECT * FROM records WHERE id!='settings' ORDER BY id")
    .all())
    assert.deepEqual(
      db.prepare("SELECT * FROM records WHERE id=?").get(row.id),
      row,
    );
  const settings = JSON.parse(
    db.prepare("SELECT payload FROM records WHERE id='settings'").get().payload,
  );
  assert.deepEqual(settings, {
    tdxRoot: join(tmpdir(), "quant-trade-ledger-s0b/synthetic-tdx"),
    calendar: fixture.calendar,
  });
  const unexpected = db
    .prepare(
      "SELECT id,kind FROM records WHERE id NOT IN ('settings','intraday-config','scheduler-owner') AND kind!='notification-decision'",
    )
    .all();
  // The baseline app can populate market read caches. Their writers are
  // market/securities.ts and market/free-chart-sources.ts, not ledger mutations.
  // Preserve and report exactly those observed cache identities, not all kinds.
  const derivedReadCaches = unexpected.filter(
    (row) =>
      (row.id === "security-directory" && row.kind === "security-directory") ||
      (row.id ===
        "snapshot-free-463c80567b97c868f8bb1f15f270399fd74aa8245ce6f7ae921b94c693f15a59-auto" &&
        row.kind === "snapshot"),
  );
  const residue = unexpected.filter((row) => !derivedReadCaches.includes(row));
  assert.deepEqual(
    residue,
    [],
    "no test stops, bonus receipts, mock configuration or previews remain",
  );
  const emptyTables = ["trade_fills", "cash_flows", "import_batches"].map(
    (table) => ({
      table,
      count: db.prepare(`SELECT count(*) n FROM ${table}`).get().n,
    }),
  );
  for (const row of emptyTables) assert.equal(row.count, 0, row.table);
  const result = {
    results,
    settingsRestored: true,
    testRecordResidue: residue,
    preservedDerivedReadCaches: derivedReadCaches,
    emptyTables,
  };
  writeFileSync(
    join(tmpdir(), "logs/quant-trade-ledger/final-fixture-audit.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(result);
} finally {
  expected.close();
  db.close();
}
