import { afterEach, expect, it, vi } from "vitest";
import { businessEvidence, queryBusiness } from "~/server/hithink-business";
const now = Date.parse("2026-09-09T10:00:00+08:00");
function page(count = 2, start = 0) {
  return {
    status_code: 0,
    code_count: 1,
    secret: "do-not-retain",
    columns: [
      { key: "股票代码", type: "STR" },
      { key: "业务收入", type: "DOUBLE", unit: "元" },
      { key: "收入占比", type: "DOUBLE", unit: "%" },
      { key: "分类标准", type: "STR" },
      { key: "项目名称", type: "STR" },
    ],
    datas: Array.from({ length: count }, (_, i) => ({
      股票代码: "600519.SH",
      报告期截止日: "20251231",
      分类标准: "产品",
      项目名称: `产品${i + start}`,
      业务收入: 10,
      收入占比: 10,
      secret: "do-not-retain",
    })),
  };
}
const evidence = (pages: unknown[]) =>
  businessEvidence(
    "sh600519",
    2025,
    "segments",
    "2025年 主营业务构成",
    pages,
    now,
  );
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("preserves row-level annual dates and classification without retaining undeclared fields", () => {
  const result = evidence([page()]);
  expect(result.envelope).toMatchObject({
    reportPeriod: "20251231",
    publishedAt: null,
    currency: null,
    quality: "partial",
  });
  expect(JSON.parse(result.text).pages[0].datas[0].报告期截止日).toBe(
    "20251231",
  );
  expect(result.text).not.toContain("do-not-retain");
  const bad = page();
  bad.datas[0]!.报告期截止日 = "20250630";
  expect(() => evidence([bad])).toThrow(/年度/);
  bad.datas[0]!.报告期截止日 = "";
  expect(() => evidence([bad])).toThrow(/年度/);
});
it("rejects wrong securities, duplicates, invalid amounts and unproven units", () => {
  const wrong = page();
  wrong.datas[0]!.股票代码 = "000001.SZ";
  expect(() => evidence([wrong])).toThrow(/身份/);
  const duplicate = page();
  duplicate.datas[1] = { ...duplicate.datas[0]! };
  expect(() => evidence([duplicate])).toThrow(/重复/);
  for (const number of [NaN, Infinity, -1]) {
    const bad = page();
    bad.datas[0]!.业务收入 = number;
    expect(() => evidence([bad])).toThrow();
  }
  const unit = page();
  unit.columns[1]!.unit = "万元";
  expect(() => evidence([unit])).toThrow(/单位/);
  expect(() =>
    businessEvidence("sh600519", 2026, "segments", "q", [page()], now),
  ).toThrow(/尚未结束/);
});
it("requires a terminal short page and distinct annual items across pages", () => {
  expect(JSON.parse(evidence([page(10), page(1, 10)]).text).pages).toHaveLength(
    2,
  );
  expect(() => evidence([page(10)])).toThrow(/分页/);
  expect(() => evidence([page(10), page(1)])).toThrow(/重复/);
  expect(() => evidence([page(1), page(1, 10)])).toThrow(/分页/);
});
it("requires explicit top-five customer definition, annual date and percent unit", () => {
  const raw = {
    status_code: 0,
    code_count: 1,
    columns: [
      {
        key: "销售额占比[20251231]",
        index_name: "客户销售额合计占比(前五大)",
        timestamp: "20251231",
        type: "DOUBLE",
        unit: "%",
      },
    ],
    datas: [{ 股票代码: "600519.SH", "销售额占比[20251231]": 10.1 }],
  };
  const parse = () =>
    businessEvidence("sh600519", 2025, "customers", "q", [raw], now);
  expect(parse().envelope?.reportPeriod).toBe("20251231");
  raw.datas[0]!["销售额占比[20251231]"] = 101;
  expect(parse).toThrow();
  raw.datas[0]!["销售额占比[20251231]"] = 10.1;
  raw.columns[0]!.index_name = "客户销售占比";
  expect(parse).toThrow(/口径/);
});
it("fetches all pages despite security count one and deduplicates concurrent requests", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(init.body as string);
    expect(body.query).toContain("2025年 主营业务构成");
    return Response.json(body.page === "1" ? page(10) : page(1, 10));
  });
  vi.stubGlobal("fetch", fetcher);
  const [a, b] = await Promise.all([
    queryBusiness("sh600519", 2025, "segments"),
    queryBusiness("sh600519", 2025, "segments"),
  ]);
  expect(a.id).toBe(b.id);
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("stops repeated pages and cancellation without accepting partial rows", async () => {
  vi.stubEnv("IWENCAI_API_KEY", "fixture");
  const repeated = vi.fn(async () => Response.json(page(10)));
  vi.stubGlobal("fetch", repeated);
  await expect(queryBusiness("sh600519", 2025, "segments")).rejects.toThrow(
    /重复/,
  );
  expect(repeated).toHaveBeenCalledTimes(2);
  const controller = new AbortController();
  const canceled = vi.fn(async () => {
    controller.abort();
    return Response.json(page(10));
  });
  vi.stubGlobal("fetch", canceled);
  await expect(
    queryBusiness("sh600519", 2025, "segments", controller.signal),
  ).rejects.toThrow();
  expect(canceled).toHaveBeenCalledTimes(1);
});
