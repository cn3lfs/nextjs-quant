import { expect, it, vi, beforeEach } from "vitest";
import { preferredOnlineChart } from "../../../src/server/market/preferred-online-chart";
const deps = vi.hoisted(() => ({
  eastmoney: vi.fn(),
  page: vi.fn(),
  tencent: vi.fn(),
}));
vi.mock("../../../src/server/market/chart-history", () => ({
  onlinePeriodHistory: deps.eastmoney,
}));
vi.mock("../../../src/server/data-sources/tdx/tdx-quotes", () => ({
  configuredHosts: () => ["127.0.0.1"],
  barPage: deps.page,
  indexBarPage: deps.page,
}));
vi.mock("tstdx", async (original) => ({
  ...(await original<typeof import("tstdx")>()),
  createTdxClient: () => ({
    barPage: deps.page,
    indexBarPage: deps.page,
    close: async () => {},
  }),
}));
vi.mock("../../../src/server/data-sources/westock/westock-data", () => ({
  westockScriptPath: () => "fixture-westock.js",
  query: deps.tencent,
}));
const bar = {
  date: "2026-09-14",
  open: 10,
  close: 11,
  high: 12,
  low: 9,
  volume: 100,
  amount: 1000,
};
beforeEach(() => {
  vi.resetAllMocks();
  deps.eastmoney.mockResolvedValue({
    source: "eastmoney-online",
    bars: [bar],
    historyExhausted: true,
    volumeUnit: "手",
  });
});
it("prefers tstdx without calling other providers", async () => {
  deps.page.mockResolvedValue([bar]);
  const result = await preferredOnlineChart("sh600000", "day");
  expect(result.source).toBe("tdx-7709");
  expect(result.requestedSource).toBe("auto");
  expect(result.bars).toEqual([bar]);
  expect(deps.eastmoney).not.toHaveBeenCalled();
  expect(deps.tencent).not.toHaveBeenCalled();
});
it("falls back to Eastmoney after tstdx fails and discloses the failure", async () => {
  deps.page.mockRejectedValue(new Error("bad packet"));
  const result = await preferredOnlineChart("sh600000", "day");
  expect(result.source).toBe("eastmoney-online");
  expect(result.sourceNote).toContain("bad packet");
  expect(result.bars).toEqual([bar]);
  expect(deps.tencent).not.toHaveBeenCalled();
});
it("uses Tencent after both tstdx and Eastmoney fail", async () => {
  deps.eastmoney.mockRejectedValue(new Error("offline"));
  deps.page.mockRejectedValue(new Error("bad packet"));
  deps.tencent.mockResolvedValue([{ ...bar, last: bar.close }]);
  const result = await preferredOnlineChart("sh600000", "day");
  expect(result.source).toBe("tencent/westock-data");
  expect(result.sourceNote).toContain("offline");
  expect(deps.page).toHaveBeenCalledTimes(1);
  expect(result.sourceNote).toContain("bad packet");
  expect(result.sourceNote).toContain("延迟");
  expect(result.bars).toEqual([bar]);
});
it("manual source failure does not silently fall back", async () => {
  deps.page.mockRejectedValue(new Error("offline"));
  await expect(
    preferredOnlineChart("sh600000", "day", "pytdx"),
  ).rejects.toThrow("offline");
  expect(deps.eastmoney).not.toHaveBeenCalled();
  expect(deps.tencent).not.toHaveBeenCalled();
});
it("reports total failure including a successful CLI exit with service error", async () => {
  deps.eastmoney.mockRejectedValue(new Error("offline"));
  deps.page.mockRejectedValue(new Error("bad packet"));
  deps.tencent.mockResolvedValue({
    success: false,
    error: { code: "SKILL_006_2" },
  });
  await expect(preferredOnlineChart("sh600000", "day")).rejects.toThrow(
    "所有免费在线源不可用",
  );
});
