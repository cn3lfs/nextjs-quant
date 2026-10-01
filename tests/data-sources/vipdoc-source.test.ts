import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import samples from "../fixtures/vipdoc-source-samples.json";
import {
  isLocalFund,
  readTailSnapshot,
  parseBars,
} from "../../src/server/data-sources/tdx/tdx";
import { readVipdocChart as readSnapshot } from "../../src/server/data-sources/tdx/vipdoc-adapter";

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
it("精度不可猜测，重复日期剔除后一根", () => {
  const row = Buffer.from(samples[0]!.hex, "hex").subarray(0, 32);
  expect(() => parseBars(row, "day", 2026, 4)).toThrow("精度");
  const repairs = { fixed: 0, dropped: 0 };
  expect(
    parseBars(Buffer.concat([row, row]), "day", 2026, 3, repairs),
  ).toHaveLength(1);
  expect(repairs.dropped).toBe(1);
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

// Real case: TDX's own sh000001.day has 1991-05-09 close 109.29 below low
// 109.31. One dirty record used to void the whole file.
it("日线脏记录自动纠错：小偏差扩展高低价，无效/离谱/倒序记录剔除，并给出说明", async () => {
  const root = await mkdtemp(join(tmpdir(), "vipdoc-repair-"));
  try {
    const record = (date: number, [o, h, l, c]: number[]) => {
      const b = Buffer.alloc(32);
      b.writeUInt32LE(date, 0);
      [o, h, l, c].forEach((v, k) => b.writeUInt32LE(v!, 4 + 4 * k));
      b.writeFloatLE(1e6, 20);
      b.writeUInt32LE(1000, 24);
      return b;
    };
    const ok = [10000, 10100, 9900, 10050];
    const bytes = Buffer.concat([
      record(20200102, ok),
      record(20200103, [10936, 11012, 10931, 10929]), // close 2 cents below low
      record(20200106, [0, 10100, 9900, 10050]), // zero open
      record(20200107, [10000, 10100, 9900, 99999999]), // garbage close
      record(20200107, ok), // same date as the dropped garbage: kept
      record(20200108, ok),
      record(20200108, ok), // duplicate date
    ]);
    const repairs = { fixed: 0, dropped: 0 };
    const bars = parseBars(bytes, "day", undefined, 2, repairs);
    expect(bars.map((b) => b.date)).toEqual([
      "2020-01-02",
      "2020-01-03",
      "2020-01-07",
      "2020-01-08",
    ]);
    expect(bars[1]).toMatchObject({ high: 110.12, low: 109.29, close: 109.29 });
    expect(repairs).toEqual({ fixed: 1, dropped: 3 });
    const dir = join(root, "vipdoc/sh/lday");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "sh000001.day"), bytes);
    const chart = await readSnapshot(root, "sh000001", "day");
    expect(chart.bars).toHaveLength(4);
    expect(chart.sourceNote).toBe(
      "本地数据自动纠错：修正 1 根（开收价超出高低价，已扩展高低价），剔除 3 根（价格/日期无效或时间重复）；源文件未修改",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
