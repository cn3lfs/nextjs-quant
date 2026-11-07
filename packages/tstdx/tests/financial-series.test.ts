import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseFinancialSeries,
  parseLocalFinancialMd5,
  parseStockFileList,
} from "../src/financial-series.js";
import { parseFinancialReport } from "../src/financial.js";
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/local/${name}`, import.meta.url));

describe("专业财务真实裁剪文件", () => {
  it("保留658槽位及归母、负债、成本的独立字段", () => {
    const report = parseFinancialReport(
      fixture("gpcw20260930.dat"),
      "gpcw20260930.dat",
    );
    expect(report.status).toBe("valid");
    expect(report.fieldCount).toBe(658);
    const row = report.records.find((r) => r.code === "600519")!;
    expect(row.values[62]).toBe(37883273216);
    expect(row.values[68]).toBe(9216876544);
    expect(row.values[74]).toBe(13645718528);
    expect(row.values[313]).toBe(261031);
    expect(row.values[39]).toBeCloseTo(row.values[62]! + row.values[71]!, -5);
  });
  it("只将已知20字节空包识别为占位，拒绝版本与报告期冲突", () => {
    const body = Buffer.alloc(20);
    body.writeInt16LE(1);
    body.writeUInt32LE(20261231, 2);
    body.writeUInt32LE(0xfffffffc, 12);
    expect(parseFinancialReport(body).status).toBe("placeholder");
    expect(() => parseFinancialReport(body, "gpcw20260930.dat")).toThrow(
      "不一致",
    );
    body.writeInt16LE(2);
    expect(() => parseFinancialReport(body)).toThrow("版本");
  });
  it("相同记录区重复偏移不能冒充有效财报", () => {
    const body = Buffer.from(fixture("gpcw20260930.dat"));
    body.writeUInt32LE(body.readUInt32LE(27), 38);
    expect(() => parseFinancialReport(body)).toThrow("重叠");
  });
});
describe("股票/板块/市场13字节序列", () => {
  it("保留两个数值、日期0和负数，不将组号自行解释为财报字段", () => {
    const result = parseFinancialSeries(fixture("gpsz000001.dat"));
    expect(result.records.map((r) => r.group)).toEqual([1, 3, 15, 49]);
    expect(result.records[0]!.values[0]).toBe(833471);
    const undated = result.records.find((r) => r.group === 49)!;
    expect(undated.date).toBeNull();
    expect(undated.values).toEqual([19910430, 19910502]);
    expect(result.issues).toEqual([
      { offset: 39, reason: "记录无日期，不能作为历史可见日期" },
    ]);
    expect(
      parseFinancialSeries(fixture("gpsh880301.dat")).records.map(
        (r) => r.group,
      ),
    ).toEqual([5, 6, 17]);
    expect(
      parseFinancialSeries(fixture("gpsh999999.dat")).records.map(
        (r) => r.group,
      ),
    ).toEqual([1, 31, 99]);
  });
  it("拒绝尾部截断与非有限数，非法日期独立报告", () => {
    expect(() => parseFinancialSeries(Buffer.alloc(14))).toThrow("截断");
    const body = Buffer.alloc(13);
    body[0] = 3;
    body.writeUInt32LE(20260230, 1);
    expect(parseFinancialSeries(body).records[0]!.date).toBeNull();
    expect(parseFinancialSeries(body).issues[0]!.reason).toContain("非法");
    body.writeFloatLE(Infinity, 5);
    expect(() => parseFinancialSeries(body)).toThrow("数值非法");
  });
  it("核验清单与MD5文本，路径越界与重复项拒绝", () => {
    const md5 = "a".repeat(32);
    expect(parseStockFileList(Buffer.from(`gpsh880301.dat,${md5},39`))).toEqual(
      [{ filename: "gpsh880301.dat", md5, filesize: 39 }],
    );
    expect(
      parseLocalFinancialMd5(Buffer.from(`[MD5]\ngpsh880301.dat=${md5}\n`)),
    ).toEqual({ "gpsh880301.dat": md5 });
    expect(() => parseStockFileList(Buffer.from(`../x.dat,${md5},39`))).toThrow(
      "非法",
    );
    expect(() => parseLocalFinancialMd5(Buffer.from(`[MD5]\nx=1`))).toThrow(
      "非法",
    );
  });
});
