import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { publishDailyIncrement } from "../../../src/server/data-sources/tdx/tdx-daily-cache";
import { localRpsDependencies } from "../../../src/server/screening/rps-job";

// g4day 暂停（见 docs/decisions.md WF3）：RPS 依赖不再叠加增量，解冻时去掉 .skip。
it.skip("uses published increments for RPS bars and reference dates while retaining source evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "rps-increment-source-"));
  const directory = join(root, "vipdoc", "sh", "lday");
  await mkdir(directory, { recursive: true });
  const daily = Buffer.alloc(32);
  daily.writeUInt32LE(20260909, 0);
  for (const offset of [4, 8, 12, 16]) daily.writeUInt32LE(1000, offset);
  daily.writeFloatLE(1000, 20);
  daily.writeUInt32LE(100, 24);
  await writeFile(join(directory, "sh600519.day"), daily);
  await writeFile(join(directory, "sh000001.day"), daily);
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
  const index = publishDailyIncrement({
    market: "sh",
    date: "2026-09-10",
    symbols: ["sh000001"],
    observedAt: 1000,
    cod: indexCod,
    md1,
  });
  const deps = localRpsDependencies(root, []);
  expect((await deps.calendar()).days).toEqual(["2026-09-09", "2026-09-10"]);
  expect((await deps.bars("sh600519")).at(-1)!.close).toBe(11);
  expect(deps.incrementSnapshots?.()).toEqual([stock.id, index.id].sort());
  expect(await readFile(join(directory, "sh600519.day"))).toEqual(daily);
});
