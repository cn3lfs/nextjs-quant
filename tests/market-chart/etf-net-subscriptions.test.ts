import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { etfNetSubscriptions } from "../../src/server/market/etf-net-subscriptions";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const day = (offset: number) => {
  const date = new Date(Date.UTC(2026, 8, 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return Number(date.toISOString().slice(0, 10).replaceAll("-", ""));
};
const iso = (offset: number) => {
  const date = new Date(Date.UTC(2026, 8, 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

/** 13-byte SC record: group, YYYYMMDD, two float columns. */
function record(group: number, date: number, scale: number, net: number) {
  const bytes = Buffer.alloc(13);
  bytes[0] = group;
  bytes.writeUInt32LE(date, 1);
  bytes.writeFloatLE(scale, 5);
  bytes.writeFloatLE(net, 9);
  return bytes;
}

/** 32-byte daily bar: date, OHLC (fen), amount, volume. */
function bar(date: number, close: number) {
  const bytes = Buffer.alloc(32);
  const price = Math.round(close * 100);
  bytes.writeUInt32LE(date, 0);
  for (const offset of [4, 8, 12, 16]) bytes.writeUInt32LE(price, offset);
  bytes.writeFloatLE(1e8, 20);
  bytes.writeUInt32LE(1000, 24);
  return bytes;
}

async function rootWith({
  records,
  bars,
}: {
  records: Buffer[];
  bars?: Buffer[];
}) {
  const root = await mkdtemp(join(tmpdir(), "quant-etf-net-"));
  roots.push(root);
  await mkdir(join(root, "vipdoc/cw"), { recursive: true });
  await writeFile(
    join(root, "vipdoc/cw/gpsh999999.dat"),
    Buffer.concat(records),
  );
  if (bars) {
    await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
    await writeFile(
      join(root, "vipdoc/sh/lday/sh000001.day"),
      Buffer.concat(bars),
    );
  }
  return root;
}

describe("通达信本地 ETF 全市场日度净申赎", () => {
  it("按北京时间截止，最多取最近 60 个记录日，源覆盖不被截断", async () => {
    const records: Buffer[] = [];
    for (let index = 0; index < 65; index++)
      records.push(record(38, day(index), 1000 + index, index + 0.5));
    // 截止日之后的记录不参与，但仍计入源整体范围。
    records.push(record(38, day(80), 9999, 888));
    const root = await rootWith({ records });

    const data = await etfNetSubscriptions(root, iso(64));

    expect(data.state).toBe("ok");
    expect(data.requestedDate).toBe(iso(64));
    expect(data.points).toHaveLength(60);
    expect(data.window).toEqual({ start: iso(5), end: iso(64), count: 60 });
    expect(data.latest).toBe(iso(64));
    expect(data.points.at(-1)).toEqual({
      date: iso(64),
      net: 64.5,
      index: null,
    });
    expect(data.points.every((point) => point.date <= iso(64))).toBe(true);
    expect(data.sourceFirst).toBe(iso(0));
    expect(data.sourceLast).toBe(iso(80));
  });

  it("缺失不补零、同日重复按缺失报告，真实 0 与负数有效", async () => {
    const root = await rootWith({
      records: [
        record(38, day(0), 5000, 12.5),
        record(38, day(1), 5000, 0),
        record(38, day(2), 5000, -8.25),
        record(38, day(3), 5000, 3),
        record(38, day(3), 5000, 99),
        record(38, day(5), 5000, 4),
        // 无日期记录不能落到任何一天，也不补造日期。
        record(38, 0, 5000, 777),
      ],
    });

    const data = await etfNetSubscriptions(root, iso(5));

    expect(data.points.map((point) => point.date)).toEqual([
      iso(0),
      iso(1),
      iso(2),
      iso(3),
      iso(5),
    ]);
    expect(data.points.map((point) => point.net)).toEqual([
      12.5,
      0,
      -8.25,
      null,
      4,
    ]);
    expect(data.duplicates).toEqual([{ date: iso(3), count: 2 }]);
    expect(data.summary).toEqual({ total: null, valid: 4, complete: false });
  });

  it("仅 60 个记录日全部有效才给出区间合计", async () => {
    const complete: Buffer[] = [];
    for (let index = 0; index < 60; index++)
      complete.push(record(38, day(index), 1000, 1.5));
    const completeRoot = await rootWith({ records: complete });
    const completeData = await etfNetSubscriptions(completeRoot, iso(59));
    expect(completeData.summary.complete).toBe(true);
    expect(completeData.summary.valid).toBe(60);
    expect(completeData.summary.total).toBeCloseTo(90, 6);

    const missing: Buffer[] = [];
    for (let index = 0; index < 60; index++)
      if (index !== 10) missing.push(record(38, day(index), 1000, 1.5));
    const missingRoot = await rootWith({ records: missing });
    const missingData = await etfNetSubscriptions(missingRoot, iso(59));
    expect(missingData.window!.count).toBe(59);
    expect(missingData.summary).toEqual({
      total: null,
      valid: 59,
      complete: false,
    });
  });

  it("上证指数只取精确同日收盘，不跨日填补也不回退网络", async () => {
    const root = await rootWith({
      records: [0, 1, 2, 3].map((offset) =>
        record(38, day(offset), 1000, offset),
      ),
      bars: [
        // 窗口前、窗口中与窗口后各一条；只映射落在记录日上的精确日期。
        bar(day(-1), 3400),
        bar(day(0), 3500),
        bar(day(2), 3520),
        bar(day(9), 3600),
      ],
    });

    const data = await etfNetSubscriptions(root, iso(3));

    expect(data.index).toMatchObject({
      state: "ok",
      matched: 2,
      sourceLast: iso(9),
      warning: null,
    });
    expect(data.points).toEqual([
      { date: iso(0), net: 0, index: 3500 },
      { date: iso(1), net: 1, index: null },
      { date: iso(2), net: 2, index: 3520 },
      { date: iso(3), net: 3, index: null },
    ]);
  });

  it("指数读取失败只降级指数，申赎明细与合计照常", async () => {
    const records: Buffer[] = [];
    for (let index = 0; index < 60; index++)
      records.push(record(38, day(index), 1000, 2));
    const root = await rootWith({ records });

    const data = await etfNetSubscriptions(root, iso(59));

    expect(data.state).toBe("ok");
    expect(data.index).toMatchObject({
      state: "unavailable",
      matched: 0,
      sourceLast: null,
    });
    expect(data.index.warning).toContain("仅显示净申赎");
    expect(data.points.every((point) => point.index === null)).toBe(true);
    expect(data.summary.total).toBeCloseTo(120, 6);
  });

  it("未配置、缺文件与截止日早于源起点分别可辨识", async () => {
    expect((await etfNetSubscriptions("", iso(0))).state).toBe(
      "source-unconfigured",
    );

    const empty = await mkdtemp(join(tmpdir(), "quant-etf-net-empty-"));
    roots.push(empty);
    await mkdir(join(empty, "vipdoc/cw"), { recursive: true });
    const missing = await etfNetSubscriptions(empty, iso(0));
    expect(missing.state).toBe("no-history");
    expect(missing.points).toEqual([]);

    const root = await rootWith({ records: [record(38, day(5), 1000, 1)] });
    const early = await etfNetSubscriptions(root, iso(4));
    expect(early.state).toBe("no-history");
    expect(early.sourceFirst).toBe(iso(5));
    expect(early.sourceLast).toBe(iso(5));
    expect(early.points).toEqual([]);
  });
});
