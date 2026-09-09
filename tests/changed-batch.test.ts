import { expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomic, get, put, remove, putChangedBatch, sqlite } from "~/server/db";
import Database from "better-sqlite3";
process.env.QUANT_DATA_DIR = mkdtempSync(
  join(tmpdir(), "quant-changed-batch-"),
);

it("skips only identical contents and keeps timestamps while preserving changed-content upserts", () => {
  const first = {
    id: "snapshot",
    name: "原名称",
    bars: [{ close: 1.123456789 }],
  };
  expect(putChangedBatch("snapshot", [first])).toBe(1);
  sqlite().prepare("UPDATE records SET updated_at=1 WHERE id=?").run(first.id);
  expect(putChangedBatch("snapshot", [structuredClone(first)])).toBe(0);
  expect(
    sqlite().prepare("SELECT updated_at FROM records WHERE id=?").get(first.id),
  ).toEqual({ updated_at: 1 });
  const changed = { ...first, name: "新名称" };
  expect(putChangedBatch("snapshot", [changed])).toBe(1);
  expect(get(first.id)).toEqual(changed);
  expect(putChangedBatch("other-kind", [changed])).toBe(1);
});

it("rolls back a batch when a later record cannot be serialized", () => {
  const cyclic: { id: string; self?: unknown } = { id: "cyclic" };
  cyclic.self = cyclic;
  expect(() =>
    putChangedBatch("snapshot", [{ id: "must-rollback" }, cyclic]),
  ).toThrow();
  expect(get("must-rollback")).toBeUndefined();
  expect(get("cyclic")).toBeUndefined();
});

it("avoids repeated SQL payload comparisons but invalidates tracked and raw writes", () => {
  sqlite().exec(
    "CREATE TABLE attempts(n INTEGER); INSERT INTO attempts VALUES(0); CREATE TRIGGER count_attempt BEFORE INSERT ON records BEGIN UPDATE attempts SET n=n+1; END;",
  );
  const value = { id: "receipt", amount: 7 };
  putChangedBatch("snapshot", [value]);
  const attempts = () =>
    (sqlite().prepare("SELECT n FROM attempts").get() as { n: number }).n;
  const before = attempts();
  expect(putChangedBatch("snapshot", [value])).toBe(0);
  expect(attempts()).toBe(before);
  put("job", "unrelated", { status: "completed" });
  const afterJob = attempts();
  expect(putChangedBatch("snapshot", [value])).toBe(0);
  expect(attempts()).toBe(afterJob);
  put("snapshot", value.id, { ...value, amount: 8 });
  expect(putChangedBatch("snapshot", [value])).toBe(1);
  remove(value.id);
  expect(putChangedBatch("snapshot", [value])).toBe(1);
  sqlite().prepare("DELETE FROM records WHERE id=?").run(value.id);
  expect(putChangedBatch("snapshot", [value])).toBe(1);
  sqlite().exec("DROP TRIGGER count_attempt");
});

it("detects another connection and never reuses rolled-back receipts", () => {
  const value = { id: "external", amount: 7 };
  putChangedBatch("snapshot", [value]);
  const other = new Database(join(process.env.QUANT_DATA_DIR!, "quant.sqlite"));
  try {
    other.prepare("DELETE FROM records WHERE id=?").run(value.id);
  } finally {
    other.close();
  }
  expect(putChangedBatch("snapshot", [value])).toBe(1);
  expect(() =>
    atomic(() => {
      putChangedBatch("snapshot", [{ id: "rolled", amount: 9 }]);
      throw new Error("rollback");
    }),
  ).toThrow("rollback");
  expect(get("rolled")).toBeUndefined();
  expect(putChangedBatch("snapshot", [{ id: "rolled", amount: 9 }])).toBe(1);
  expect(
    putChangedBatch("snapshot", [value, { ...value, amount: 8 }, value]),
  ).toBe(2);
  expect(get(value.id)).toEqual(value);
});

it("retains receipts across unrelated external writes but detects edits and cross-kind replacements", () => {
  sqlite().exec(
    "CREATE TABLE external_attempts(n INTEGER); INSERT INTO external_attempts VALUES(0); CREATE TRIGGER external_attempt BEFORE INSERT ON records BEGIN UPDATE external_attempts SET n=n+1; END;",
  );
  const value = { id: "kind-receipt", amount: 7 };
  putChangedBatch("snapshot", [value]);
  const other = new Database(join(process.env.QUANT_DATA_DIR!, "quant.sqlite"));
  const attempts = () =>
    (sqlite().prepare("SELECT n FROM external_attempts").get() as { n: number })
      .n;
  try {
    other
      .prepare(
        "INSERT OR REPLACE INTO records VALUES('external-job','job','{}',1)",
      )
      .run();
    const before = attempts();
    expect(putChangedBatch("snapshot", [value])).toBe(0);
    expect(attempts()).toBe(before);
    other
      .prepare("UPDATE records SET payload=? WHERE id=?")
      .run(JSON.stringify({ ...value, amount: 9 }), value.id);
    expect(putChangedBatch("snapshot", [value])).toBe(1);
    other
      .prepare("INSERT OR REPLACE INTO records VALUES(?, 'job', ?, 1)")
      .run(value.id, JSON.stringify(value));
    expect(putChangedBatch("snapshot", [value])).toBe(1);
    expect(
      sqlite().prepare("SELECT kind FROM records WHERE id=?").get(value.id),
    ).toEqual({ kind: "snapshot" });
    other.prepare("UPDATE records SET kind='job' WHERE id=?").run(value.id);
    expect(putChangedBatch("snapshot", [value])).toBe(1);
    other.exec("BEGIN");
    other.prepare("DELETE FROM records WHERE id=?").run(value.id);
    other.exec("ROLLBACK");
    const rolledBack = attempts();
    expect(putChangedBatch("snapshot", [value])).toBe(0);
    expect(attempts()).toBe(rolledBack);
  } finally {
    other.close();
    sqlite().exec("DROP TRIGGER external_attempt");
  }
});
