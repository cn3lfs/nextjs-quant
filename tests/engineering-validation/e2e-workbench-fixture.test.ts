import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/server/db/migrations";
import { readSnapshot } from "tstdx/local";
import { seedWorkbenchFixture } from "../e2e/workbench-fixture";

it("seeds the declared workload with real import rows and readable local bars, and refuses reseeding", async () => {
  const directory = mkdtempSync(resolve(".test-data/fixture-e2e-contract-"));
  const root = join(directory, "tdx");
  mkdirSync(root);
  const db = new Database(join(directory, "quant.sqlite"));
  try {
    migrate(db);
    db.prepare(
      "INSERT INTO records VALUES ('settings','settings','{}',1)",
    ).run();
    // Contract coverage uses the same generator at its minimum size; browser
    // performance acceptance uses the default 6154-security workload.
    const manifest = await seedWorkbenchFixture(root, db, 100);
    expect(manifest.securities).toBe(100);
    const accounts = db
      .prepare(
        "SELECT account,count(*) n FROM trade_fills GROUP BY account ORDER BY account",
      )
      .all() as { account: string; n: number }[];
    expect(accounts.map((row) => row.account)).toEqual(["big", "big10k"]);
    expect(accounts.every((row) => row.n > 0)).toBe(true);
    const snapshot = await readSnapshot(root, "sh600519", "day");
    expect(snapshot.bars.length).toBe(manifest.dates);
    expect(snapshot.bars[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(snapshot.bars.at(-1)!.date >= snapshot.bars[0]!.date).toBe(true);
    const index = await readSnapshot(root, "sh000905", "day");
    expect(index.bars.length).toBeGreaterThan(0);
    expect(index.bars[0]!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(
      snapshot.bars.every(
        (bar) => bar.low <= bar.open && bar.high >= bar.close,
      ),
    ).toBe(true);
    expect(
      JSON.parse(readFileSync(join(directory, "fixture.json"), "utf8")),
    ).toEqual(manifest);
    await expect(seedWorkbenchFixture(root, db)).rejects.toThrow(
      "fresh database",
    );
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60000);

it("refuses a database outside the generated fixture before writing files", async () => {
  const db = new Database(":memory:");
  try {
    await expect(
      seedWorkbenchFixture(resolve(".test-data/fixture-invalid/tdx"), db),
    ).rejects.toThrow();
    await expect(
      seedWorkbenchFixture(resolve("release/tdx"), db),
    ).rejects.toThrow("child directory");
  } finally {
    db.close();
  }
});
