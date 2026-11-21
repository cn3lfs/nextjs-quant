import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "~/server/db/migrations";
import { migrate as v16 } from "../fixtures/r2c-v16-migrations";

it("v17 migrates empty and populated v16 databases, preserves data and remains idempotent; frozen v16 refuses it", () => {
  for (const populated of [false, true]) {
    const db = new Database(":memory:");
    db.pragma("foreign_keys=ON");
    try {
      if (populated) {
        v16(db);
        db.prepare(
          "INSERT INTO records VALUES('QA','sentinel','{\"unchanged\":true}',17)",
        ).run();
      }
      const before = populated ? db.prepare("SELECT * FROM records").all() : [];
      migrate(db);
      expect(db.pragma("user_version", { simple: true })).toBe(23);
      expect(db.prepare("SELECT * FROM records").all()).toEqual(before);
      expect(db.pragma("foreign_key_check")).toEqual([]);
      const schema = db
        .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
        .all();
      migrate(db);
      expect(
        db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
      ).toEqual(schema);
      expect(() => v16(db)).toThrow("数据库版本高于此应用版本");
      for (const table of ["paper_accounts", "paper_state", "paper_facts"])
        expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({
          n: 0,
        });
    } finally {
      db.close();
    }
  }
});
it("a failure after account-table creation rolls back all v17 DDL, v16 data, and user_version", () => {
  const db = new Database(":memory:");
  try {
    v16(db);
    db.exec(
      "CREATE TABLE paper_facts (sentinel TEXT); INSERT INTO paper_facts VALUES('keep')",
    );
    const before = db
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
    expect(() => migrate(db)).toThrow("already exists");
    expect(db.pragma("user_version", { simple: true })).toBe(16);
    expect(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    ).toEqual(before);
    expect(db.prepare("SELECT * FROM paper_facts").all()).toEqual([
      { sentinel: "keep" },
    ]);
  } finally {
    db.close();
  }
});
