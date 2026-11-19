import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { marketBreadth } from "../../src/server/market/market-breadth";

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
  const root = await mkdtemp(join(tmpdir(), "quant-market-breadth-"));
  roots.push(root);
  await mkdir(join(root, "vipdoc/cw"), { recursive: true });
  await writeFile(
    join(root, "vipdoc/cw/gpsh999999.dat"),
    Buffer.concat(records),
  );
  return root;
}

describe("通达信本地市场涨跌家数", () => {
  it("采用不晚于北京时间截止日的最新 SC31 记录，两列来自同一条记录", async () => {
    const root = await rootWith([
      record(31, 20261116, 1000, 3000),
      record(31, 20261117, 1325, 4119),
      record(31, 20261118, 9, 9),
    ]);

    const data = await marketBreadth(root, "2026-11-17");

    expect(data.state).toBe("ok");
    expect(data.date).toBe("2026-11-17");
    expect(data.up).toBe(1325);
    expect(data.down).toBe(4119);
    expect(data.upUnknown).toBeNull();
    expect(data.downUnknown).toBeNull();
    expect(data.duplicates).toEqual([]);
    expect(data.sourceFirst).toBe("2026-11-16");
    expect(data.sourceLast).toBe("2026-11-18");
    expect(data.requestedDate).toBe("2026-11-17");
  });

  it("截止日没有当日记录时仍取之前最新一条，不跳到未来记录", async () => {
    const root = await rootWith([
      record(31, 20261113, 765, 4748),
      record(31, 20261116, 1136, 4344),
      record(31, 20261117, 1325, 4119),
    ]);

    const data = await marketBreadth(root, "2026-11-19");

    expect(data.state).toBe("ok");
    expect(data.date).toBe("2026-11-17");
    expect(data.up).toBe(1325);
    expect(data.down).toBe(4119);
    expect(data.sourceLast).toBe("2026-11-17");
  });

  it("真实 0 家保留为数值，负数与非整数只把该列标为未知", async () => {
    const zero = await marketBreadth(
      await rootWith([record(31, 20261116, 0, 12)]),
      "2026-11-16",
    );
    expect(zero.up).toBe(0);
    expect(zero.down).toBe(12);
    expect(zero.upUnknown).toBeNull();

    const invalid = await marketBreadth(
      await rootWith([record(31, 20261117, -1, 3.5)]),
      "2026-11-17",
    );
    expect(invalid.up).toBeNull();
    expect(invalid.down).toBeNull();
    expect(invalid.upUnknown).toBe("invalid");
    expect(invalid.downUnknown).toBe("invalid");
  });

  it("所选日同日重复不挑选其中一条，保留日期并显式报告重复", async () => {
    const root = await rootWith([
      record(31, 20261116, 1000, 3000),
      record(31, 20261117, 1325, 4119),
      record(31, 20261117, 1, 2),
    ]);

    const data = await marketBreadth(root, "2026-11-17");

    expect(data.state).toBe("ok");
    expect(data.date).toBe("2026-11-17");
    expect(data.up).toBeNull();
    expect(data.down).toBeNull();
    expect(data.upUnknown).toBe("duplicate");
    expect(data.downUnknown).toBe("duplicate");
    expect(data.duplicates).toEqual([{ date: "2026-11-17", count: 2 }]);
  });

  it("未配置、缺文件与截止日前无记录分别可辨识", async () => {
    const unconfigured = await marketBreadth("", "2026-11-17");
    expect(unconfigured.state).toBe("source-unconfigured");
    expect(unconfigured.up).toBeNull();

    const empty = await mkdtemp(join(tmpdir(), "quant-market-breadth-empty-"));
    roots.push(empty);
    await mkdir(join(empty, "vipdoc/cw"), { recursive: true });
    const missing = await marketBreadth(empty, "2026-11-17");
    expect(missing.state).toBe("no-record");
    expect(missing.warning).toContain("未找到");

    const early = await marketBreadth(
      await rootWith([record(31, 20261117, 1325, 4119)]),
      "2026-11-16",
    );
    expect(early.state).toBe("no-record");
    expect(early.date).toBeNull();
    expect(early.sourceFirst).toBe("2026-11-17");
    expect(early.sourceLast).toBe("2026-11-17");
    expect(early.warning).toContain("所选截止日及之前没有记录");
  });

  it("忽略其他组号，不把 SC3/SC4 或非 SC31 记录当市场宽度", async () => {
    const root = await rootWith([
      record(3, 20261117, 42, 0),
      record(4, 20261117, 40, 0),
      record(31, 20261116, 1000, 3000),
    ]);

    const data = await marketBreadth(root, "2026-11-17");

    expect(data.state).toBe("ok");
    expect(data.date).toBe("2026-11-16");
    expect(data.up).toBe(1000);
    expect(data.down).toBe(3000);
  });
});
