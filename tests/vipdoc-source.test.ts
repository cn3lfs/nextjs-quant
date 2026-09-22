import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import samples from "./fixtures/vipdoc-source-samples.json";
import {
  isLocalFund,
  readTailSnapshot,
  parseBars,
} from "../src/server/data-sources/tdx/tdx";
import { readVipdocChart as readSnapshot } from "../src/server/data-sources/tdx/vipdoc-adapter";

it("本地 ETF 日线按三位精度读取，分钟浮点价格不缩放，研究证券池不扩展", async () => {
  const root = await mkdtemp(join(tmpdir(), "vipdoc-source-"));
  try {
    for (const sample of samples) {
      const daily = sample.period === "day";
      const dir = join(
        root,
        "vipdoc",
        sample.symbol.slice(0, 2),
        daily ? "lday" : "fzline",
      );
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, `${sample.symbol}.${daily ? "day" : "lc5"}`),
        Buffer.from(sample.hex, "hex"),
      );
      const snapshot = await readSnapshot(
        root,
        sample.symbol,
        daily ? "day" : "5m",
      );
      expect(snapshot.source).toBe("tdx-local");
      expect(snapshot.bars).toHaveLength(3);
      if (daily)
        expect(snapshot.bars.at(-1)!.close).toBe(
          (
            {
              sh510300: 4.579,
              sz159915: 3.341,
              sh600000: 9.26,
              sh000001: 3888.11,
            } as Record<string, number>
          )[sample.symbol],
        );
      else {
        expect(snapshot.bars.at(-1)!.date).toBe("2022-11-30T15:00:00+08:00");
        if (sample.symbol === "sh510300")
          expect(snapshot.bars.at(-1)!.close).toBeCloseTo(3.912, 5);
      }
    }
    await expect(readTailSnapshot(root, "sh510300", "day", 3)).rejects.toThrow(
      "仅支持 A 股",
    );
    await expect(readSnapshot(root, "bj920002", "5m")).rejects.toThrow();
    const file = join(root, "vipdoc/sh/lday/sh510300.day");
    await writeFile(file, Buffer.alloc(31));
    await expect(readSnapshot(root, "sh510300", "day")).rejects.toThrow(
      "不完整",
    );
    await writeFile(file, Buffer.alloc(0));
    await expect(readSnapshot(root, "sh510300", "day")).rejects.toThrow("为空");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("精度不可猜测，重复日期仍拒绝", () => {
  const row = Buffer.from(samples[0]!.hex, "hex").subarray(0, 32);
  expect(() => parseBars(row, "day", 2026, 4)).toThrow("精度");
  expect(() => parseBars(Buffer.concat([row, row]), "day", 2026, 3)).toThrow(
    "重复",
  );
});
it("本地通达信三位精度基金覆盖已观察的上海代码族", () => {
  for (const symbol of [
    "sh500001",
    "sh510300",
    "sh520500",
    "sh530000",
    "sh560000",
    "sh588000",
    "sz159915",
    "sz161725",
  ])
    expect(isLocalFund(symbol)).toBe(true);
  expect(isLocalFund("sh540000")).toBe(false);
  expect(isLocalFund("sh590000")).toBe(false);
});
