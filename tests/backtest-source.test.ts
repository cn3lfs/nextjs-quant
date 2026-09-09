import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTailSnapshot, readHistoricalSnapshot } from "../src/server/tdx";
import { fullBacktestSource } from "../src/server/backtest-source";
function bytes(count: number) {
  const data = Buffer.alloc(count * 32);
  for (let i = 0; i < count; i++) {
    const at = i * 32;
    data.writeUInt32LE(
      Number(
        new Date(Date.UTC(2024, 0, i + 1))
          .toISOString()
          .slice(0, 10)
          .replaceAll("-", ""),
      ),
      at,
    );
    [1000 + i, 1100 + i, 900 + i, 1050 + i].forEach((value, index) =>
      data.writeUInt32LE(value, at + 4 + index * 4),
    );
    data.writeFloatLE(10000, at + 20);
    data.writeUInt32LE(1000, at + 24);
  }
  return data;
}
it("full backtest expands a short research window, preserves its cutoff and rejects revisions", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-backtest-source-")),
    directory = join(root, "vipdoc", "sh", "lday");
  await mkdir(directory, { recursive: true });
  const path = join(directory, "sh600519.day");
  await writeFile(path, bytes(500));
  const selected = await readTailSnapshot(root, "sh600519", "day", 300);
  expect(selected.bars).toHaveLength(300);
  await writeFile(path, bytes(510));
  const full = await fullBacktestSource(selected, "invalid-new-settings-root");
  expect(full.bars).toHaveLength(500);
  expect(full.bars.at(-1)?.date).toBe(selected.bars.at(-1)?.date);
  expect(full.id).not.toBe(selected.id);
  const revised = bytes(510);
  revised.writeUInt32LE(1551, 499 * 32 + 16);
  await writeFile(path, revised);
  await expect(fullBacktestSource(selected, root)).rejects.toThrow(
    "修订或缺失",
  );
  await expect(
    fullBacktestSource({ ...selected, source: "tdx-mcp" }, root),
  ).rejects.toThrow("本地行情");
});
it("historical backtest expands only before the historical selected endpoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "quant-backtest-history-")),
    directory = join(root, "vipdoc", "sh", "lday");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "sh600519.day"), bytes(600));
  const selected = await readHistoricalSnapshot(
    root,
    "sh600519",
    "day",
    60,
    "2024-12-31",
  );
  const full = await fullBacktestSource(selected, root);
  expect(selected.bars).toHaveLength(60);
  expect(full.bars).toHaveLength(366);
  expect(full.historicalAsOf).toBe("2024-12-31");
  expect(full.bars.at(-1)?.date).toBe("2024-12-31");
});
