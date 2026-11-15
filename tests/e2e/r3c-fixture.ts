import type Database from "better-sqlite3";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import NewsDatabase from "better-sqlite3";
import { AlertRepository } from "../../src/server/db/alert-repository";
import { seedR2cFixture } from "./r2c-fixture";
import daily from "../fixtures/breakout-valid.json";

/** Synthetic fixed evidence only. No live strategy or external subscription. */
export async function seedR3cFixture(db: Database.Database, directory: string) {
  seedR2cFixture(db);
  const repo = new AlertRepository(db),
    id = "r3a-shadow-qa";
  repo.saveState(`shadow-summary:${id}:1`, {
    signals: 12,
    days: 18,
    paused: false,
    assessment: null,
  });
  const score = { return: 0.04, excess: 0.01, drawdown: 0.08, trades: 15 };
  const window = {
    start: "2023-01-01",
    end: "2023-12-31",
    base: score,
    doubledCost: { ...score, return: 0.02 },
    delayed: { ...score, return: 0.01 },
  };
  const report = {
    inputHash: "a".repeat(64),
    result: {
      suites: [
        {
          suite: {
            rows: [
              {
                id,
                windows: [window],
                holdout: window,
                reasons: ["multiple-testing-dsr-0.95"],
                passed: false,
              },
            ],
          },
        },
      ],
    },
  };
  const hash = createHash("sha256")
    .update(JSON.stringify(report))
    .digest("hex");
  await mkdir(join(directory, "research-validation"), { recursive: true });
  await writeFile(
    join(directory, "research-validation", `report-${hash}.json`),
    JSON.stringify(report),
  );
  repo.records.save(
    "validation-scoreboard",
    "validation-scoreboard-cn-equity",
    {
      market: "cn-equity",
      inputHash: "a".repeat(64),
      resultHash: hash,
      buildHash: "QA",
      createdAt: Date.now(),
      runtimeMs: 0,
      universe: "QA中证800观察子集",
      gaps: ["合成测试"],
      missing: [],
      rows: [
        {
          id,
          level: "strategy",
          market: "cn-equity",
          sleeve: "swing",
          rule: "QA日常路径策略",
          status: "research",
          return: 0.04,
          excess: 0.01,
          drawdown: 0.08,
          trades: 15,
          positiveWindows: 1,
          oosWindows: 3,
          dsr: { value: 0.4, reason: null },
          bias: {
            universe: "QA固定证券池",
            adjustment: "原价",
            financial: "无财务",
            execution: "模拟",
          },
          biasTags: [
            {
              code: "QA",
              severity: "high",
              detail: "固定测试数据，不是真实业绩",
            },
          ],
          reasons: ["multiple-testing-dsr-0.95"],
        },
      ],
    },
  );
  const path = join(directory, "news.sqlite"),
    news = new NewsDatabase(path);
  try {
    news.exec(
      "CREATE TABLE news(id INTEGER PRIMARY KEY,ctime INTEGER,collected_at TEXT,title TEXT,content TEXT,shareurl TEXT)",
    );
    const now = Date.now(),
      historical = Date.parse(`${daily.bars.at(-1)!.date}T10:00:00+08:00`);
    const insert = news.prepare("INSERT INTO news VALUES(?,?,?,?,?,?)");
    insert.run(
      1,
      Math.floor(now / 1000) - 60,
      new Date(now + 8 * 3600000).toISOString().slice(0, 19).replace("T", " "),
      "sh600000 今日QA公告",
      "已有持仓相关QA原文节选；不是真实消息。",
      null,
    );
    insert.run(
      2,
      Math.floor(historical / 1000),
      `${daily.bars.at(-1)!.date} 10:01:00`,
      "sh600000 图表QA事件",
      "图表事件原文QA。仅本地存档，未请求任何外部服务。",
      null,
    );
  } finally {
    news.close();
  }
  const settings = repo.records.read<Record<string, unknown>>("settings")!;
  repo.records.save("settings", "settings", { ...settings, clsDbPath: path });
}
