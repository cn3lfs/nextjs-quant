import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { limitHistory } from "../../src/server/market/limit-history";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

/** 13-byte SC record: group, YYYYMMDD, two float columns. */
function record(group: number, date: number, first: number, second = 0) {
  const bytes = Buffer.alloc(13);
  bytes[0] = group;
  bytes.writeUInt32LE(date, 1);
  bytes.writeFloatLE(first, 5);
  bytes.writeFloatLE(second, 9);
  return bytes;
}

async function rootWith(records: Buffer[]) {
  const root = await mkdtemp(join(tmpdir(), "quant-limit-history-"));
  roots.push(root);
  await mkdir(join(root, "vipdoc/cw"), { recursive: true });
  await writeFile(
    join(root, "vipdoc/cw/gpsh999999.dat"),
    Buffer.concat(records),
  );
  return root;
}

const day = (offset: number) => {
  const date = new Date(Date.UTC(2026, 0, 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return Number(date.toISOString().slice(0, 10).replaceAll("-", ""));
};
const iso = (offset: number) => {
  const date = new Date(Date.UTC(2026, 0, 1));
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
};

describe("通达信本地涨跌停按日复盘", () => {
  it("按所选日截止，两序列日期并集正序，真实0保留、缺记录明确缺失", async () => {
    const root = await rootWith([
      record(3, 20261110, 10),
      record(3, 20261111, 0),
      record(3, 20261112, 12),
      record(3, 20261113, 13),
      record(3, 20261118, 42),
      record(4, 20261110, 5),
      record(4, 20261112, 2),
      record(4, 20261118, 40),
    ]);

    const data = await limitHistory(root, "2026-11-12");

    expect(data.state).toBe("ok");
    expect(data.points.map((point) => point.date)).toEqual([
      "2026-11-10",
      "2026-11-11",
      "2026-11-12",
    ]);
    expect(data.points).toEqual([
      { date: "2026-11-10", limitUp: 10, limitDown: 5 },
      { date: "2026-11-11", limitUp: 0, limitDown: null },
      { date: "2026-11-12", limitUp: 12, limitDown: 2 },
    ]);
    expect(data.points.every((point) => point.date <= "2026-11-12")).toBe(true);
    expect(data.latest).toBe("2026-11-12");
    expect(data.window).toEqual({
      start: "2026-11-10",
      end: "2026-11-12",
      count: 3,
    });
    // 源覆盖范围不被所选日截断，供界面说明截至日。
    expect(data.sourceFirst).toBe("2026-11-10");
    expect(data.sourceLast).toBe("2026-11-18");
    expect(data.duplicates).toEqual([]);
  });

  it("同组同日重复不挑选一条，对应值设为缺失并报告", async () => {
    const root = await rootWith([
      record(3, 20261112, 12),
      record(3, 20261112, 99),
      record(4, 20261112, 2),
    ]);

    const data = await limitHistory(root, "2026-11-12");

    expect(data.state).toBe("ok");
    expect(data.points).toEqual([
      { date: "2026-11-12", limitUp: null, limitDown: 2 },
    ]);
    expect(data.duplicates).toEqual([
      { group: 3, field: "limitUp", date: "2026-11-12", count: 2 },
    ]);
  });

  it("单条负数或非整数家数不当有效值，源值按缺失处理", async () => {
    const root = await rootWith([
      record(3, 20261110, -1),
      record(3, 20261111, 3.5),
      record(4, 20261110, 2),
    ]);

    const data = await limitHistory(root, "2026-11-11");

    expect(
      data.points.find((point) => point.date === "2026-11-10")?.limitUp,
    ).toBeNull();
    expect(
      data.points.find((point) => point.date === "2026-11-11")?.limitUp,
    ).toBeNull();
  });

  it("最多显示所选日及之前最近60个记录日，窗口起点随之后移", async () => {
    const records: Buffer[] = [];
    for (let index = 0; index < 70; index++) {
      records.push(
        record(3, day(index), index),
        record(4, day(index), 70 - index),
      );
    }
    const root = await rootWith(records);

    const data = await limitHistory(root, iso(100));

    expect(data.state).toBe("ok");
    expect(data.points).toHaveLength(60);
    expect(data.window).toEqual({
      start: iso(10),
      end: iso(69),
      count: 60,
    });
    expect(data.points[0]).toEqual({
      date: iso(10),
      limitUp: 10,
      limitDown: 60,
    });
    expect(data.points.at(-1)).toEqual({
      date: iso(69),
      limitUp: 69,
      limitDown: 1,
    });
    expect(
      data.points.every(
        (point, index) =>
          index === 0 || point.date > data.points[index - 1]!.date,
      ),
    ).toBe(true);
  });

  it("未配置、缺文件与所选日早于源起点分别可辨识", async () => {
    expect((await limitHistory("", "2026-11-12")).state).toBe(
      "source-unconfigured",
    );

    const empty = await mkdtemp(join(tmpdir(), "quant-limit-history-empty-"));
    roots.push(empty);
    await mkdir(join(empty, "vipdoc/cw"), { recursive: true });
    const missing = await limitHistory(empty, "2026-11-12");
    expect(missing.state).toBe("no-history");
    expect(missing.points).toEqual([]);

    const root = await rootWith([
      record(3, 20261110, 10),
      record(4, 20261110, 5),
    ]);
    const early = await limitHistory(root, "2026-11-09");
    expect(early.state).toBe("no-history");
    expect(early.sourceFirst).toBe("2026-11-10");
    expect(early.sourceLast).toBe("2026-11-10");
    expect(early.points).toEqual([]);
  });
});

describe("通达信本地 SC31 涨跌家数按日复盘", () => {
  it("按查询日截断 SC31，取最近 60 个记录日并独立于 SC3/SC4 对齐", async () => {
    const records: Buffer[] = [];
    for (let index = 69; index >= 0; index--)
      records.push(record(31, day(index * 2), index, 100 - index));
    records.push(record(3, day(121), 12), record(4, day(121), 2));
    const root = await rootWith(records);

    const data = await limitHistory(root, iso(121));

    expect(data.latest).toBe(iso(121));
    expect(data.points).toEqual([
      { date: iso(121), limitUp: 12, limitDown: 2 },
    ]);
    expect(data.breadth).toMatchObject({
      state: "ok",
      sourceFirst: iso(0),
      sourceLast: iso(138),
      latest: iso(120),
      window: { start: iso(2), end: iso(120), count: 60 },
      duplicates: [],
    });
    expect(data.breadth.points).toEqual(
      Array.from({ length: 60 }, (_, index) => ({
        date: iso((index + 1) * 2),
        up: index + 1,
        down: 99 - index,
      })),
    );
  });

  it("SC31 整行重复时两列均缺失，SC3/SC4 同日数值仍有效", async () => {
    const root = await rootWith([
      record(31, 20261112, 0, 2800),
      record(31, 20261112, 1700, 0),
      record(31, 20261113, 1800, 2900),
      record(3, 20261112, 12),
      record(4, 20261112, 2),
    ]);

    const data = await limitHistory(root, "2026-11-13");

    expect(data.breadth.latest).toBe("2026-11-13");
    expect(data.latest).toBe("2026-11-12");
    expect(data.breadth.points).toEqual([
      { date: "2026-11-12", up: null, down: null },
      { date: "2026-11-13", up: 1800, down: 2900 },
    ]);
    expect(data.breadth.duplicates).toEqual([{ date: "2026-11-12", count: 2 }]);
    expect(data.points).toEqual([
      { date: "2026-11-12", limitUp: 12, limitDown: 2 },
    ]);
    expect(data.duplicates).toEqual([]);
  });

  it("保留 SC31 两列的真实 0，逐列识别负数及非整数", async () => {
    const root = await rootWith([
      record(31, 20261110, 0, -1),
      record(31, 20261111, 3.5, 0),
      record(31, 20261112, -2, 5.5),
    ]);

    const data = await limitHistory(root, "2026-11-12");

    expect(data.state).toBe("no-history");
    expect(data.breadth.state).toBe("ok");
    expect(data.breadth.points).toEqual([
      { date: "2026-11-10", up: 0, down: null },
      { date: "2026-11-11", up: null, down: 0 },
      { date: "2026-11-12", up: null, down: null },
    ]);
    expect(data.breadth.duplicates).toEqual([]);
  });

  it("缺少 SC31 时仅涨跌家数无历史，SC3/SC4 继续返回", async () => {
    const root = await rootWith([
      record(3, 20261112, 12),
      record(4, 20261112, 2),
    ]);

    const data = await limitHistory(root, "2026-11-12");

    expect(data.state).toBe("ok");
    expect(data.points).toEqual([
      { date: "2026-11-12", limitUp: 12, limitDown: 2 },
    ]);
    expect(data.breadth).toMatchObject({
      state: "no-history",
      latest: null,
      sourceFirst: null,
      sourceLast: null,
      window: null,
      points: [],
      duplicates: [],
    });
  });
});
