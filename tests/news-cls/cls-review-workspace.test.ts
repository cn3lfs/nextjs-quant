import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import {
  clsReportPage,
  clsFactPage,
  clsVerificationPage,
  clsVerificationDetail,
  clsFactDetail,
} from "../../src/server/news/cls-review-query";
import { seedClsReview } from "../helpers/cls-review-fixture";
import { ClsReviewStore } from "../../src/server/news/cls-review-store";
import { clsFactStatistics } from "../../src/lib/news/cls-fact-review";
import {
  clearSubmittedClsDraft,
  emptyClsFactDraft,
  clsTextChunk,
} from "../../src/lib/news/cls-review-workspace";

const databases: Database.Database[] = [];
function fixture(count = 41, history = 25) {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec(
    "CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,updated_at INTEGER)",
  );
  seedClsReview(db, count, history);
  return db;
}
afterEach(() => databases.splice(0).forEach((db) => db.close()));

it("visits every report once across tied times and uses an exact final page", () => {
  const db = fixture();
  const first = clsReportPage(db, {});
  const second = clsReportPage(db, { cursor: first.nextCursor });
  const third = clsReportPage(db, { cursor: second.nextCursor });
  expect([first.items.length, second.items.length, third.items.length]).toEqual(
    [20, 20, 1],
  );
  expect(
    new Set(
      [...first.items, ...second.items, ...third.items].map((row) => row.id),
    ).size,
  ).toBe(41);
  expect(third.hasMore).toBe(false);
  expect(JSON.stringify(first)).not.toContain("合成证据");
  expect(first.items[0]).not.toHaveProperty("report");
  expect(() =>
    clsReportPage(db, { title: "other", cursor: first.nextCursor }),
  ).toThrow("分页条件");
  expect(() => clsReportPage(db, { from: "2026-02-30" })).toThrow();
  expect(
    clsReportPage(db, { unknownDate: true }).items.every(
      (row) => row.reportDate === null,
    ),
  ).toBe(true);
  expect(clsReportPage(db, { title: "%" }).items).toEqual([]);
});

it("has no phantom page at 20, and a cursor survives deletion of its anchor", () => {
  const db = fixture(20);
  expect(clsReportPage(db, {}).hasMore).toBe(false);
  const larger = fixture();
  const first = clsReportPage(larger, {});
  larger.prepare("DELETE FROM records WHERE id=?").run(first.items.at(-1)!.id);
  expect(
    clsReportPage(larger, { cursor: first.nextCursor }).items,
  ).toHaveLength(20);
});

it("returns current claims separately from history with statistics across all current claims", () => {
  const db = fixture(1);
  const reportId = "cls-review-report:fixture-00000";
  const store = new ClsReviewStore(db);
  const current = clsFactPage(db, { reportId });
  const history = clsFactPage(db, { reportId, mode: "history" });
  expect(current.items).toHaveLength(1);
  expect(history.items).toHaveLength(20);
  expect(current.statistics).toEqual(clsFactStatistics(store.facts(reportId)));
  expect(history.statistics).toEqual(current.statistics);
  expect(
    clsFactPage(db, { reportId, mode: "history", cursor: history.nextCursor })
      .items,
  ).toHaveLength(5);
  expect(() =>
    store.saveFact({
      reportId,
      sectionId: "0".repeat(64),
      quote: "合成证据",
      evidence: "错配",
      verdict: "supported",
    }),
  ).toThrow("摘录");
});

it("pages verification metadata and loads only the requested full identity", () => {
  const db = fixture(1);
  const page = clsVerificationPage(db, { date: "2020-01-01" });
  expect(page.items).toHaveLength(20);
  expect(page.items[0]).not.toHaveProperty("bars");
  expect(
    clsVerificationDetail(db, { date: "2020-01-01", hash: page.items[0]!.hash })
      ?.bars,
  ).toEqual([]);
  expect(
    clsVerificationDetail(db, {
      date: "2020-01-02",
      hash: page.items[0]!.hash,
    }),
  ).toBeNull();
});

it("does not clear another report or edits made after submission", () => {
  const drafts = {
    a: { ...emptyClsFactDraft(), quote: "A", revision: 2 },
    b: { ...emptyClsFactDraft(), quote: "B", revision: 4 },
  };
  expect(clearSubmittedClsDraft(drafts, "a", 1)).toBe(drafts);
  const saved = clearSubmittedClsDraft(drafts, "a", 2);
  expect(saved.a?.quote).toBe("");
  expect(saved.b?.quote).toBe("B");
});

it("renders bounded contiguous text segments without losing astral characters", () => {
  const text = "a".repeat(7999) + "😀" + "原文".repeat(12000) + "😀尾部";
  const pages = Array.from({ length: Math.ceil(text.length / 8000) }, (_, i) =>
    clsTextChunk(text, i),
  );
  expect(pages.join("")).toBe(text);
  expect(pages.every((value) => value.length <= 8001)).toBe(true);
  expect(clsTextChunk("", 0)).toBe("");
});

it("keeps global claim statistics beyond the page and bounded previews with complete detail", () => {
  const db = fixture(1, 0);
  const reportId = "cls-review-report:fixture-00000";
  const insert = db.prepare("INSERT INTO records VALUES (?,?,?,?)");
  for (let index = 0; index < 31; index++) {
    const fact = {
      id: `fact-${index}`,
      reportId,
      sectionId: "0".repeat(64),
      quote: `${index}${"长摘录".repeat(900)}`,
      evidence: "完整核对依据".repeat(800),
      verdict: index % 2 ? "supported" : "contradicted",
      reviewedAt: index,
    };
    insert.run(fact.id, "cls-review-fact", JSON.stringify(fact), index);
  }
  const page = clsFactPage(db, { reportId });
  expect(page.items).toHaveLength(20);
  expect(page.statistics.reviewed).toBe(31);
  expect(page.statistics.supported).toBe(15);
  const empty = clsFactPage(db, { reportId, verdict: "unresolved" });
  expect(empty.items).toEqual([]);
  expect(empty.statistics).toEqual(page.statistics);
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(64 * 1024);
  expect(page.items[0]!.truncated).toBe(1);
  expect(clsFactDetail(db, reportId, page.items[0]!.id)?.evidence.length).toBe(
    4800,
  );
  expect(clsFactDetail(db, "different-report", page.items[0]!.id)).toBeNull();
});
