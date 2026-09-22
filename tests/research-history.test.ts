import Database from "better-sqlite3";
import { afterAll, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
}));
vi.mock("../src/server/db", () => ({ sqlite: () => state.db! }));
import { researchHistory } from "../src/server/research/research-history";
afterAll(() => state.db?.close());

it("projects bounded summaries for each method without returning full evidence", () => {
  const db = (state.db = new Database(":memory:"));
  db.exec(
    "CREATE TABLE records(id TEXT PRIMARY KEY, kind TEXT, payload TEXT, updated_at INTEGER)",
  );
  const insert = db.prepare("INSERT INTO records VALUES (?,?,?,?)");
  const methods = [
    ["wyckoff-report", "frames"],
    ["chan-report", "evidence"],
    ["canslim-report", "dossier"],
  ] as const;
  for (const [kind, field] of methods) {
    expect(researchHistory(kind)).toEqual([]);
    for (let i = 0; i < 102; i++) {
      const id = `${kind}-${i}`;
      insert.run(
        id,
        kind,
        JSON.stringify({
          id,
          createdAt: 2000 - i,
          model: "codex:default",
          result: { title: `报告${i}` },
          [field]: { symbol: "sh600519", bars: "large-evidence".repeat(10000) },
          method: { text: "full-method".repeat(10000) },
        }),
        i,
      );
    }
    const rows = researchHistory(kind);
    expect(rows).toHaveLength(100);
    expect(rows[0]).toEqual({
      id: `${kind}-101`,
      createdAt: 1899,
      symbol: "sh600519",
      title: "报告101",
      model: "codex:default",
    });
    expect(rows.at(-1)?.id).toBe(`${kind}-2`);
    expect(JSON.stringify(rows)).not.toContain("large-evidence");
    expect(JSON.stringify(rows)).not.toContain("full-method");
    expect(
      db
        .prepare("SELECT length(payload) AS bytes FROM records WHERE id=?")
        .get(`${kind}-101`),
    ).toMatchObject({ bytes: expect.any(Number) });
  }
});
