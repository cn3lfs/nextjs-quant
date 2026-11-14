import Database from "better-sqlite3";
import { copyFile, mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { reportSchema, type Report } from "../../src/lib/domain";
import { seedClsReview } from "../helpers/cls-review-fixture";
import {
  seedNewsAnalyses,
  seedNewsSource,
} from "../helpers/news-workspace-fixture";
import { seedSignals } from "../helpers/signals-fixture";
import { seedTradeWorkspace } from "../helpers/trade-workspace-fixture";
import { fixtureDirectory } from "./fixture-directory";
import { parseBars } from "tstdx/local";
import { rpsPeriods, rpsPolicy } from "quant-rps";
import {
  calculateRpsDay,
  prepareRpsSecurity,
} from "../../src/server/screening/rps-adapter";
import { RpsStore } from "../../src/server/screening/rps-store";
import { rpsHash } from "../../src/server/infra/content-hash";

// Compose existing generators; market data and account fills continue to come
// exclusively from the 6,154-security workbench fixture.
export async function seedP1Acceptance(root: string, db: Database.Database) {
  fixtureDirectory(root);
  const directory = join(root, "..");
  const settings = db
    .prepare("SELECT payload FROM records WHERE id='settings'")
    .get() as { payload: string };
  const newsPath = join(directory, "news.sqlite");
  const source = new Database(newsPath);
  try {
    seedNewsSource(source, 30, true);
  } finally {
    source.close();
  }
  seedNewsAnalyses(db, 4);
  seedClsReview(db, 3, 2);
  seedSignals(db, 3, 6);
  seedTradeWorkspace(db, 400);
  await mkdir(join(root, "vipdoc/cw"), { recursive: true });
  for (const [from, to] of [
    ["gpcw20260930.dat", "gpcw20260930.dat"],
    ["gpsz000001.dat", "gpsh600519.dat"],
    ["gpsh999999.dat", "gpsh999999.dat"],
  ]) {
    await copyFile(
      join("packages/tstdx/tests/fixtures/local", from!),
      join(root, "vipdoc/cw", to!),
    );
  }
  const report: Report = {
    ...reportSchema.parse({
      title: "P1 合成研究报告",
      summary: "固定界面验收输入，不代表真实研究或策略业绩。",
      supporting: ["合成支持证据"],
      opposing: ["合成反向证据"],
      risks: ["仅验证界面"],
      missing: ["真实数据未验证"],
      nextSteps: ["人工核对"],
      citations: ["P1-E1"],
    }),
    id: "p1-report",
    createdAt: Date.parse("2026-11-12T08:00:00Z"),
    model: "fixture:no-model-call",
    promptVersion: "p1-fixture-1",
    tokens: 0,
    contextId: "p1-report-source",
    evidence: [
      {
        id: "P1-E1",
        source: "固定合成 fixture",
        asOf: "2026-11-12",
        text: "合成证据原文",
      },
    ],
  };
  const insert = db.prepare(
    "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,?,?,?)",
  );
  insert.run(report.id, "report", JSON.stringify(report), report.createdAt);
  insert.run(
    report.contextId,
    "snapshot",
    JSON.stringify({ symbol: "sh600519", name: "E2E_SYNTH_99" }),
    report.createdAt,
  );
  db.prepare("UPDATE records SET payload=? WHERE id='settings'").run(
    JSON.stringify({ ...JSON.parse(settings.payload), clsDbPath: newsPath }),
  );
  const calendar = (JSON.parse(settings.payload) as { calendar: string[] })
    .calendar;
  const date = calendar.at(-1)!;
  const stocks = [];
  for (const file of (await readdir(join(root, "vipdoc/sh/lday"))).sort()) {
    if (!/^sh6\d{5}\.day$/.test(file)) continue;
    const bars = parseBars(
      await readFile(join(root, "vipdoc/sh/lday", file)),
      "day",
      2026,
    );
    stocks.push(
      prepareRpsSecurity(
        file.slice(0, -4),
        "合成证券",
        bars,
        [],
        calendar.at(-121)!,
      ),
    );
  }
  const { rows, ...result } = calculateRpsDay(stocks, calendar, date);
  new RpsStore(db).saveDay(
    {
      ...result,
      date,
      mode: "backfill",
      periods: [...rpsPeriods],
      policy: rpsPolicy,
      total: stocks.length,
      source: {
        root,
        calendar: "synthetic-workbench",
        calendarHash: rpsHash(calendar),
        actionsHash: rpsHash([]),
        actionsCoverage: date,
        universeHash: rpsHash(stocks.map((s) => s.symbol)),
      },
      createdAt: report.createdAt,
    },
    rows,
  );
}
