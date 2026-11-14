import { expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { migrate } from "../../src/server/db/migrations";
import { readSnapshot } from "../../src/server/data-sources/tdx/tdx";
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
    expect(
      db
        .prepare(
          "SELECT account,count(*) n FROM trade_fills GROUP BY account ORDER BY account",
        )
        .all(),
    ).toEqual([
      { account: "big", n: 2222 },
      { account: "big10k", n: 9418 },
    ]);
    const snapshot = await readSnapshot(root, "sh600519", "day");
    expect(snapshot.bars.length).toBe(manifest.dates);
    expect(snapshot.bars[0]!.date).toBe("2019-01-02");
    expect(snapshot.bars.at(-1)!.date).toBe("2026-11-12");
    const index = await readSnapshot(root, "sh000905", "day");
    expect(index.bars).toHaveLength(2038);
    expect(index.bars[0]).toMatchObject({ date: "2018-01-26", high: 3574.9 });
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
