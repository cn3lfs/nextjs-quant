import Database from "better-sqlite3";
import { afterAll, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  db: undefined as Database.Database | undefined,
}));
vi.mock("../../src/server/db/index", () => ({ sqlite: () => state.db! }));
import { newsSectorHistory } from "../../src/server/news/news-sector-history";
afterAll(() => state.db?.close());
it("按档案及行业恢复最新报告，不被其他档案的100份报告挤掉", () => {
  const db = (state.db = new Database(":memory:"));
  db.exec(
    "CREATE TABLE records(id TEXT PRIMARY KEY, kind TEXT, payload TEXT, updated_at INTEGER)",
  );
  const insert = db.prepare("INSERT INTO records VALUES (?,?,?,?)");
  const add = (id: string, archive: string, industry: string, time: number) =>
    insert.run(
      id,
      "news-sector",
      JSON.stringify({ id, input: { analysisId: archive, industry } }),
      time,
    );
  add("old", "target", "电子", 1);
  add("new", "target", "电子", 2);
  add("bank", "target", "银行", 1);
  for (let i = 0; i < 110; i++) add(`unrelated-${i}`, "other", "电子", i + 10);
  expect(newsSectorHistory("target").map((r) => r.id)).toEqual(["new", "bank"]);
  expect(newsSectorHistory("missing")).toEqual([]);
});
