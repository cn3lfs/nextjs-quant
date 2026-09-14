import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { put } from "../src/server/db";
import { chartBars } from "../src/server/chart-bars";
import { marketSourceSchema } from "../src/lib/market-source";
import { settingsSchema, type Snapshot } from "../src/lib/domain";
import {
  queryMcp,
  mcpConfigured,
  mcpTools,
  importLocalMcp,
} from "../src/server/tdx-mcp-disabled";
const deps = vi.hoisted(() => ({ remote: vi.fn(), local: vi.fn() }));
vi.mock("../src/server/free-chart-sources", () => ({
  freeChartHistory: deps.remote,
}));
vi.mock("../src/server/tdx", async (original) => ({
  ...(await original<typeof import("../src/server/tdx")>()),
  readSnapshot: deps.local,
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
const source: Snapshot = {
  id: "selected",
  symbol: "sh600000",
  period: "day",
  source: "tdx-local",
  adjustment: "none",
  createdAt: 0,
  hash: "fixture",
  bars: [bar],
};
beforeEach(() => vi.resetAllMocks());
it("local selection never starts online requests, even for short or old history", async () => {
  put("snapshot", source.id, { ...source, requestedSource: "local" });
  const result = await chartBars({
    snapshotId: source.id,
    period: "day",
    limit: 100,
  });
  expect(result.bars).toEqual([bar]);
  expect(result.source).toBe("tdx-local");
  expect(deps.remote).not.toHaveBeenCalled();
});
it.each(["pytdx", "eastmoney", "tencent"] as const)(
  "keeps manual %s selection through a period change",
  async (selected) => {
    put("snapshot", source.id, { ...source, requestedSource: selected });
    deps.remote.mockResolvedValue({
      bars: [bar],
      source: selected,
      historyExhausted: true,
    });
    const result = await chartBars({
      snapshotId: source.id,
      period: "week",
      limit: 100,
    });
    expect(deps.remote).toHaveBeenCalledWith("sh600000", "week", 100, selected);
    expect(result.source).toBe(selected);
    expect(deps.local).not.toHaveBeenCalled();
    deps.remote.mockRejectedValue(new Error("selected source unavailable"));
    await expect(
      chartBars({ snapshotId: source.id, period: "week", limit: 100 }),
    ).rejects.toThrow("selected source unavailable");
  },
);
it("persists all four sources and rejects the suspended provider in new configuration", () => {
  expect(marketSourceSchema.options).toEqual([
    "auto",
    "local",
    "pytdx",
    "tencent",
    "eastmoney",
  ]);
  expect(
    settingsSchema.parse({ marketDataSource: "tencent" }).marketDataSource,
  ).toBe("tencent");
  expect(marketSourceSchema.safeParse("mcp").success).toBe(false);
});
it("blocks every MCP entry without network access or credential reads", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  expect(await mcpConfigured()).toBe(false);
  await expect(queryMcp("tdx_quotes", {})).rejects.toThrow("暂时停用");
  await expect(mcpTools()).rejects.toThrow("暂时停用");
  await expect(importLocalMcp()).rejects.toThrow("暂时停用");
  expect(fetch).not.toHaveBeenCalled();
  fetch.mockRestore();
});
it("disconnects original MCP imports and preserves selectable source wiring", () => {
  for (const file of readdirSync("src/server").filter(
    (f) => f.endsWith(".ts") && f !== "tdx-mcp-disabled.ts",
  ))
    expect(readFileSync(`src/server/${file}`, "utf8")).not.toMatch(
      /from ["']\.\/mcp["']/,
    );
  const market = readFileSync(
    "src/components/workbench/market-view.tsx",
    "utf8",
  );
  expect(market).toContain("<MarketSourceSelect");
  expect(market).toContain("source: marketSource");
  expect(market).not.toContain('source: "mcp"');
  const connection = readFileSync(
    "src/components/workbench/connections.tsx",
    "utf8",
  );
  expect(connection).not.toContain("api.mcp");
  expect(connection).toContain("marketDataSource");
  expect(
    readFileSync("src/components/workbench/screen-view.tsx", "utf8"),
  ).not.toContain("<OnlineScreen");
});
