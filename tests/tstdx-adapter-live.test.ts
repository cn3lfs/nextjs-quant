import { writeFile } from "node:fs/promises";
import { createTdxClient } from "tstdx";
import { expect, it } from "vitest";
import {
  tstdxKlines,
  tstdxMinutes,
  tstdxSearch,
} from "../src/server/tstdx-adapter";
it.skipIf(process.env.QUANT_TSTDX_ADAPTER !== "1")(
  "真实 adapter 样本保留可用与不可用证据",
  async () => {
    const make = () =>
      createTdxClient({ hosts: ["180.153.18.170"], timeoutMs: 3000 });
    const klines = await tstdxKlines(
      {
        symbols: [
          "sh600000",
          "sz000001",
          "sz300750",
          "sh688981",
          "bj920002",
          "sh000001",
          "sz399006",
          "sh510300",
          "sz159915",
          "sh880001",
          "ptBK0475",
        ],
        period: "day",
        limit: 3,
      },
      undefined,
      make,
    );
    const minutes = await tstdxMinutes(
      { symbol: "sz300750", date: "2026-09-14" },
      undefined,
      make,
    );
    const stocks = await tstdxSearch(
      { keyword: "300750", type: "stock", markets: ["sz"] },
      undefined,
      make,
    );
    const etfs = await tstdxSearch(
      { keyword: "159915", type: "etf", markets: ["sz"] },
      undefined,
      make,
    );
    const indices = await tstdxSearch(
      { keyword: "399006", type: "index", markets: ["sz"] },
      undefined,
      make,
    );
    const sectors = await tstdxSearch(
      { keyword: "芯片", type: "sector" },
      undefined,
      make,
    );
    const report = { klines, minutes, stocks, etfs, indices, sectors };
    if (process.env.QUANT_TSTDX_ADAPTER_REPORT)
      await writeFile(
        process.env.QUANT_TSTDX_ADAPTER_REPORT,
        JSON.stringify(report, null, 2),
      );
    expect(minutes.points).toHaveLength(240);
    expect(stocks.some((s) => s.code === "sz300750")).toBe(true);
    expect(etfs.some((s) => s.code === "sz159915")).toBe(true);
    expect(indices.some((s) => s.code === "sz399006")).toBe(true);
    expect(sectors.length).toBeGreaterThan(0);
    // Actual availability gate; do not turn empty packets into successful chart data.
    expect(
      klines.items.filter((i) => i.symbol !== "ptBK0475").map((i) => i.status),
    ).toEqual(Array(10).fill("ok"));
  },
  120000,
);
