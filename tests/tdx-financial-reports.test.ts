import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  financialReportDirectory,
  resolveFinanceReportPeriod,
} from "../src/server/data-sources/tdx/tdx-financial-reports";

/**
 * 合成一个通达信财务包：20 字节包头 + 每条 11 字节索引 + 每条 fieldCount 个 float。
 * 字段下标 39/73/95 是实现用于定位报告期的三个金额，其余填 0。
 */
const fieldCount = 120;
function buildReport(
  reportDate: number,
  records: {
    code: string;
    totalAssets: number;
    revenue: number;
    profit: number;
  }[],
) {
  const fieldBytes = fieldCount * 4;
  const header = Buffer.alloc(20);
  header.writeInt16LE(1, 0);
  header.writeUInt32LE(reportDate, 2);
  header.writeUInt16LE(records.length, 6);
  header.writeUInt32LE(fieldBytes, 12);
  const indexBytes = records.length * 11;
  const table = Buffer.alloc(indexBytes);
  const bodies: Buffer[] = [];
  records.forEach((record, i) => {
    const offset = 20 + indexBytes + i * fieldBytes;
    table.write(record.code, i * 11, 6, "ascii");
    table.writeUInt8(1, i * 11 + 6);
    table.writeUInt32LE(offset, i * 11 + 7);
    const values = Buffer.alloc(fieldBytes);
    values.writeFloatLE(record.totalAssets, 39 * 4);
    values.writeFloatLE(record.revenue, 73 * 4);
    values.writeFloatLE(record.profit, 95 * 4);
    bodies.push(values);
  });
  return Buffer.concat([header, table, ...bodies]);
}

// float32 只保留约 7 位有效数字，这里用能被 float32 精确表示的数避免噪声。
const june = {
  code: "600519",
  totalAssets: 3.0905078e11,
  revenue: 9.0703264e10,
  profit: 4.451688e10,
};
const march = {
  code: "600519",
  totalAssets: 1.5e11,
  revenue: 4.5e10,
  profit: 2.2e10,
};
const other = {
  code: "000001",
  totalAssets: 6.028785e12,
  revenue: 7.0617e10,
  profit: 2.5696e10,
};
const blank = { code: "300999", totalAssets: 0, revenue: 0, profit: 0 };

const roots: string[] = [];
async function makeRoot(files: Record<string, Buffer>) {
  const root = await mkdtemp(join(tmpdir(), "quant-gpcw-"));
  roots.push(root);
  await mkdir(financialReportDirectory(root), { recursive: true });
  for (const [name, body] of Object.entries(files))
    await writeFile(join(financialReportDirectory(root), name), body);
  return root;
}
afterAll(async () => {
  // 每个用例自己建的临时根目录在这里统一删除；失败不掩盖测试结果。
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

describe("报告期反查", () => {
  it("用三个金额把快照唯一定位到某一期，并带出来源文件", async () => {
    const root = await makeRoot({
      "gpcw20260331.dat": buildReport(20260331, [march, other]),
      "gpcw20260630.dat": buildReport(20260630, [june, other]),
    });
    const result = await resolveFinanceReportPeriod(root, "sh600519", {
      totalAssets: june.totalAssets,
      mainRevenue: june.revenue,
      netProfit: june.profit,
    });
    expect(result.reason).toBeNull();
    expect(result.period).toEqual({
      reportDate: "2026-06-30",
      sourceFilename: "gpcw20260630.dat",
      sourceSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(result.searched).toEqual(["2026-06-30", "2026-03-31"]);
  });
  it("只要有一个金额对不上就不认这一期", async () => {
    const root = await makeRoot({
      "gpcw20260630.dat": buildReport(20260630, [june]),
    });
    const result = await resolveFinanceReportPeriod(root, "sh600519", {
      totalAssets: june.totalAssets,
      mainRevenue: june.revenue,
      netProfit: june.profit * 10, // 修复前的 10 倍口径
    });
    expect(result.period).toBeNull();
    expect(result.reason).toContain("没有与该快照一致的记录");
  });
  it("命中多期时留空并说明，不挑最近一期充数", async () => {
    const root = await makeRoot({
      "gpcw20260331.dat": buildReport(20260331, [blank]),
      "gpcw20260630.dat": buildReport(20260630, [blank]),
    });
    const result = await resolveFinanceReportPeriod(root, "sz300999", {
      totalAssets: 0,
      mainRevenue: 0,
      netProfit: 0,
    });
    expect(result.period).toBeNull();
    expect(result.reason).toContain("同时匹配 2026-06-30、2026-03-31");
  });
  it("损坏或未来期占位包被跳过并如实报告，不让整次判定失败", async () => {
    const broken = Buffer.alloc(20);
    broken.writeInt16LE(1, 0);
    broken.writeUInt32LE(20260930, 2);
    broken.writeUInt16LE(1, 6);
    broken.writeUInt32LE(4096 * 4 + 4, 12); // 字段数超限
    const root = await makeRoot({
      "gpcw20260630.dat": buildReport(20260630, [june]),
      "gpcw20260930.dat": broken,
    });
    const result = await resolveFinanceReportPeriod(root, "sh600519", {
      totalAssets: june.totalAssets,
      mainRevenue: june.revenue,
      netProfit: june.profit,
    });
    expect(result.period?.reportDate).toBe("2026-06-30");
    expect(result.searched).toEqual(["2026-06-30"]);
  });
  it("目录缺失或没有财务包时给出原因，不抛错", async () => {
    const empty = await makeRoot({});
    expect(
      await resolveFinanceReportPeriod(empty, "sh600519", {
        totalAssets: 1,
        mainRevenue: 1,
        netProfit: 1,
      }),
    ).toMatchObject({
      period: null,
      reason: "本地通达信目录没有 gpcw 财务包，无法确定报告期",
    });
    const missing = await resolveFinanceReportPeriod(
      join(tmpdir(), "quant-gpcw-does-not-exist"),
      "sh600519",
      { totalAssets: 1, mainRevenue: 1, netProfit: 1 },
    );
    expect(missing.period).toBeNull();
    expect(missing.reason).toContain("读取本地财务包目录失败");
  });
  it("本地没有该证券记录时留空而不是匹配到别的证券", async () => {
    const root = await makeRoot({
      "gpcw20260630.dat": buildReport(20260630, [other]),
    });
    const result = await resolveFinanceReportPeriod(root, "sh600519", {
      totalAssets: other.totalAssets,
      mainRevenue: other.revenue,
      netProfit: other.profit,
    });
    expect(result.period).toBeNull();
  });
});
