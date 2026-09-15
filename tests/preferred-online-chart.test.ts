import { expect, it, vi, beforeEach } from "vitest";
import { preferredOnlineChart } from "../src/server/preferred-online-chart";
const deps = vi.hoisted(() => ({
  eastmoney: vi.fn(),
  page: vi.fn(),
  tencent: vi.fn(),
}));
vi.mock("../src/server/chart-history", () => ({
  onlinePeriodHistory: deps.eastmoney,
}));
vi.mock("../src/server/tdx-quotes", () => ({
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
vi.mock("../src/server/westock-data", () => ({
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
it("prefers the currently verified Eastmoney source without calling other providers", async () => {
  const result = await preferredOnlineChart("sh600000", "day");
  expect(result.source).toBe("eastmoney-online");
  expect(result.requestedSource).toBe("auto");
  expect(result.bars).toEqual([bar]);
  expect(deps.page).not.toHaveBeenCalled();
  expect(deps.tencent).not.toHaveBeenCalled();
});
it("falls back to pytdx after both HTTP providers fail and discloses failures", async () => {
  deps.eastmoney.mockRejectedValue(new Error("offline"));
  deps.tencent.mockRejectedValue(new Error("Tencent unavailable"));
  deps.page.mockResolvedValue([bar]);
  const result = await preferredOnlineChart("sh600000", "day");
  expect(result.source).toBe("tdx-7709");
  expect(result.sourceNote).toContain("东方财富：offline");
  expect(result.bars).toEqual([bar]);
  expect(deps.tencent).toHaveBeenCalledTimes(1);
});
it("uses Tencent after Eastmoney fails without requesting pytdx", async () => {
  deps.eastmoney.mockRejectedValue(new Error("offline"));
  deps.page.mockRejectedValue(new Error("bad packet"));
  deps.tencent.mockResolvedValue([{ ...bar, last: bar.close }]);
  const result = await preferredOnlineChart("sh600000", "day");
  expect(result.source).toBe("tencent/westock-data");
  expect(result.sourceNote).toContain("offline");
  expect(deps.page).not.toHaveBeenCalled();
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
