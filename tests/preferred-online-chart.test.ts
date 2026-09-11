import { expect, it, vi, beforeEach } from "vitest";
import { preferredOnlineChart } from "../src/server/preferred-online-chart";
const deps = vi.hoisted(() => ({
  configured: vi.fn(),
  mcp: vi.fn(),
  fallback: vi.fn(),
}));
vi.mock("../src/server/mcp", () => ({ mcpConfigured: deps.configured }));
vi.mock("../src/server/market-data", () => ({
  mcpProvider: { history: deps.mcp },
}));
vi.mock("../src/server/online-chart-data", () => ({
  onlineChartSnapshot: deps.fallback,
}));
beforeEach(() => {
  vi.resetAllMocks();
  deps.configured.mockResolvedValue(true);
});
it("uses existing application MCP without requesting Eastmoney when successful", async () => {
  const snapshot = { source: "tdx-mcp", bars: [{ date: "2026-09-10" }] };
  deps.mcp.mockResolvedValue(snapshot);
  expect(await preferredOnlineChart("sh000001", "day")).toBe(snapshot);
  expect(deps.mcp).toHaveBeenCalledWith("sh000001", "day");
  expect(deps.fallback).not.toHaveBeenCalled();
});
it("discloses fallback and never combines bars after MCP failure", async () => {
  deps.mcp.mockRejectedValue(new Error("unavailable"));
  deps.fallback.mockResolvedValue({ source: "eastmoney-online", bars: [1] });
  expect(await preferredOnlineChart("sh000001", "day")).toEqual({
    source: "eastmoney-online",
    bars: [1],
    sourceNote: expect.stringContaining("通达信 MCP 行情读取失败"),
  });
});
it("preserves offline configuration and surfaces total source failure", async () => {
  deps.configured.mockResolvedValue(false);
  deps.fallback.mockRejectedValue(new Error("offline"));
  await expect(preferredOnlineChart("sh000001", "day")).rejects.toThrow(
    "offline",
  );
  expect(deps.mcp).not.toHaveBeenCalled();
});
