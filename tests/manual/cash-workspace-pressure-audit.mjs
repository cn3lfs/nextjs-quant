import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(readFileSync(join(logs, "q3-fixture.json"), "utf8"));
const recovery = JSON.parse(
  readFileSync(join(logs, "q3-recovery-fixture.json"), "utf8"),
);
assert.equal(
  resolve(fixture.directory),
  resolve(join(tmpdir(), "quant-cash-reconciliation-pressure")),
);
const db = new Database(join(fixture.directory, "quant.sqlite"), {
  readonly: true,
  fileMustExist: true,
});
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
try {
  const facts = Object.fromEntries(
    ["import_batches", "trade_fills", "cash_flows", "records"].map((table) => [
      table,
      table === "records"
        ? db
            .prepare("SELECT * FROM records WHERE id='settings' ORDER BY id")
            .all()
        : db
            .prepare(`SELECT * FROM ${table} WHERE account<>? ORDER BY id`)
            .all(recovery.account),
    ]),
  );
  assert.equal(hash(facts), fixture.hash);
  const recoveryFacts = Object.fromEntries(
    ["import_batches", "trade_fills", "cash_flows"].map((table) => [
      table,
      db
        .prepare(`SELECT * FROM ${table} WHERE account=? ORDER BY id`)
        .all(recovery.account),
    ]),
  );
  const restored = recoveryFacts.import_batches.length > 0;
  if (restored) assert.equal(hash(recoveryFacts), recovery.hash);
  else
    for (const rows of Object.values(recoveryFacts))
      assert.equal(rows.length, 0);
  const runtime = db
    .prepare("SELECT id,kind FROM records WHERE id<>'settings' ORDER BY id")
    .all();
  for (const row of runtime)
    assert.ok(
      ["lease", "security-directory", "snapshot"].includes(row.kind),
      `unexpected runtime record: ${row.id}`,
    );
  const result = {
    fixtureHash: hash(facts),
    counts: Object.fromEntries(
      Object.entries(facts).map(([table, rows]) => [table, rows.length]),
    ),
    recoveryRestored: restored,
    recoveryHash: restored ? hash(recoveryFacts) : null,
    runtimeRecords: runtime,
    checkedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(logs, "q3-fixture-audit.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
