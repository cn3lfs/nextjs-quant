import { Worker } from "node:worker_threads";
import { join, resolve } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { list, sqlite } from "../../src/server/db/index";
import { defaultStrategy } from "../../src/lib/domain";
import { maBaselineInputSchema } from "quant-backtest";
import type { MaBaselineArchive } from "../../src/server/backtest/ma-baseline-work";
import type { ResearchUsage } from "../../src/lib/research/workflow/research-usage";
import { encodeFiveMinuteBar } from "tstdx/local";
import gbbq from "../fixtures/tdx-gbbq.json";

async function run<T>(work: unknown): Promise<T> {
  const worker = new Worker(resolve("runtime/worker.cjs"));
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<T>((resolveResult, reject) => {
      timer = setTimeout(
        () => reject(new Error("worker reply timeout")),
        15000,
      );
      worker.once("error", reject);
      worker.once("exit", (code) =>
        reject(new Error(`worker exited: ${code}`)),
      );
      worker.on(
        "message",
        (message: { result?: T; screenResult?: T; error?: string }) => {
          if (message.error) reject(new Error(message.error));
          if (message.result !== undefined) resolveResult(message.result);
          if (message.screenResult !== undefined)
            resolveResult(message.screenResult);
        },
      );
      worker.postMessage(work);
    });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

it("bundled current backtest records the evaluated window and survives usage-only database failure", async () => {
  const root = join(process.env.QUANT_DATA_DIR!, "worker-source");
  for (const dir of ["vipdoc/sh/fzline", "vipdoc/sh/lday", "T0002/hq_cache"])
    await mkdir(join(root, dir), { recursive: true });
  const dates = ["2026-10-09", "2026-10-12"];
  const bars = dates.flatMap((day, dayIndex) =>
    Array.from({ length: 48 }, (_, index) => {
      const minutes = index < 24 ? 575 + index * 5 : 785 + (index - 24) * 5;
      const time = `${day} ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}:00`;
      return encodeFiveMinuteBar({
        time,
        open: dayIndex ? 10.5 : 10,
        close: dayIndex ? 10.5 : 10,
        high: 11,
        low: 9,
        volume: 100000,
        amount: 1000000,
      });
    }),
  );
  const calendar = dates.map((date) => {
    const row = Buffer.alloc(32);
    row.writeUInt32LE(Number(date.replaceAll("-", "")), 0);
    for (const offset of [4, 8, 12, 16]) row.writeUInt32LE(1000, offset);
    row.writeFloatLE(10000, 20);
    row.writeUInt32LE(1000, 24);
    return row;
  });
  await writeFile(
    join(root, "vipdoc/sh/fzline/sh600000.lc5"),
    Buffer.concat(bars),
  );
  await writeFile(
    join(root, "vipdoc/sh/lday/sh000001.day"),
    Buffer.concat(calendar),
  );
  // Forward-adjusted intraday signals require the corresponding daily factor basis.
  await writeFile(
    join(root, "vipdoc/sh/lday/sh600000.day"),
    Buffer.concat(calendar),
  );
  await writeFile(
    join(root, "T0002/hq_cache/gbbq"),
    Buffer.from(gbbq.gbbqBase64, "base64"),
  );
  const work = {
    type: "ma-baseline",
    root,
    input: maBaselineInputSchema.parse({
      symbol: "sh600000",
      start: "2026-10-12",
      end: "2026-10-12",
    }),
  };
  sqlite();
  const expected = await run<MaBaselineArchive>(work);
  expect(expected.result.evaluated).toBe(48);
  expect(expected.result.fills.length).toBeGreaterThan(0);
  expect(expected.inputSnapshot.bars).toHaveLength(68);
  expect(list<ResearchUsage>("research-usage", 200)).toMatchObject([
    {
      kind: "backtest",
      symbols: [work.input.symbol],
      candidateCount: 1,
      // Warmup is input, not part of the evaluated research window.
      range: { start: work.input.start, end: work.input.end },
    },
  ]);
  sqlite().exec(
    "CREATE TRIGGER reject_usage BEFORE INSERT ON records WHEN NEW.kind='research-usage' BEGIN SELECT RAISE(FAIL, 'usage rejected'); END",
  );
  try {
    const actual = await run<MaBaselineArchive>(work);
    expect(actual.result).toEqual(expected.result);
    expect(actual.inputSnapshot.bars).toEqual(expected.inputSnapshot.bars);
    expect(actual.manifest.dataHash).toBe(expected.manifest.dataHash);
    expect(list("research-usage", 200)).toHaveLength(1);
  } finally {
    sqlite().exec("DROP TRIGGER reject_usage");
  }
});

it("bundled worker rejects the retired screen protocol without writing records", async () => {
  const before = sqlite().prepare("SELECT * FROM records ORDER BY id").all();
  await expect(
    run({
      type: "screen",
      root: join(process.env.QUANT_DATA_DIR!, "retired-screen-source"),
      symbols: [],
      period: "day",
      strategy: defaultStrategy,
    }),
  ).rejects.toThrow("不支持的计算任务类型");
  expect(sqlite().prepare("SELECT * FROM records ORDER BY id").all()).toEqual(
    before,
  );
});

it("bundled worker rejects the retired backtest protocol without writing records", async () => {
  const before = sqlite().prepare("SELECT * FROM records ORDER BY id").all();
  await expect(
    run({
      type: "backtest",
      strategy: defaultStrategy,
      initial: 100000,
      snapshot: {
        id: "retired-worker-fixture",
        symbol: "sh600000",
        source: "fixture",
        period: "day",
        bars: Array.from({ length: 100 }, (_, index) => ({
          date: new Date(Date.UTC(2025, 0, index + 1))
            .toISOString()
            .slice(0, 10),
          open: 100 + index,
          close: 101 + index,
          high: 102 + index,
          low: 99 + index,
          volume: 1000,
          amount: 100000,
        })),
      },
    }),
  ).rejects.toThrow("不支持的计算任务类型");
  expect(sqlite().prepare("SELECT * FROM records ORDER BY id").all()).toEqual(
    before,
  );
});
