import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const fixture = JSON.parse(readFileSync(join(logs, "q0-fixture.json"), "utf8"));
const directory = resolve(fixture.directory);
const child = relative(resolve(tmpdir()), directory);
assert.ok(
  !isAbsolute(child) &&
    !child.startsWith("..") &&
    child.startsWith("quant-cash-reconciliation-"),
);
const db = new Database(join(directory, "quant.sqlite"), {
  readonly: true,
  fileMustExist: true,
});
try {
  const facts = Object.fromEntries(
    ["import_batches", "trade_fills", "cash_flows", "records"].map((table) => [
      table,
      db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(),
    ]),
  );
  const runtimeRecords = facts.records.filter((row) => row.id !== "settings");
  for (const row of runtimeRecords)
    assert.ok(
      ["lease", "security-directory", "snapshot"].includes(row.kind),
      `unexpected runtime write: ${row.id}`,
    );
  // The production shell writes its scheduler lease and market caches. Account
  // facts and the exact initial settings are the immutable cash-read boundary.
  const accountFacts = {
    ...facts,
    records: facts.records.filter((row) => row.id === "settings"),
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(accountFacts))
    .digest("hex");
  assert.equal(
    hash,
    fixture.hash,
    "cash reading must not write or balance account facts",
  );
  const result = {
    hash,
    counts: Object.fromEntries(
      Object.entries(facts).map(([table, rows]) => [table, rows.length]),
    ),
    runtimeRecords: runtimeRecords.map((row) => ({
      id: row.id,
      kind: row.kind,
    })),
    checkedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(logs, "fixture-audit.json"),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
