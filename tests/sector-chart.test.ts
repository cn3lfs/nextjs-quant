import { expect, it } from "vitest";
import {
  chartSymbolSchema,
  chartPricePrecision,
  normalizeChartSymbol,
} from "../src/lib/chart-symbol";
import { symbolSchema } from "../src/lib/domain";
import { chartKeySchema } from "../src/lib/chart-view";
it("沪深基金图表保留三位价格，股票和指数保留两位", () => {
  for (const symbol of [
    "sh500001",
    "sh510300",
    "sh520500",
    "sh530000",
    "sh560000",
    "sh588000",
    "sz159915",
    "sz161725",
  ])
    expect(chartPricePrecision(symbol)).toBe(3);
  for (const symbol of ["sh600000", "sz300750", "sh000001", "pt01801081"])
    expect(chartPricePrecision(symbol)).toBe(2);
});
it("板块只进入图表契约，不能变成交易或研究证券", () => {
  for (const symbol of ["pt01801081", "emBK0475"]) {
    expect(chartSymbolSchema.parse(symbol)).toBe(symbol);
    expect(chartKeySchema.parse({ symbol, period: "week" }).symbol).toBe(
      symbol,
    );
    expect(symbolSchema.safeParse(symbol).success).toBe(false);
  }
  expect(normalizeChartSymbol(" PT01801081 ")).toBe("pt01801081");
  expect(normalizeChartSymbol("EMbk0475")).toBe("emBK0475");
  for (const value of [
    "../pt01801081",
    "emBK0475/",
    "pt",
    "sh600000;",
    "半导体",
  ])
    expect(normalizeChartSymbol(value)).toBeNull();
});
it.skipIf(process.env.QUANT_SECTOR_CHART_ACCEPTANCE !== "1")(
  "真实板块快照与跨周期 API 保持指定来源",
  async () => {
    const { appRouter } = await import("../src/server/api/root");
    const caller = appRouter.createCaller({ headers: new Headers() });
    for (const [symbol, source, expected] of [
      ["pt01801081", "tencent", "tencent/westock-data"],
      ["emBK0475", "eastmoney", "eastmoney-online"],
    ] as const) {
      const snapshot = await caller.snapshot({ symbol, source, period: "day" });
      expect(snapshot.source).toBe(expected);
      expect(snapshot.requestedSource).toBe(source);
      expect(snapshot.bars.length).toBeGreaterThan(0);
      const chart = await caller.chartBars({
        snapshotId: snapshot.id,
        period: "week",
        limit: 100,
      });
      expect(chart.source).toBe(expected);
      expect(chart.bars.length).toBeGreaterThan(0);
      await expect(caller.watchlist([symbol])).rejects.toThrow();
      await expect(caller.securityIdentity(symbol)).rejects.toThrow();
    }
  },
  120000,
);
