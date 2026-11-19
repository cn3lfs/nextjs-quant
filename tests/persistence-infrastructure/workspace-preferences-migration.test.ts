import Database from "better-sqlite3";
import { expect, it } from "vitest";
import { migrate } from "~/server/db/migrations";
import {
  workspacePreferences,
  saveWorkspacePreferences,
} from "~/server/db/workspace-preferences";

it("upgrades v19 once, preserves ledger bytes and keeps independent partial preference updates", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE trade_plans(id TEXT,payload TEXT);INSERT INTO trade_plans VALUES('a','{}');PRAGMA user_version=19",
    );
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(20);
    expect(workspacePreferences(db)).toEqual({
      density: "comfort",
      sidebarCollapsed: false,
      expandedGroups: ["今日交易"],
      closeToTray: false,
      holdingsReconciliation: "upper-bound",
      singleKeyShortcuts: true,
      updatedAt: expect.any(Number),
    });
    saveWorkspacePreferences(
      { singleKeyShortcuts: false, expandedGroups: [] },
      db,
    );
    const saved = saveWorkspacePreferences({ density: "compact" }, db);
    migrate(db);
    expect(workspacePreferences(db)).toEqual(saved);
    expect(saved).toMatchObject({
      density: "compact",
      expandedGroups: [],
      singleKeyShortcuts: false,
    });
    expect(() =>
      db.exec("UPDATE workspace_preferences SET close_to_tray=2"),
    ).toThrow();
    expect(() =>
      saveWorkspacePreferences({ expandedGroups: [""] }, db),
    ).toThrow();
    expect(workspacePreferences(db)).toEqual(saved);
    expect(db.prepare("SELECT payload FROM trade_plans").get()).toEqual({
      payload: "{}",
    });
  } finally {
    db.close();
  }
});
