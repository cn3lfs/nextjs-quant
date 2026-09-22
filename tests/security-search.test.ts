import { expect, it } from "vitest";
import { searchSecurities } from "~/server/market/security-search";
import type { Security } from "~/lib/domain";
const stocks: Security[] = [
  {
    symbol: "sh600519",
    name: "贵州茅台",
    market: "sh",
    period: "day",
    bytes: 32,
    modified: 0,
  },
  {
    symbol: "sz000001",
    name: "平安银行",
    market: "sz",
    period: "day",
    bytes: 32,
    modified: 0,
  },
];
it.each(["茅台", "600519", "SH600519", " GZMT ", "guizhoumaotai"])(
  "名称、代码和拼音搜索 %s",
  (query) => {
    expect(searchSecurities(stocks, query, "day").map((s) => s.symbol)).toEqual(
      ["sh600519"],
    );
  },
);
it("按周期过滤且未知关键词不返回无关品种", () => {
  expect(searchSecurities(stocks, "gzmt", "5m")).toEqual([]);
  expect(searchSecurities(stocks, "不存在", "day")).toEqual([]);
});
