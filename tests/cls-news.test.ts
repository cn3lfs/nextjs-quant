import { expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readClsNews } from "../src/server/data-sources/cls/cls-news";
const ts = (time: string) => Date.parse(`2025-01-01T${time}:00+08:00`);
function fixture() {
  const file = join(mkdtempSync(join(tmpdir(), "quant-news-")), "news.db");
  const db = new Database(file);
  db.exec(
    "CREATE TABLE news(id INTEGER PRIMARY KEY, ctime INTEGER, collected_at TEXT, title TEXT, content TEXT, shareurl TEXT)",
  );
  const insert = db.prepare("INSERT INTO news VALUES(?,?,?,?,?,?)");
  insert.run(
    1,
    ts("10:00") / 1000,
    "2025-01-01 10:05:00",
    "旧消息",
    "第一条",
    "https://www.cls.cn/detail/1",
  );
  insert.run(
    2,
    ts("11:00") / 1000,
    "2025-01-01 11:05:00",
    "半导体",
    "第二条",
    "javascript:alert(1)",
  );
  insert.run(
    3,
    ts("11:00") / 1000,
    "2025-01-01 13:00:00",
    "半导体补采",
    "第三条",
    null,
  );
  insert.run(
    4,
    ts("13:00") / 1000,
    "2025-01-01 13:05:00",
    "未来消息",
    "第四条",
    null,
  );
  insert.run(
    5,
    ts("11:30") / 1000,
    "invalid-time",
    "采集时间未知",
    "第五条",
    null,
  );
  db.close();
  return file;
}
it("historical mode excludes later publications and late/unknown collection, without changing the source database", () => {
  const file = fixture(),
    before = readFileSync(file);
  const historical = readClsNews(file, {
    cutoff: ts("12:00"),
    historical: true,
  });
  expect(historical.items.map((item) => item.id)).toEqual([2, 1]);
  expect(historical.items[0]?.url).toBeNull();
  expect(historical.items[0]?.collectedAt).toBe("2025-01-01T11:05:00+08:00");
  const archive = readClsNews(file, { cutoff: ts("12:00"), historical: false });
  expect(archive.items.map((item) => item.id)).toEqual([5, 3, 2, 1]);
  expect(readFileSync(file)).toEqual(before);
});
it("incremental cursor handles equal publication times and keyword search is literal", () => {
  const file = fixture();
  const first = readClsNews(file, {
    cutoff: ts("12:00"),
    after: { time: 0, id: 0 },
    limit: 2,
  });
  expect(first.items.map((item) => item.id)).toEqual([1, 2]);
  const second = readClsNews(file, {
    cutoff: ts("12:00"),
    after: first.nextCursor!,
    limit: 2,
  });
  expect(second.items.map((item) => item.id)).toEqual([3, 5]);
  expect(
    readClsNews(file, { cutoff: ts("12:00"), query: "半导体" }).count,
  ).toBe(2);
  expect(readClsNews(file, { cutoff: ts("12:00"), query: "%" }).count).toBe(0);
});
it("a missing source is not silently created and future cutoff is rejected", () => {
  const file = join(
    mkdtempSync(join(tmpdir(), "quant-news-missing-")),
    "missing.db",
  );
  expect(() => readClsNews(file, { cutoff: ts("12:00") })).toThrow();
  expect(existsSync(file)).toBe(false);
  expect(() => readClsNews(fixture(), { cutoff: Date.now() + 100000 })).toThrow(
    "时间范围",
  );
});
it("倒序游标跨过1000条上限仍覆盖同秒新闻，不因偏移重复或遗漏", () => {
  const file = fixture(),
    db = new Database(file);
  db.prepare("DELETE FROM news").run();
  const insert = db.prepare("INSERT INTO news VALUES(?,?,?,?,?,?)");
  db.transaction(() => {
    for (let id = 1; id <= 1205; id++)
      insert.run(
        id,
        ts("11:00") / 1000,
        "2025-01-01 11:05:00",
        `同秒新闻${id}`,
        "原文",
        null,
      );
  })();
  db.close();
  const before = readFileSync(file);
  const first = readClsNews(file, {
    cutoff: ts("12:00"),
    historical: true,
    limit: 1000,
  });
  const second = readClsNews(file, {
    cutoff: ts("12:00"),
    historical: true,
    limit: 1000,
    before: first.nextBefore!,
    page: 99,
  });
  expect(first.count).toBe(1205);
  expect(first.items).toHaveLength(1000);
  expect(second.count).toBe(205);
  expect(second.items).toHaveLength(205);
  const ids = [...first.items, ...second.items].map((n) => n.id);
  expect(ids).toEqual(Array.from({ length: 1205 }, (_, i) => 1205 - i));
  expect(new Set(ids).size).toBe(1205);
  expect(readFileSync(file)).toEqual(before);
  expect(() =>
    readClsNews(file, {
      cutoff: ts("12:00"),
      before: first.nextBefore!,
      after: { time: 0, id: 0 },
    }),
  ).toThrow();
  expect(() =>
    readClsNews(file, {
      cutoff: ts("12:00"),
      before: { time: Infinity, id: 1 },
    }),
  ).toThrow();
});
