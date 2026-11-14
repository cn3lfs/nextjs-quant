// Browser review fixtures only. Never seed the shared application database.
import Database from "better-sqlite3";
import { join, resolve } from "node:path";
import type { NewsAnalysis } from "../../../src/server/news/news-analysis";

const isolated = resolve(".test-data/n3/browser");
if (
  !process.env.QUANT_DATA_DIR ||
  resolve(process.env.QUANT_DATA_DIR) !== isolated
) {
  throw new Error("Set QUANT_DATA_DIR to .test-data/n3/browser before seeding");
}
const { put, sqlite } = await import("../../../src/server/db");
const { saveSettings } = await import("../../../src/server/infra/settings");
const { settingsSchema } = await import("../../../src/lib/domain");
saveSettings(
  settingsSchema.parse({
    autoNewsAnalysis: false,
    clsDbPath: join(isolated, "n3-news.sqlite"),
  }),
);

const news: NewsAnalysis = {
  id: `news-analysis-${"3".repeat(64)}`,
  createdAt: Date.parse("2026-09-09T10:00:00+08:00"),
  model: "N3 UI fixture (no model call)",
  tokens: 0,
  input: {
    cutoff: Date.parse("2026-09-09T10:00:00+08:00"),
    historical: true,
    page: 0,
    query: "N3 可达性样例",
    scope: "page",
    maxItems: 200,
  },
  method: { version: "n3-ui-fixture", files: [] },
  news: [
    {
      id: 1,
      title: "N3 UI 样例：仅验证面板可达性",
      content: "构造的界面验收数据，不是真实新闻，不作研究依据。",
      hash: "n3-fixture",
      url: null,
      publishedAt: "2026-09-09T09:00:00+08:00",
      collectedAt: "2026-09-09T09:01:00+08:00",
    },
  ],
  items: [
    {
      id: 1,
      industry: "电子",
      impact: "uncertain",
      reason: "UI 样例",
      uncertainty: "不是真实新闻",
    },
  ],
  distribution: { 电子: 1 },
  aggregation: {
    version: "news-day-1",
    day: "2026-09-09",
    archiveIds: ["n3-ui-fixture"],
    conflicts: [],
    observed: 1,
  },
};
put("news-analysis", news.id, news);
// Match the existing cls-news fixture schema; the application opens it read-only.
const source = new Database(join(isolated, "n3-news.sqlite"));
source.exec(
  "CREATE TABLE IF NOT EXISTS news(id INTEGER PRIMARY KEY, ctime INTEGER, collected_at TEXT, title TEXT, content TEXT, shareurl TEXT)",
);
source
  .prepare("INSERT OR REPLACE INTO news VALUES(?,?,?,?,?,?)")
  .run(
    1,
    Date.parse(news.news[0]!.publishedAt) / 1000,
    "2026-09-09 09:01:00",
    news.news[0]!.title,
    news.news[0]!.content,
    null,
  );
source.close();
sqlite().close();
console.log("N3 browser fixtures ready in isolated directory");
