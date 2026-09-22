import { beforeEach, expect, it, vi } from "vitest";
import {
  parseTencentChart,
  freeChartHistory,
  pytdxChartHistory,
  tencentChartHistory,
} from "../src/server/market/free-chart-sources";
const deps = vi.hoisted(() => ({
  page: vi.fn(),
  index: vi.fn(),
  query: vi.fn(),
  http: vi.fn(),
}));
vi.mock("../src/server/market/chart-history", () => ({
  onlinePeriodHistory: deps.http,
}));
vi.mock("../src/server/data-sources/tdx/tdx-quotes", () => ({
  configuredHosts: () => ["127.0.0.1"],
  barPage: deps.page,
  indexBarPage: deps.index,
}));
vi.mock("tstdx", async (original) => ({
  ...(await original<typeof import("tstdx")>()),
  createTdxClient: () => ({
    barPage: deps.page,
    indexBarPage: deps.index,
    close: async () => {},
  }),
}));
vi.mock("../src/server/data-sources/westock/westock-data", () => ({
  westockScriptPath: () => "fixture-westock.js",
  query: deps.query,
}));
const row = {
  date: "2026-09-14",
  open: 10,
  last: 11,
  high: 12,
  low: 9,
  volume: 100,
  amount: 1000,
};
beforeEach(() => vi.resetAllMocks());
it("auto prefers tstdx and stops after the first valid source", async () => {
  deps.page.mockResolvedValue([{ ...row, close: row.last }]);
  expect((await freeChartHistory("sh600000", "day", 3)).source).toBe(
    "tdx-7709",
  );
  expect(deps.http).not.toHaveBeenCalled();
  expect(deps.query).not.toHaveBeenCalled();
});
it("auto falls back from tstdx to HTTP, then westock, retaining failures", async () => {
  const calls: string[] = [];
  deps.page.mockImplementation(async () => {
    calls.push("tstdx");
    throw Error("tdx down");
  });
  deps.http.mockImplementation(async () => {
    calls.push("http");
    return { bars: [{ ...row, close: row.last }], source: "eastmoney-online" };
  });
  expect((await freeChartHistory("sh600000", "day", 3)).source).toBe(
    "eastmoney-online",
  );
  expect(calls).toEqual(["tstdx", "http"]);
  expect(deps.query).not.toHaveBeenCalled();
  calls.length = 0;
  deps.http.mockImplementation(async () => {
    calls.push("http");
    throw Error("http down");
  });
  deps.query.mockImplementation(async () => {
    calls.push("westock");
    return [row];
  });
  const result = await freeChartHistory("sh600000", "day", 3);
  expect(calls).toEqual(["tstdx", "http", "westock"]);
  expect(result.source).toBe("tencent/westock-data");
  expect(result.sourceNote).toContain("tdx down");
  expect(result.sourceNote).toContain("http down");
});
it("manual tstdx failure never falls back", async () => {
  deps.page.mockRejectedValue(Error("tdx down"));
  await expect(freeChartHistory("sh600000", "day", 3, "pytdx")).rejects.toThrow(
    "tdx down",
  );
  expect(deps.http).not.toHaveBeenCalled();
  expect(deps.query).not.toHaveBeenCalled();
});
it("validates Tencent OHLC, dates, identity, empty output and structured errors", () => {
  expect(parseTencentChart([row], "sh600000", "day")[0]?.close).toBe(11);
  for (const raw of [
    [],
    { success: false, error: { code: "SKILL_006_2" } },
    [row, row],
    [{ ...row, date: "2026-02-30" }],
    [{ ...row, high: 8 }],
    [{ ...row, symbol: "sz000001" }],
    [{ ...row, amount: undefined }],
  ])
    expect(() => parseTencentChart(raw, "sh600000", "day")).toThrow();
});
it("requests unadjusted Tencent minute data and never hides the 2000 bar limit", async () => {
  deps.query.mockResolvedValue([{ ...row, date: "2026-09-14 14:55" }]);
  const result = await tencentChartHistory("sh600000", "5m", 4000);
  expect(deps.query.mock.calls[0]?.[1]).toEqual([
    "kline",
    "sh600000",
    "--period",
    "m5",
    "--limit",
    "2000",
    "--fq",
    "bfq",
    "--start",
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    "--end",
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
  ]);
  expect(result.bars[0]?.date).toBe("2026-09-14T14:55:00+08:00");
  expect(result.historyExhausted).toBe(true);
  expect(result.sourceNote).toContain("2000");
});
it("uses index parsing for indices and rejects empty pytdx data", async () => {
  deps.index.mockResolvedValue([{ ...row, close: row.last }]);
  const result = await pytdxChartHistory("sh000001", "day", 100);
  expect(result.source).toBe("tdx-7709");
  expect(deps.index).toHaveBeenCalledWith("sh000001", "day", 0, 100);
  expect(deps.page).not.toHaveBeenCalled();
  deps.page.mockResolvedValue([]);
  await expect(pytdxChartHistory("sh600000", "day", 100)).rejects.toThrow(
    "未返回行情",
  );
});
