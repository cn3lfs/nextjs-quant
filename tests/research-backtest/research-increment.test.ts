import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { settings, saveSettings } from "../../src/server/infra/settings";
import { sqlite } from "../../src/server/db/index";
import { ResearchStore } from "../../src/server/backtest/research-store";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
import { captureResearchDataset } from "../../src/server/backtest/research-dataset";
import { publishDailyIncrement } from "../../src/server/data-sources/tdx/tdx-daily-cache";

// g4day 暂停（见 docs/decisions.md WF3）：研究数据集不再叠加增量，解冻时去掉 .skip。
it.skip("freezes captured increments and benchmark dates while new research sees a later revision", async () => {
  const root = await mkdtemp(join(tmpdir(), "research-increment-"));
  const directory = join(root, "vipdoc", "sh", "lday");
  await mkdir(directory, { recursive: true });
  const daily = Buffer.alloc(32);
  daily.writeUInt32LE(20260909, 0);
  for (const offset of [4, 8, 12, 16]) daily.writeUInt32LE(1000, offset);
  daily.writeFloatLE(1000, 20);
  daily.writeUInt32LE(100, 24);
  await writeFile(join(directory, "sh600519.day"), daily);
  await writeFile(join(directory, "sh000001.day"), daily);
  const blocks = join(root, "Blocks");
  await mkdir(join(blocks, "中证指数"), { recursive: true });
  await writeFile(
    join(blocks, "中证指数", "中证A500.txt"),
    Array.from(
      { length: 500 },
      (_, i) => `SH${i === 0 ? 600519 : 600000 + i}`,
    ).join("\n"),
  );
  saveSettings({ ...settings(), tdxRoot: root, industryBlocksRoot: blocks });
  const cod = await readFile("tests/fixtures/tdx-daily-increment/sample.cod");
  const md1 = await readFile("tests/fixtures/tdx-daily-increment/sample.md1");
  const stock = publishDailyIncrement({
    market: "sh",
    date: "2026-09-10",
    symbols: ["sh600519"],
    observedAt: 1000,
    cod,
    md1,
  });
  const indexCod = Buffer.from(cod);
  indexCod.write("000001", 0, "ascii");
  publishDailyIncrement({
    market: "sh",
    date: "2026-09-10",
    symbols: ["sh000001"],
    observedAt: 1000,
    cod: indexCod,
    md1,
  });
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    symbols: ["sh600519"],
    start: "2026-09-01",
    end: "2026-09-10",
    validationStart: "2026-09-05",
  });
  const first = await captureResearchDataset(spec);
  expect(first.source).toBe("tdx-local+g4day");
  expect(first.calendar).toEqual(["2026-09-09", "2026-09-10"]);
  expect(first.stocks[0]!.sourceVersions).toEqual([stock.id]);
  const store = new ResearchStore(sqlite());
  const task = store.create(spec, null);
  store.saveDataset(task.id, first);
  const revised = Buffer.from(md1);
  revised.writeDoubleLE(10.5, 512 + 36);
  publishDailyIncrement({
    market: "sh",
    date: "2026-09-10",
    symbols: ["sh600519"],
    observedAt: 2000,
    cod,
    md1: revised,
  });
  const second = await captureResearchDataset(spec);
  expect(second.stocks[0]!.bars.at(-1)!.close).toBe(10.5);
  expect(second.hash).not.toBe(first.hash);
  expect(store.dataset(task.id)?.hash).toBe(first.hash);
  expect(store.dataset(task.id)?.stocks[0]!.bars.at(-1)!.close).toBe(11);
  expect(await readFile(join(directory, "sh600519.day"))).toEqual(daily);
});
