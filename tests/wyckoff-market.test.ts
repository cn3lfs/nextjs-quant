import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { Snapshot } from "~/lib/domain";
import {
  gatherWyckoffMarket,
  wyckoffMarketForReport,
} from "~/server/strategies/wyckoff/wyckoff-market";
import { wyckoffFrames } from "~/server/strategies/wyckoff/wyckoff-frames";
const stock: Snapshot = {
  id: "s",
  symbol: "sh600519",
  source: "fixture",
  hash: "unused",
  period: "day",
  adjustment: "none",
  createdAt: 1,
  bars: ["2026-09-01", "2026-09-02", "2026-09-03"].map((date, i) => ({
    date,
    open: 100 + i * 10,
    high: 100 + i * 10,
    low: 100 + i * 10,
    close: 100 + i * 10,
    volume: 1,
    amount: 100,
  })),
};
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "quant-wyckoff-index-"));
  await mkdir(join(root, "vipdoc", "sh", "lday"), { recursive: true });
  const path = join(root, "vipdoc", "sh", "lday", "sh000300.day");
  const bytes = Buffer.alloc(96);
  for (let i = 0; i < 3; i++) {
    bytes.writeUInt32LE(20260901 + i, i * 32);
    for (const offset of [4, 8, 12, 16])
      bytes.writeUInt32LE(10000 + i * 500, i * 32 + offset);
    bytes.writeFloatLE(100, i * 32 + 20);
    bytes.writeUInt32LE(1, i * 32 + 24);
  }
  await writeFile(path, bytes);
  return { root, path, bytes };
}
it("reads an immutable local index and computes the selected historical window", async () => {
  const { root, path, bytes } = await fixture();
  const result = await gatherWyckoffMarket(
    { ...stock, historicalAsOf: "2026-09-02" },
    root,
    Date.parse("2026-09-04T16:00:00+08:00"),
  );
  expect(result.benchmark.bars).toHaveLength(2);
  expect(result.relativeStrength.rows.at(-1)!.rs).toBeCloseTo(104.76190476);
  expect(result.rawHash).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(result.industry.status).toBe("missing");
  expect(await readFile(path)).toEqual(bytes);
});
it("preserves missing-date diagnostics and rejects malformed index files", async () => {
  const { root, path, bytes } = await fixture();
  await writeFile(
    path,
    Buffer.concat([bytes.subarray(0, 32), bytes.subarray(64)]),
  );
  const result = await gatherWyckoffMarket(
    stock,
    root,
    Date.parse("2026-09-04T16:00:00+08:00"),
  );
  expect(result.relativeStrength.status).toBe("missing");
  expect(result.relativeStrength.missingBenchmarkDates).toEqual(["2026-09-02"]);
  await writeFile(path, bytes.subarray(0, 95));
  await expect(gatherWyckoffMarket(stock, root, Date.now())).rejects.toThrow(
    "长度",
  );
});
it("rechecks ratios against report frames and ignores acquisition time for stable evidence", async () => {
  const { root } = await fixture();
  const now = Date.parse("2026-09-04T16:00:00+08:00");
  const market = await gatherWyckoffMarket(stock, root, now);
  const frames = wyckoffFrames(
    stock,
    null,
    { days: stock.bars.map((b) => b.date), source: "fixture", hash: "h" },
    now,
  );
  const first = wyckoffMarketForReport(market, frames);
  expect(
    wyckoffMarketForReport(
      { ...market, benchmark: { ...market.benchmark, createdAt: now + 1000 } },
      frames,
    ),
  ).toEqual(first);
  market.relativeStrength.rows[1]!.rs++;
  expect(() => wyckoffMarketForReport(market, frames)).toThrow("不一致");
});
