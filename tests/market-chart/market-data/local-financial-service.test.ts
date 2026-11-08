import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  utimes,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  localFinancialView,
  localFinancialSeriesView,
} from "../../../src/server/financial/local-financial-service";
import {
  readLocalFinancialHistory,
  readFinancialPoolHistory,
} from "../../../src/server/data-sources/tdx/local-financial-files";
import {
  buildLocalFinancialArchive,
  verifyLocalFinancialArchive,
  localFinancialAnnualInput,
} from "../../../src/server/financial/local-financial-archive";
import { financialScreenInput } from "../../../src/lib/financial/local-financial";
import { runLocalFinancialScreen } from "../../../src/server/financial/local-financial-work";
import {
  readLocalFinancials,
  resolveFinanceReportPeriod,
} from "../../../src/server/data-sources/tdx/tdx-financial-reports";
const roots: string[] = [];
const fixture = (name: string) =>
  readFile(
    new URL(
      `../../../packages/tstdx/tests/fixtures/local/${name}`,
      import.meta.url,
    ),
  );
async function root() {
  const root = await mkdtemp(join(tmpdir(), "quant-financial-"));
  roots.push(root);
  await mkdir(join(root, "vipdoc/cw"), { recursive: true });
  await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
  const calendar = Buffer.alloc(3 * 32);
  [20261030, 20261102, 20261103].forEach((day, i) =>
    calendar.writeUInt32LE(day, i * 32),
  );
  await writeFile(join(root, "vipdoc/sh/lday/sh000001.day"), calendar);
  await writeFile(
    join(root, "vipdoc/cw/gpcw20260930.dat"),
    await fixture("gpcw20260930.dat"),
  );
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
describe("本地财务查询与冻结", () => {
  it("池内单只重复记录不能截断同一期其他正常证券", async () => {
    const dir = await root(),
      original = await fixture("gpcw20260930.dat");
    const fieldBytes = original.readUInt32LE(12),
      tableEnd = 20 + 3 * 11;
    const bytes = Buffer.alloc(tableEnd + 3 * fieldBytes);
    original.copy(bytes, 0, 0, 20);
    bytes.writeUInt16LE(3, 6);
    ["600519", "600519", "600036"].forEach((code, i) => {
      const index = 20 + i * 11,
        offset = tableEnd + i * fieldBytes;
      bytes.write(code, index, "ascii");
      bytes[index + 6] = 0;
      bytes.writeUInt32LE(offset, index + 7);
      const source = original.readUInt32LE(27);
      original.copy(bytes, offset, source, source + fieldBytes);
    });
    await writeFile(join(dir, "vipdoc/cw/gpcw20260930.dat"), bytes);
    const result = await readFinancialPoolHistory(
      dir,
      ["sh600519", "sh600036"],
      { asOf: "2026-11-03", strict: false, limit: 1, fieldIds: [40, 96] },
    );
    expect(result.reports.get("sh600519")).toHaveLength(0);
    expect(result.reports.get("sh600036")).toHaveLength(1);
    expect(
      result.issues.some(
        (issue) =>
          issue.reason.includes("600519") && issue.reason.includes("重复"),
      ),
    ).toBe(true);
  });
  it("服务器筛选排序分页，全字段保留，未来公告不可提前取数", async () => {
    const dir = await root();
    const data = await localFinancialView(dir, {
      symbol: "sh600519",
      pageSize: 5,
      sort: "slot",
      descending: true,
    });
    expect(data.rowCount).toBe(658);
    expect(data.rows.map((row) => row.code)).toEqual([
      "RAW658",
      "RAW657",
      "RAW656",
      "RAW655",
      "RAW654",
    ]);
    expect(data.selected).toMatchObject({
      reportDate: "2026-09-30",
      announcementDate: "2026-10-31",
    });
    // The same six digits identify an index in SH and a company in SZ.
    const reportPath = join(dir, "vipdoc/cw/gpcw20260930.dat"),
      bytes = await readFile(reportPath);
    bytes.write("000001", bytes.indexOf(Buffer.from("600036")), "ascii");
    await writeFile(reportPath, bytes);
    expect(
      (await localFinancialView(dir, { symbol: "sz000001" })).selected,
    ).not.toBeNull();
    const index = await localFinancialView(dir, { symbol: "sh000001" });
    expect(index.selected).toBeNull();
    expect(index.rowCount).toBe(0);
    expect(index.warning).toContain("不按六位代码借用");
    expect((await readLocalFinancials(dir, "sh000001")).financials).toBeNull();
    expect(
      (
        await resolveFinanceReportPeriod(dir, "sh000001", {
          totalAssets: 1,
          mainRevenue: 1,
          netProfit: 1,
        })
      ).searched,
    ).toEqual([]);
    const wrongMarket = await localFinancialView(dir, { symbol: "sz600519" });
    expect(wrongMarket.selected).toBeNull();
    const fields = await localFinancialView(dir, {
      symbol: "sh600519",
      search: "FN63",
    });
    expect(fields.rows[0]).toMatchObject({
      label: "负债合计",
      value: 37883273216,
    });
    expect(
      (
        await readLocalFinancialHistory(dir, "sh600519", {
          asOf: "2026-10-31",
          strict: true,
        })
      ).reports,
    ).toHaveLength(0);
    expect(
      (
        await readLocalFinancialHistory(dir, "sh600519", {
          asOf: "2026-11-02",
          strict: true,
        })
      ).reports,
    ).toHaveLength(1);
  });
  it("缓存按源版本失效，返回值修改不污染后续查询", async () => {
    const dir = await root(),
      file = join(dir, "vipdoc/cw/gpcw20260930.dat");
    const first = await readLocalFinancialHistory(dir, "sh600519");
    first.reports[0]!.fields[62]!.value = 1;
    expect(
      (await readLocalFinancialHistory(dir, "sh600519")).reports[0]!.fields[62]!
        .value,
    ).toBe(37883273216);
    const bytes = await readFile(file),
      offset = bytes.readUInt32LE(27);
    const code = bytes.subarray(20, 26).toString();
    const rowOffset = code === "600519" ? offset : bytes.readUInt32LE(38);
    bytes.writeFloatLE(1000, rowOffset + 62 * 4);
    await writeFile(file, bytes);
    await utimes(file, new Date(), new Date(Date.now() + 2000));
    const second = await readLocalFinancialHistory(dir, "sh600519");
    expect(second.reports[0]!.fields[62]!.value).toBe(1000);
    expect(second.reports[0]!.sourceSha256).not.toBe(
      first.reports[0]!.sourceSha256,
    );
  });
  it("同报告期同代码冲突保留诊断，不任意挑选", async () => {
    const dir = await root(),
      file = join(dir, "vipdoc/cw/gpcw20260930.dat"),
      bytes = await readFile(file);
    bytes.write("600519", 20, 6, "ascii");
    bytes.write("600519", 31, 6, "ascii");
    await writeFile(file, bytes);
    const data = await readLocalFinancialHistory(dir, "sh600519");
    expect(data.reports).toEqual([]);
    expect(data.issues[0]?.reason).toContain("重复");
  });
  it("序列保留无日期原记录，缺文件与损坏文件分别处理", async () => {
    const dir = await root();
    await writeFile(
      join(dir, "vipdoc/cw/gpsz000001.dat"),
      await fixture("gpsz000001.dat"),
    );
    const data = await localFinancialSeriesView(dir, {
      symbol: "sz000001",
      group: 49,
    });
    expect(data.rows[0]).toMatchObject({
      date: null,
      rawDate: 0,
      code: "GP49",
    });
    expect(data.rows[0]?.values.map((value) => value.raw)).toEqual([
      19910430, 19910502,
    ]);
    expect(
      (await localFinancialSeriesView(dir, { symbol: "sh600519" })).available,
    ).toBe(false);
    await writeFile(join(dir, "vipdoc/cw/gpsz000001.dat"), Buffer.alloc(14));
    await expect(
      localFinancialSeriesView(dir, { symbol: "sz000001" }),
    ).rejects.toThrow("截断");
  });
  it("本地档案无需在线来源，源更新不改冻结结果，篡改会被拒绝", async () => {
    const dir = await root(),
      archive = await buildLocalFinancialArchive(dir, "sh600519");
    expect(verifyLocalFinancialArchive(archive).id).toMatch(
      /^local-financial-[a-f0-9]{64}$/,
    );
    expect(archive.reports).toHaveLength(1);
    expect(archive.quality.annual).toHaveLength(0);
    expect(archive.growth.threeYear.revenueCagr.value).toBeNull();
    const annual = {
      ...archive.reports[0]!,
      reportDate: "2025-12-31",
      financialCompany: true,
    };
    const bank = localFinancialAnnualInput([annual]).annual[0]!;
    expect(bank.amounts.operatingCost.value).toBeNull();
    expect(bank.amounts.currentAssets.reasons.join(";")).toContain(
      "不使用通用",
    );
    const industrial = localFinancialAnnualInput([
      { ...annual, financialCompany: false },
    ]).annual[0]!;
    expect(industrial.amounts.operatingCost.value).toBeGreaterThan(0);
    archive.reports[0]!.fields[0]!.raw = 999;
    expect(() => verifyLocalFinancialArchive(archive)).toThrow("校验失败");
  });
  it("同日股票和市场因子可独立筛选，缺源和重复记录冻结为unknown", async () => {
    const dir = await root();
    const series = (group: number, value: number) => {
      const bytes = Buffer.alloc(13);
      bytes[0] = group;
      bytes.writeUInt32LE(20261102, 1);
      bytes.writeFloatLE(value, 5);
      return bytes;
    };
    await writeFile(join(dir, "vipdoc/cw/gpsh600519.dat"), series(16, 200));
    await writeFile(join(dir, "vipdoc/cw/gpsh999999.dat"), series(3, 15));
    const input = financialScreenInput.parse({
      asOf: "2026-11-02",
      conditions: [],
      dataFactors: [
        { id: "GP16-0", operator: "gt", threshold: 1000000 },
        { id: "SC3-0", operator: "gte", threshold: 10 },
      ],
    });
    const work = {
      type: "local-financial" as const,
      operation: "screen" as const,
      root: dir,
      input,
      symbols: ["sh600519", "sz300999"],
      names: {},
      rps: null,
      poolSource: { hash: "pool", description: "test" },
    };
    const result = await runLocalFinancialScreen(work);
    expect(result.counts).toEqual({
      total: 2,
      matched: 1,
      rejected: 0,
      unknown: 1,
    });
    expect(result.rows[0]!.reportDate).toBeNull();
    expect(result.rows[0]!.dataFactors.map((f) => f.value)).toEqual([
      2000000, 15,
    ]);
    expect(result.rows[0]!.dataFactors[0]!.inputs[0]!.sourceSha256).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(result.rows[1]!.dataFactors[0]!.reason).toContain("ENOENT");
    await writeFile(
      join(dir, "vipdoc/cw/gpsh600519.dat"),
      Buffer.concat([series(16, 200), series(16, 300)]),
    );
    const duplicate = await runLocalFinancialScreen(work);
    expect(duplicate.rows[0]!.matched).toBeNull();
    expect(duplicate.rows[0]!.dataFactors[0]!.reason).toContain("重复");
    expect(duplicate.hash).not.toBe(result.hash);
    expect(
      financialScreenInput.safeParse({ asOf: "2026-11-02", conditions: [] })
        .success,
    ).toBe(false);
    expect(
      financialScreenInput.safeParse({
        ...input,
        dataFactors: [{ id: "GO1", operator: "gt", threshold: 0 }],
      }).success,
    ).toBe(false);
  });
  it("财务批量条件缺失不是不满足，配置冻结且非法因子拒绝", async () => {
    const dir = await root(),
      input = financialScreenInput.parse({
        asOf: "2026-11-02",
        conditions: [{ field: "FN96", operator: "gt", threshold: 0 }],
        symbols: ["sh600519", "sz300999"],
      });
    const result = await runLocalFinancialScreen({
      type: "local-financial",
      operation: "screen",
      root: dir,
      input,
      symbols: input.symbols!,
      names: {},
      rps: null,
      poolSource: { hash: "frozen-pool", description: "test" },
    });
    expect(result.counts).toEqual({
      total: 2,
      matched: 1,
      rejected: 0,
      unknown: 1,
    });
    expect(result.rows[0]?.evidence[0]?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      financialScreenInput.safeParse({
        ...input,
        conditions: [{ field: "FN5651", operator: "gt", threshold: 0 }],
      }).success,
    ).toBe(false);
    expect(
      financialScreenInput.safeParse({
        ...input,
        technical: [
          { left: { id: "invented" }, operator: "gt", right: { constant: 0 } },
        ],
      }).success,
    ).toBe(false);
  });
});
