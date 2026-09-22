import { expect, it } from "vitest";
import { normalizeOnlineScreen } from "../src/server/screening/online-screen";
const source = () => ({
  meta: {
    code: 0,
    total: 25,
    pageNo: 1,
    pageSize: 20,
    rang: "AG",
    query: "query",
  },
  headers: [
    "sec_code",
    "sec_name",
    "涨跌幅(%).前复权<br>2026.09.08",
    "成交量(手)<br>2026.09.04-2026.09.08",
  ],
  data: [
    {
      sec_code: "600519",
      sec_name: "贵州茅台",
      market: "1",
      "涨跌幅(%).前复权<br>2026.09.08": -0.51,
    },
  ],
  summary: "provider summary",
});
it("preserves source values and date/unit/adjustment distinctions rather than claiming local rule matches", () => {
  const raw = source(),
    result = normalizeOnlineScreen(raw, "当日涨幅大于0", 1, {
      required: ["message"],
    });
  expect(result.rows[0]?.symbol).toBe("sh600519");
  expect(result.rows[0]?.values[raw.headers[2]!]).toBe(-0.51);
  expect(result.query).toBe("当日涨幅大于0");
  expect(result.providerQuery).toBe("query");
  expect(result.columns[2]).toMatchObject({
    unit: "%",
    adjustment: "前复权",
    dates: ["2026.09.08"],
  });
  expect(result.columns[3]).toMatchObject({
    unit: "手",
    dates: ["2026.09.04", "2026.09.08"],
  });
  expect(result.rows[0]).not.toHaveProperty("matched");
  expect(result.warnings.join("")).toContain("尚未逐项核验");
  expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/);
});
it("market/code conflicts and non-A-stock symbols cannot enter the local universe", () => {
  const raw = source();
  raw.data[0]!.market = "0";
  expect(normalizeOnlineScreen(raw, "query", 1, {}).rows[0]?.symbol).toBeNull();
  raw.data[0]!.market = "1";
  raw.data[0]!.sec_code = "510300";
  expect(
    normalizeOnlineScreen(raw, "query", 1, {}).rows[0]?.identityWarning,
  ).toContain("禁止导入");
});
it("rejects mismatched pages, market scope, and malformed response shape", () => {
  expect(() => normalizeOnlineScreen(source(), "query", 2, {})).toThrow("分页");
  const raw = source();
  raw.meta.rang = "HK-GP";
  expect(() => normalizeOnlineScreen(raw, "query", 1, {})).toThrow("市场范围");
  expect(() => normalizeOnlineScreen({ data: [] }, "query", 1, {})).toThrow();
});
