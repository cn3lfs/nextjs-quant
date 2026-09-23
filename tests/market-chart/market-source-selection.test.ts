import { beforeEach, expect, it, vi } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { put } from "../../src/server/db/index";
import { chartBars, chartBarsInput } from "../../src/server/charts/chart-bars";
import { marketSourceSchema } from "../../src/lib/market/market-source";
import { settingsSchema, type Snapshot } from "../../src/lib/domain";
import {
  queryMcp,
  mcpConfigured,
  mcpTools,
  importLocalMcp,
} from "../../src/server/data-sources/tdx/tdx-mcp-disabled";
const deps = vi.hoisted(() => ({ remote: vi.fn(), local: vi.fn() }));
vi.mock("../../src/server/market/free-chart-sources", () => ({
  freeChartHistory: deps.remote,
}));
vi.mock("../../src/server/data-sources/tdx/tdx", async (original) => ({
  ...(await original<typeof import("../../src/server/data-sources/tdx/tdx")>()),
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
    "eastmoney",
    "tencent",
  ]);
  expect(
    settingsSchema.parse({ marketDataSource: "tencent" }).marketDataSource,
  ).toBe("tencent");
  expect(marketSourceSchema.safeParse("mcp").success).toBe(false);
});
it("defaults chart requests to unadjusted prices and accepts the three chart modes", () => {
  expect(
    chartBarsInput.parse({ snapshotId: "selected", period: "day" }).adjustment,
  ).toBe("none");
  expect(
    chartBarsInput.parse({
      snapshotId: "selected",
      period: "day",
      adjustment: "forward",
    }).adjustment,
  ).toBe("forward");
  expect(
    chartBarsInput.safeParse({
      snapshotId: "selected",
      period: "day",
      adjustment: "invalid",
    }).success,
  ).toBe(false);
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
const liveMcpImport = /from ["'](?:(?:\.\.?\/)+mcp|~\/server\/mcp)["']/;
it("recognizes disabled MCP bypasses at nested service paths", () => {
  for (const path of ["./mcp", "../mcp", "../../mcp", "~/server/mcp"])
    expect(`import { queryMcp } from "${path}";`).toMatch(liveMcpImport);
  expect('import { queryMcp } from "./tdx-mcp-disabled";').not.toMatch(
    liveMcpImport,
  );
});
it("disconnects original MCP imports and preserves selectable source wiring", () => {
  for (const file of readdirSync("src/server", { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".ts") && f !== "tdx-mcp-disabled.ts"))
    expect(readFileSync(`src/server/${file}`, "utf8")).not.toMatch(
      liveMcpImport,
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
it("keeps the chart tab focused and renders the task center only as a tab", () => {
  const market = readFileSync(
    "src/components/workbench/market-view.tsx",
    "utf8",
  );
  expect(market).toContain("<ChartAdjustmentSelect");
  expect(market).not.toContain("<MxDataQuery");
  expect(market).not.toContain("<SecurityProfilePanel");
  expect(market).not.toContain("核验证券身份");
  expect(market).not.toContain("证券主档与名称来源");
  expect(readFileSync("src/components/market/chart.tsx", "utf8")).not.toContain(
    "双突破观察日",
  );
  const workbench = readFileSync(
    "src/components/workbench/workbench.tsx",
    "utf8",
  );
  expect(workbench).toContain('"/tasks": <TaskCenter state={state} />');
  expect(workbench.match(/<TaskCenter/g)).toHaveLength(1);
});
