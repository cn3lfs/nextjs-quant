import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "~/server/db/migrations";
import { migrate as migrateDeployedV18 } from "../fixtures/l1-v18-migrations";

function v18() {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE strategies(id TEXT,version INTEGER,PRIMARY KEY(id,version)); CREATE TABLE trade_plans(id TEXT PRIMARY KEY,payload TEXT); PRAGMA user_version=18",
  );
  db.prepare("INSERT INTO trade_plans VALUES(?,?)").run(
    "old",
    JSON.stringify({ entry: 10, stop: 9 }),
  );
  return db;
}
it("migration19 labels old protection unavailable, preserves plan values and is idempotent", () => {
  const db = v18();
  try {
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(21);
    expect(
      JSON.parse(
        (
          db.prepare("SELECT payload FROM trade_plans").get() as {
            payload: string;
          }
        ).payload,
      ),
    ).toMatchObject({
      entry: 10,
      stop: 9,
      protection: { version: "unavailable" },
    });
    expect(
      db.prepare("SELECT count(*) n FROM account_protections").get(),
    ).toEqual({ n: 0 });
    const schema = db
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
    migrate(db);
    expect(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    ).toEqual(schema);
  } finally {
    db.close();
  }
});
it("a migration19 failure rolls back without altering v18 facts or its version", () => {
  const db = v18();
  try {
    db.exec("CREATE TABLE account_protections(sentinel TEXT)");
    const before = db.prepare("SELECT * FROM trade_plans").all();
    expect(() => migrate(db)).toThrow();
    expect(db.pragma("user_version", { simple: true })).toBe(18);
    expect(db.prepare("SELECT * FROM trade_plans").all()).toEqual(before);
  } finally {
    db.close();
  }
});

it("the deployed schema18 application's actual migration entry refuses schema21 unchanged", () => {
  const db = new Database(":memory:");
  try {
    migrate(db);
    const before = db
      .prepare("SELECT name,sql FROM sqlite_master ORDER BY name")
      .all();
    expect(() => migrateDeployedV18(db)).toThrow("数据库版本高于此应用版本");
    expect(db.pragma("user_version", { simple: true })).toBe(21);
    expect(
      db.prepare("SELECT name,sql FROM sqlite_master ORDER BY name").all(),
    ).toEqual(before);
  } finally {
    db.close();
  }
});
