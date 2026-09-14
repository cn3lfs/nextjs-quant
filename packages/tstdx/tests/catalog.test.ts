import { describe, expect, it } from "vitest";
import fixture from "./fixtures/catalog.json";
import * as wire from "../src/catalog-wire";
const body = (name: keyof typeof fixture.bodies) =>
  Buffer.from(fixture.bodies[name], "hex");
it("封包逐字节匹配独立 xmtdx 参考，包含 GBK 文件名", () => {
  const requests = {
    count: wire.buildSecurityCountRequest("sh"),
    list: wire.buildSecurityListRequest("sh", 1000),
    category: wire.buildCompanyCategoryRequest("sh600000"),
    content: wire.buildCompanyContentRequest("sh600000", "资料.txt", 5, 8),
    meta: wire.buildBlockMetaRequest("block_gn.dat"),
    chunk: wire.buildFileChunkRequest("tdxhy.cfg", 30000, 50),
    flow: wire.buildHistoryFlowRequest("sh600000", 3, 2),
  };
  for (const key of Object.keys(requests) as (keyof typeof requests)[])
    expect(requests[key].toString("hex")).toBe(fixture.requests[key]);
});
it("解析证券身份、GBK 名称及价格，保留未知字段", () => {
  const [row] = wire.parseSecurityList(body("security"), "sh");
  expect(row).toMatchObject({
    symbol: "sh600000",
    name: "浦发银行",
    volumeUnit: 100,
    decimalPoint: 2,
  });
  expect(row?.preClose).toBeCloseTo(9.26, 5);
  expect(wire.parseSecurityCount(Buffer.from([5, 0]))).toBe(5);
});
it("F10、板块、资金流固定样本具有完整内容", () => {
  expect(wire.parseCompanyCategories(body("category"))).toEqual([
    { name: "公司概况", filename: "资料.txt", start: 5, length: 8 },
  ]);
  expect(wire.decodeGbk(wire.parseCompanyContent(body("content")))).toBe(
    "资料测试",
  );
  expect(wire.parseBlockFile(body("block"), "block_gn.dat")).toEqual([
    {
      name: "测试",
      category: 2,
      type: 2,
      count: 2,
      codes: ["600000", "000750"],
    },
  ]);
  expect(wire.parseBlockMeta(body("meta"))).toEqual({
    size: 3199,
    md5: "0".repeat(32),
  });
  expect(wire.parseHistoryFlow(body("flow"))).toEqual([
    {
      date: "2026-09-14",
      source: "category22",
      superIn: 1,
      largeIn: 2,
      mediumIn: 3,
      smallIn: 4,
      superOut: 5,
      largeOut: 6,
      mediumOut: 7,
      smallOut: 8,
    },
  ]);
});
describe("截断不会被当作空数据", () => {
  it.each([
    "security",
    "category",
    "content",
    "block",
    "flow",
    "meta",
  ] as const)("%s", (name) => {
    const parsers = {
      security: (b: Buffer) => wire.parseSecurityList(b, "sh"),
      category: wire.parseCompanyCategories,
      content: wire.parseCompanyContent,
      block: wire.parseBlockFile,
      flow: wire.parseHistoryFlow,
      meta: wire.parseBlockMeta,
    };
    expect(() =>
      parsers[name](body(name).subarray(0, body(name).length - 1)),
    ).toThrow();
  });
  it("拒绝短文件分片与过量成分", () => {
    expect(() => wire.parseFileChunk(Buffer.alloc(3))).toThrow();
    const b = body("block");
    b.writeUInt16LE(401, 395);
    expect(() => wire.parseBlockFile(b)).toThrow();
  });
});
it("拒绝错误市场、非法证券/日期、负偏移、过长或含路径文件名", () => {
  expect(() => wire.marketId("toString" as wire.TdxMarket)).toThrow();
  expect(() => wire.buildCompanyCategoryRequest("600000")).toThrow();
  expect(() => wire.buildSecurityListRequest("sh", -1)).toThrow();
  expect(() => wire.buildFileChunkRequest("a", 0, 30001)).toThrow();
  for (const name of ["../a", "a/b", "a\0b", "x".repeat(101)])
    expect(() => wire.buildFileChunkRequest(name, 0)).toThrow();
  expect(() => wire.dateNumber(20260230)).toThrow();
  const b = body("flow");
  b.writeUInt32LE(20260230, 11);
  expect(() => wire.parseHistoryFlow(b)).toThrow();
});
it("行业映射以市场与代码共同索引，不串同数字证券", () => {
  const rows = wire.parseIndustryFile(
    Buffer.from("0|000001|T1|||S1\n1|000001|T2|||S2"),
  );
  expect(rows.get("sz000001")).toEqual({ industryTdx: "T1", industrySw: "S1" });
  expect(rows.get("sh000001")?.industryTdx).toBe("T2");
});
