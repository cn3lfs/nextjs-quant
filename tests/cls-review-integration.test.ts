import Database from "better-sqlite3";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
  utimes,
  readFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ db: null as unknown, root: "", blocks: "" }));
vi.mock("../src/server/db", () => ({
  sqlite: () => state.db,
  get: (id: string) => {
    const row = (state.db as Database.Database)
      .prepare("SELECT payload FROM records WHERE id=?")
      .get(id) as { payload: string } | undefined;
    return row ? JSON.parse(row.payload) : undefined;
  },
}));
vi.mock("../src/server/settings", () => ({
  settings: () => ({
    tdxRoot: state.root,
    industryBlocksRoot: state.blocks,
    calendar: ["2026-09-10", "2026-09-11", "2026-09-14"],
  }),
}));
vi.mock("../src/server/securities", () => ({
  securityDirectory: async () => ({
    entries: { sh600000: { symbol: "sh600000", name: "合成样本" } },
  }),
}));
import { migrate } from "../src/server/db/migrations";
import { RpsStore } from "../src/server/rps-store";
import { rpsDay } from "./rps-fixture";
import { previewClsReport } from "../src/server/cls-report-files";
import { ClsReviewStore } from "../src/server/cls-review-store";
import { fixClsSample } from "../src/server/cls-review-service";
import { verifyClsSample } from "../src/server/cls-verification";

it("fixes a sector-RPS sample before open and persists matching close evidence without writing source files", async () => {
  await mkdir(".test-data", { recursive: true });
  const directory = await mkdtemp(resolve(".test-data/cls-chain-"));
  const db = new Database(":memory:");
  state.db = db;
  migrate(db);
  state.root = join(directory, "tdx");
  state.blocks = join(directory, "Blocks");
  const before = Date.parse("2026-09-11T09:00:00+08:00");
  const clock = vi.spyOn(Date, "now").mockReturnValue(before);
  try {
    await mkdir(join(state.root, "vipdoc/sh/lday"), { recursive: true });
    for (const category of ["申万行业", "概念"])
      await mkdir(join(state.blocks, category), { recursive: true });
    await writeFile(join(state.blocks, "申万行业/电子.txt"), "SH600000\n");
    const reportPath = join(directory, "CLS.md");
    await writeFile(
      reportPath,
      "# 合成报告\n**分析日期**：2026-09-11\n### 电子（方向：偏多 ｜ 信心：高）\n观察行业景气\n",
    );
    await utimes(
      reportPath,
      new Date(before - 120000),
      new Date(before - 120000),
    );
    const store = new ClsReviewStore(db);
    const preview = await previewClsReport(reportPath);
    const report = store.import(preview, preview.report.hash);
    const rps = rpsDay();
    rps.day.date = "2026-09-10";
    rps.day.source.root = state.root;
    new RpsStore(db).saveDay(rps.day, [
      { symbol: "sh600000", values: rps.rows.at(-1)!.values },
    ]);
    const sample = await fixClsSample(report.id);
    expect(sample.selected).toMatchObject({
      symbol: "sh600000",
      basis: "sector-rps",
      direction: "bullish",
    });
    expect(sample.previousTradingDay).toBe("2026-09-10");
    expect(await fixClsSample(report.id)).toEqual(sample);
    const bytes = Buffer.alloc(32);
    bytes.writeUInt32LE(20260911, 0);
    [1000, 1200, 900, 1100].forEach((price, index) =>
      bytes.writeUInt32LE(price, 4 + index * 4),
    );
    bytes.writeFloatLE(110000, 20);
    bytes.writeUInt32LE(10000, 24);
    for (const symbol of ["sh600000", "sh000001"])
      await writeFile(join(state.root, `vipdoc/sh/lday/${symbol}.day`), bytes);
    clock.mockReturnValue(Date.parse("2026-09-11T15:10:00+08:00"));
    const verification = await verifyClsSample(sample.date);
    expect(verification.outcomes[0]).toMatchObject({
      status: "observed",
      hit: true,
      excessReturn: 0,
    });
    expect(verification.outcomes[0]?.grossReturn).toBeCloseTo(0.1);
    expect(verification.outcomes[1]?.status).toBe("pending");
    expect((await verifyClsSample(sample.date)).hash).toBe(verification.hash);
    expect(store.verifications(sample.date)).toHaveLength(1);
    expect(
      await readFile(join(state.root, "vipdoc/sh/lday/sh600000.day")),
    ).toEqual(bytes);
    const nextBar = Buffer.from(bytes);
    nextBar.writeUInt32LE(20260914, 0);
    await writeFile(
      join(state.root, "vipdoc/sh/lday/sh600000.day"),
      Buffer.concat([bytes, nextBar]),
    );
    clock.mockReturnValue(Date.parse("2026-09-14T15:10:00+08:00"));
    const missingBenchmark = await verifyClsSample(sample.date);
    expect(missingBenchmark.outcomes[1]).toMatchObject({
      exitDate: "2026-09-14",
      status: "observed",
      hit: true,
      benchmarkReturn: null,
      excessReturn: null,
    });
    const nextMorning = Date.parse("2026-09-14T09:00:00+08:00");
    clock.mockReturnValue(nextMorning);
    await writeFile(
      reportPath,
      "# 合成报告\n**分析日期**：2026-09-14\n### 电子（方向：偏多 ｜ 信心：高）\n**推荐标的**：sh600000\n",
    );
    await utimes(
      reportPath,
      new Date(nextMorning - 120000),
      new Date(nextMorning - 120000),
    );
    const explicitPreview = await previewClsReport(reportPath);
    const explicitReport = store.import(
      explicitPreview,
      explicitPreview.report.hash,
    );
    state.blocks = join(directory, "nonexistent-blocks");
    const explicitSample = await fixClsSample(explicitReport.id);
    expect(explicitSample.selected).toMatchObject({
      symbol: "sh600000",
      basis: "explicit-recommendation",
      rps: null,
    });
    // g4day 暂停（见 docs/decisions.md WF3）：CLS 校验不再叠加增量，解冻时恢复本段。
    // const incrementId = "cls-increment-fixture";
    // const increment = {
    //   id: incrementId,
    //   date: "2026-09-11",
    //   records: ["sh600000", "sh000001"].map((symbol) => ({
    //     symbol,
    //     bar: {
    //       date: "2026-09-11",
    //       open: 10,
    //       high: 12,
    //       low: 9,
    //       close: 12,
    //       volume: 10000,
    //       amount: 120000,
    //     },
    //   })),
    // };
    // db.prepare("INSERT INTO records VALUES (?,?,?,?)").run(
    //   incrementId,
    //   "tdx-daily-snapshot",
    //   JSON.stringify(increment),
    //   nextMorning,
    // );
    // for (const symbol of ["sh600000", "sh000001"])
    //   db.prepare("INSERT INTO records VALUES (?,?,?,?)").run(
    //     `tdx-daily-current-${symbol}-2026-09-11`,
    //     "tdx-daily-current",
    //     JSON.stringify({ snapshotId: incrementId }),
    //     nextMorning,
    //   );
    // const refreshed = await verifyClsSample(sample.date);
    // expect(refreshed.bars[0]?.close).toBe(12);
    // expect(refreshed.benchmark[0]?.close).toBe(12);
    // expect(refreshed.source.incrementSnapshots).toEqual([incrementId]);
    // expect(refreshed.hash).not.toBe(verification.hash);
    // expect(
    //   store
    //     .verifications(sample.date)
    //     .find((row) => row.hash === verification.hash)?.bars[0]?.close,
    // ).toBe(11);
  } finally {
    clock.mockRestore();
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
