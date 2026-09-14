import { expect, it } from "vitest";
import type { MxQueryInput } from "../src/lib/mx-data";

const cases: { input: MxQueryInput; identities: string[] }[] = [
  {
    input: {
      kind: "ashare",
      subjects: [
        "浦发银行(600000.SH)",
        "平安银行(000001.SZ)",
        "宁德时代(300750.SZ)",
        "中芯国际(688981.SH)",
        "万达轴承(920002.BJ)",
      ],
      timeRange: "2026-09-14",
      request: "当日不复权收盘价，逐个列出证券代码、日期及价格单位",
    },
    identities: ["600000", "000001", "300750", "688981", "920002"],
  },
  {
    input: {
      kind: "fund",
      subjects: ["沪深300ETF华泰柏瑞(510300.SH)"],
      timeRange: "2026-09-14",
      request: "当日场内交易收盘价，不是基金净值，注明证券代码、日期及单位",
    },
    identities: ["510300"],
  },
  {
    input: {
      kind: "index",
      subjects: ["上证指数(000001.SH)"],
      timeRange: "2026-09-14",
      request: "当日收盘点数，注明代码、日期及单位",
    },
    identities: ["000001"],
  },
  {
    input: {
      kind: "index",
      subjects: ["申万二级半导体行业指数"],
      timeRange: "2026-09-14",
      request: "当日收盘点数，注明指数代码、分类、日期及单位",
    },
    identities: ["半导体"],
  },
];
it.skipIf(process.env.QUANT_MX_ACCEPTANCE !== "1")(
  "retrieves five stock markets, ETF, index and sector through their specific tools",
  async () => {
    const { appRouter } = await import("../src/server/api/root");
    const caller = appRouter.createCaller({ headers: new Headers() });
    for (const { input, identities } of cases) {
      const result = await caller.mxDataQuery(input);
      console.info(
        JSON.stringify({
          tool: result.tool,
          status: result.status,
          message: result.message,
          hash: result.hash,
          data: result.data,
        }),
      );
      expect(["ok", "with-message"]).toContain(result.status);
      const data = JSON.stringify(result.data);
      for (const id of identities) expect(data).toContain(id);
      expect(data).toContain("2026-09-14");
    }
  },
  240000,
);
