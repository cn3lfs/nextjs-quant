import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  seedNewsSource,
  seedNewsAnalyses,
  newsFixtureCutoff,
} from "../helpers/news-workspace-fixture";
import {
  newsWorkspacePage,
  newsWorkspaceDetail,
  freezeNewsWorkspacePage,
  newsArchivePage,
} from "../../src/server/news/news-workspace-query";
import { readClsNews } from "../../src/server/data-sources/cls/cls-news";
import {
  newsArchiveQuerySchema,
  newsWorkspaceSchema,
} from "../../src/lib/news/news-workspace";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "quant-news-query-")),
    path = join(dir, "source.sqlite"),
    db = new Database(path);
  seedNewsSource(db, 121, true);
  return { path, db };
}
const input = { cutoff: newsFixtureCutoff, historical: true };
it("reports missing and incompatible sources without exposing the local path", () => {
  const dir = mkdtempSync(join(tmpdir(), "quant-news-invalid-"));
  const missing = join(dir, "missing.sqlite");
  expect(() => newsWorkspacePage(missing, input)).toThrow(
    "新闻存档不可读取或格式不兼容",
  );
  const empty = join(dir, "empty.sqlite");
  new Database(empty).close();
  expect(() => newsWorkspacePage(empty, input)).toThrow(
    "新闻存档不可读取或格式不兼容",
  );
  expect(() => newsWorkspacePage("", input)).toThrow("尚未配置新闻存档");
});
it("pages all source rows with whole-filter totals and exact original hashes; frozen page rejects changes", () => {
  const { path, db } = fixture();
  try {
    const first = newsWorkspacePage(path, input),
      old = readClsNews(path, input);
    expect(first.items.map((n) => n.hash)).toEqual(
      old.items.map((n) => n.hash),
    );
    expect(first.total).toBe(121);
    expect(first.items).toHaveLength(50);
    expect(first.items[0]).not.toHaveProperty("content");
    expect(
      newsWorkspacePage(path, { ...input, query: "不存在的正文" }),
    ).toMatchObject({ total: 0, items: [], nextCursor: null });
    expect(
      newsWorkspacePage(path, {
        ...input,
        cursor: { ...first.nextCursor!, time: 0 },
      }),
    ).toMatchObject({ total: 121, items: [], nextCursor: null });
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(65536);
    const second = newsWorkspacePage(path, {
        ...input,
        cursor: first.nextCursor!,
      }),
      third = newsWorkspacePage(path, { ...input, cursor: second.nextCursor! });
    expect(second.total).toBe(121);
    expect(third.items).toHaveLength(21);
    expect(third.nextCursor).toBeNull();
    expect(
      new Set(
        [...first.items, ...second.items, ...third.items].map((n) => n.id),
      ).size,
    ).toBe(121);
    const selection = {
      source: second.source,
      fingerprint: second.fingerprint,
      cursor: first.nextCursor!,
    };
    const frozen = freezeNewsWorkspacePage(path, input, selection);
    expect(frozen.items.map((n) => n.id)).toEqual(
      second.items.map((n) => n.id),
    );
    expect(frozen.items[0]!.content.length).toBeGreaterThan(1000);
    const detail = newsWorkspaceDetail(
      path,
      input,
      first.items[0]!.id,
      first.source,
    );
    expect(detail.item).toEqual(old.items[0]);
    expect(() =>
      newsWorkspacePage(path, {
        ...input,
        query: "另一个条件",
        cursor: first.nextCursor!,
      }),
    ).toThrow(/分页/);
    expect(() => newsWorkspaceDetail(path, input, 1, "0".repeat(64))).toThrow(
      /来源/,
    );
    db.prepare("UPDATE news SET content='修订正文' WHERE id=?").run(
      second.items[0]!.id,
    );
    expect(() => freezeNewsWorkspacePage(path, input, selection)).toThrow(
      /已变化/,
    );
  } finally {
    db.close();
  }
});
it("searches full content and respects publication and collection cutoff, including missing collection", () => {
  const { path, db } = fixture();
  try {
    expect(
      newsWorkspacePage(path, { ...input, query: "末尾关键词" }).total,
    ).toBe(13);
    db.prepare("UPDATE news SET collected_at=? WHERE id=?").run(
      "2025-01-08 00:00:00",
      1,
    );
    db.prepare("UPDATE news SET collected_at=NULL WHERE id=2").run();
    expect(newsWorkspacePage(path, input).total).toBe(119);
    expect(newsWorkspacePage(path, { ...input, historical: false }).total).toBe(
      121,
    );
    expect(() =>
      newsWorkspaceDetail(
        path,
        input,
        1,
        newsWorkspacePage(path, input).source,
      ),
    ).toThrow(/范围/);
    expect(
      newsWorkspaceSchema.safeParse({ ...input, cutoff: Date.now() + 60000 })
        .success,
    ).toBe(false);
    expect(
      newsArchiveQuerySchema.safeParse({ from: "2025-02-30" }).success,
    ).toBe(false);
  } finally {
    db.close();
  }
});
it("all 121 archive IDs are reachable without hidden deduplication, with metadata-only pages and bound filters", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE records(id TEXT PRIMARY KEY,kind TEXT,payload TEXT,updated_at INTEGER)",
    );
    seedNewsAnalyses(db, 121);
    const first = newsArchivePage(db, {});
    expect(first.total).toBe(121);
    expect(first.rows).toHaveLength(20);
    expect(first.rows[0]).not.toHaveProperty("news");
    expect(first.rows[0]).not.toHaveProperty("items");
    const ids = first.rows.map((n) => n.id);
    let cursor = first.nextCursor;
    while (cursor) {
      const next = newsArchivePage(db, { cursor });
      expect(next.total).toBe(121);
      ids.push(...next.rows.map((n) => n.id));
      cursor = next.nextCursor;
    }
    expect(new Set(ids).size).toBe(121);
    expect(newsArchivePage(db, { status: "partial" }).total).toBe(41);
    expect(newsArchivePage(db, { query: "半导体" }).total).toBe(60);
    expect(newsArchivePage(db, { query: "不存在的查询词" })).toMatchObject({
      total: 0,
      rows: [],
      nextCursor: null,
    });
    expect(
      newsArchivePage(db, { cursor: { ...first.nextCursor!, at: 0 } }),
    ).toMatchObject({ total: 121, rows: [], nextCursor: null });
    expect(() =>
      newsArchivePage(db, { query: "半导体", cursor: first.nextCursor! }),
    ).toThrow(/不一致/);
  } finally {
    db.close();
  }
});
