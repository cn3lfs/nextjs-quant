import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import type { NewsAnalysis } from "../../src/server/news/news-analysis";

export const newsFixtureCutoff = Date.parse("2025-01-07T16:00:00+08:00");
export const newsFixtureContent = "新闻原文".repeat(341) + "tail";

/** Synthetic, no external fetch or model invocation. Source DB is read-only after seeding. */
export function seedNewsSource(
  db: Database.Database,
  count: number,
  indexed: boolean,
) {
  db.exec(
    "CREATE TABLE news(id INTEGER PRIMARY KEY,ctime INTEGER,collected_at TEXT,title TEXT,content TEXT,shareurl TEXT)",
  );
  if (indexed) db.exec("CREATE INDEX news_time_id ON news(ctime DESC,id DESC)");
  const insert = db.prepare("INSERT INTO news VALUES(?,?,?,?,?,?)");
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      insert.run(
        i + 1,
        newsFixtureCutoff / 1000 - 60 - Math.floor(i / 3),
        "2025-01-07 15:59:30",
        `合成新闻${i + 1}`,
        newsFixtureContent + (i % 10 === 0 ? "末尾关键词" : ""),
        `https://www.cls.cn/detail/${i + 1}`,
      );
    }
  })();
}

export function newsFixtureAnalysis(index: number): NewsAnalysis {
  const id =
    "news-analysis-" +
    createHash("sha256").update(`news-fixture:${index}`).digest("hex");
  const news = Array.from({ length: 10 }, (_, i) => ({
    id: index * 10 + i + 1,
    title: `原文${index}-${i}`,
    content: newsFixtureContent,
    publishedAt: new Date(newsFixtureCutoff - 60000).toISOString(),
    collectedAt: "2025-01-07T15:59:30+08:00",
    url: null,
    hash: createHash("sha256").update(`${index}:${i}`).digest("hex"),
  }));
  const completed = index % 3 === 0 ? 5 : 10;
  return {
    id,
    createdAt: newsFixtureCutoff + index * 1000,
    model: "fixture:no-network",
    tokens: 0,
    input: {
      cutoff: newsFixtureCutoff,
      page: 0,
      query: index % 2 ? "半导体" : "",
      historical: true,
      scope: "page",
      maxItems: 200,
    },
    method: { version: "news-classification-1", files: [] },
    news,
    items: news.slice(0, completed).map((n) => ({
      id: n.id,
      industry: "未确定",
      impact: "uncertain",
      reason: "合成分类，不构成判断",
      uncertainty: "fixture",
    })),
    distribution: { 未确定: completed },
    status: completed === 10 ? "complete" : "partial",
    totalMatches: 10,
    hitLimit: false,
  };
}

export function seedNewsAnalyses(db: Database.Database, count: number) {
  const insert = db.prepare(
    "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,?,?,?)",
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      const record = newsFixtureAnalysis(i);
      insert.run(
        record.id,
        "news-analysis",
        JSON.stringify(record),
        record.createdAt,
      );
    }
  })();
}
