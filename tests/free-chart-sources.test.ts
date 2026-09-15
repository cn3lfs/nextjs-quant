import { beforeEach, expect, it, vi } from "vitest";
import {
  parseTencentChart,
  pytdxChartHistory,
  tencentChartHistory,
} from "../src/server/free-chart-sources";
const deps = vi.hoisted(() => ({
  page: vi.fn(),
  index: vi.fn(),
  query: vi.fn(),
}));
vi.mock("../src/server/tdx-quotes", () => ({
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
vi.mock("../src/server/westock-data", () => ({
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
