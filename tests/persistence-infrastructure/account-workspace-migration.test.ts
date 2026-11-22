import Database from "better-sqlite3";
import { it, expect } from "vitest";
import { migrate } from "~/server/db/migrations";
import { migrate as v17 } from "../fixtures/r3b-v17-migrations";

it("migration through v21 preserves empty and populated v17 facts and the actual v17 entry refuses the upgrade", () => {
  for (const populated of [false, true]) {
    const db = new Database(":memory:");
    try {
      db.pragma("foreign_keys=ON");
      if (populated) {
        v17(db);
        db.prepare(
          "INSERT INTO records VALUES('QA','sentinel','{\"unchanged\":true}',1)",
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
      expect(() => v17(db)).toThrow("数据库版本高于此应用版本");
      for (const table of [
        "account_trade_links",
        "account_link_audit",
        "account_expectations",
      ])
        expect(db.prepare(`SELECT count(*) n FROM ${table}`).get()).toEqual({
          n: 0,
        });
    } finally {
      db.close();
    }
  }
});
it("R3b rolls back halfway through v18 without losing v17 facts or changing its version", () => {
  const db = new Database(":memory:");
  try {
    v17(db);
    db.exec(
      "CREATE TABLE account_link_audit(sentinel TEXT); INSERT INTO account_link_audit VALUES('keep')",
    );
    const before = db
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
    expect(() => migrate(db)).toThrow("already exists");
    expect(db.pragma("user_version", { simple: true })).toBe(17);
    expect(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    ).toEqual(before);
    expect(db.prepare("SELECT * FROM account_link_audit").all()).toEqual([
      { sentinel: "keep" },
    ]);
  } finally {
    db.close();
  }
});
