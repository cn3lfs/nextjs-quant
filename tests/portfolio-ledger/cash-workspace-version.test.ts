import Database from "better-sqlite3";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  utimesSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { migrate } from "../../src/server/db/migrations";
import {
  cashReviewInputIdentity,
  cashReviewVersion,
  assertCashReviewVersion,
} from "../../src/server/portfolio/cash-reconciliation-workspace";

it("invalidates a cached account when the local calendar file changes without a database write", () => {
  const directory = mkdtempSync(join(tmpdir(), "quant-cash-calendar-version-"));
  const db = new Database(":memory:");
  migrate(db);
  const config = { tdxRoot: directory, calendar: [] };
  try {
    const unavailable = cashReviewInputIdentity(db, "calendar", config);
    const parent = join(directory, "vipdoc/sh/lday");
    mkdirSync(parent, { recursive: true });
    const file = join(parent, "sh000001.day");
    writeFileSync(file, Buffer.alloc(32));
    const appeared = cashReviewInputIdentity(db, "calendar", config);
    expect(appeared).not.toBe(unavailable);
    const changes = db.prepare("SELECT total_changes() n").get();
    writeFileSync(file, Buffer.alloc(32, 1));
    // Explicit filesystem time makes this check deterministic on coarse clocks.
    utimesSync(file, new Date("2026-01-01"), new Date("2026-01-01"));
    expect(cashReviewInputIdentity(db, "calendar", config)).not.toBe(appeared);
    expect(db.prepare("SELECT total_changes() n").get()).toEqual(changes);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("detects same-connection and external content writes while keeping other accounts stable", () => {
  const directory = mkdtempSync(
    join(tmpdir(), "quant-cash-reconciliation-version-"),
  );
  const path = join(directory, "test.db");
  const db = new Database(path);
  migrate(db);
  const other = new Database(path);
  const config = { tdxRoot: "missing", calendar: ["2026-01-01"] };
  try {
    const initial = cashReviewInputIdentity(db, "a", config);
    const unrelated = cashReviewInputIdentity(db, "b", config);
    db.prepare(
      "INSERT INTO import_batches VALUES ('batch','a','generic','hash','file',1,'{}')",
    ).run();
    const imported = cashReviewInputIdentity(db, "a", config);
    expect(imported).not.toBe(initial);
    expect(cashReviewInputIdentity(db, "b", config)).toBe(unrelated);
    other
      .prepare("UPDATE import_batches SET payload=? WHERE id='batch'")
      .run('{"rawRows":[["new"]]}');
    const changed = cashReviewInputIdentity(db, "a", config);
    expect(changed).not.toBe(imported);
    expect(cashReviewInputIdentity(db, "a", config)).toBe(changed);
    expect(
      cashReviewInputIdentity(db, "a", { ...config, calendar: ["2026-01-02"] }),
    ).not.toBe(changed);
    const version = cashReviewVersion(changed, "calendar-a", { cash: null });
    expect(() =>
      assertCashReviewVersion(
        version,
        cashReviewVersion(changed, "calendar-a", { cash: 0 }),
      ),
    ).toThrow("已更新");
    expect(() =>
      assertCashReviewVersion(
        version,
        cashReviewVersion(changed, "calendar-b", { cash: null }),
      ),
    ).toThrow("已更新");
  } finally {
    other.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
