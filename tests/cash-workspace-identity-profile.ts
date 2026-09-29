import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cashReviewInputIdentity } from "../src/server/portfolio/cash-reconciliation-workspace";
const directory = resolve(process.env.QUANT_DATA_DIR ?? "");
assert.equal(
  directory,
  resolve(join(tmpdir(), "quant-cash-reconciliation-pressure")),
);
const db = new Database(join(directory, "quant.sqlite"), {
  fileMustExist: true,
});
const config = JSON.parse(
  (
    db.prepare("SELECT payload FROM records WHERE id='settings'").get() as {
      payload: string;
    }
  ).payload,
);
const logs = join(tmpdir(), "logs/quant-cash-reconciliation");
const name = process.argv[2];
assert.ok(name === "before" || name === "after");
assert.equal(
  db.prepare("SELECT id FROM records WHERE id='cash-identity-profile'").get(),
  undefined,
);
const times: number[] = [];
try {
  const expected = cashReviewInputIdentity(db, "现金大证据", config);
  for (let i = 0; i < 10; i++) {
    db.prepare(
      "INSERT OR REPLACE INTO records VALUES('cash-identity-profile','test',?,1)",
    ).run(String(i));
    const start = performance.now();
    assert.equal(cashReviewInputIdentity(db, "现金大证据", config), expected);
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const result = {
    phase: name,
    n: times.length,
    p50: times[4],
    max: times.at(-1),
    fixture:
      "20 dates, 400000 retained rows, unrelated records write before each identity read",
  };
  writeFileSync(
    join(logs, `q3-identity-${name}.json`),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  db.prepare("DELETE FROM records WHERE id='cash-identity-profile'").run();
  db.close();
}
