import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const read = (name) => JSON.parse(readFileSync(join(logs, name), "utf8"));
const recovery = read("q3-recovery-fixture.json");
const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const runtime = new Map([
  ["scheduler-owner", "lease"],
  ["security-directory", "security-directory"],
  [
    "snapshot-free-793fe070aa425b022a40f5e88eb10e3782ce930861f60351485a1c0200aa913a-auto",
    "snapshot",
  ],
]);
// Refuse while the task's HTTP services are reachable. Their owned PIDs are
// stopped by the caller first; this script never kills unrelated processes.
for (const port of [3230, 3231, 3232]) {
  assert.equal(
    await fetch(`http://127.0.0.1:${port}`).then(
      () => true,
      () => false,
    ),
    false,
    `port ${port} still active`,
  );
}
const results = [];
for (const [manifest, leaf, pressure] of [
  ["q0-fixture.json", "quant-cash-reconciliation-browser", false],
  ["q3-fixture.json", "quant-cash-reconciliation-pressure", true],
]) {
  const fixture = read(manifest);
  assert.equal(resolve(fixture.directory), resolve(join(tmpdir(), leaf)));
  const db = new Database(join(fixture.directory, "quant.sqlite"), {
    fileMustExist: true,
  });
  try {
    const result = db.transaction(() => {
      const readBase = () =>
        Object.fromEntries(
          ["import_batches", "trade_fills", "cash_flows", "records"].map(
            (table) => [
              table,
              table === "records"
                ? db
                    .prepare(
                      "SELECT * FROM records WHERE id='settings' ORDER BY id",
                    )
                    .all()
                : pressure
                  ? db
                      .prepare(
                        `SELECT * FROM ${table} WHERE account<>? ORDER BY id`,
                      )
                      .all(recovery.account)
                  : db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
            ],
          ),
        );
      assert.equal(hash(readBase()), fixture.hash);
      const extra = db
        .prepare("SELECT id,kind FROM records WHERE id<>'settings' ORDER BY id")
        .all();
      for (const record of extra)
        assert.equal(
          runtime.get(record.id),
          record.kind,
          `unowned runtime record ${record.id}`,
        );
      let removedRecovery = 0;
      if (pressure) {
        const ownFacts = Object.fromEntries(
          ["import_batches", "trade_fills", "cash_flows"].map((table) => [
            table,
            db
              .prepare(`SELECT * FROM ${table} WHERE account=? ORDER BY id`)
              .all(recovery.account),
          ]),
        );
        if (ownFacts.import_batches.length) {
          assert.equal(hash(ownFacts), recovery.hash);
          assert.equal(ownFacts.import_batches.length, 2);
          assert.equal(ownFacts.cash_flows.length, 40);
          for (const table of ["cash_flows", "trade_fills", "import_batches"])
            removedRecovery += db
              .prepare(`DELETE FROM ${table} WHERE account=?`)
              .run(recovery.account).changes;
        } else
          for (const rows of Object.values(ownFacts))
            assert.equal(rows.length, 0);
      }
      for (const record of extra)
        db.prepare("DELETE FROM records WHERE id=? AND kind=?").run(
          record.id,
          record.kind,
        );
      const finalFacts = Object.fromEntries(
        ["import_batches", "trade_fills", "cash_flows", "records"].map(
          (table) => [
            table,
            db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
          ],
        ),
      );
      assert.equal(hash(finalFacts), fixture.hash);
      return {
        directory: fixture.directory,
        hash: hash(finalFacts),
        removedRuntime: extra,
        removedRecovery,
        counts: Object.fromEntries(
          Object.entries(finalFacts).map(([table, rows]) => [
            table,
            rows.length,
          ]),
        ),
      };
    })();
    results.push(result);
  } finally {
    db.close();
  }
}
writeFileSync(
  join(logs, "final-cleanup.json"),
  JSON.stringify({ results, checkedAt: new Date().toISOString() }, null, 2),
);
console.log(JSON.stringify(results));
