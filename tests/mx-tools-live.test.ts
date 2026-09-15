import { writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import samples from "./fixtures/mx-tool-requests.json";
import { mxKinds, mxQuerySchema } from "../src/lib/mx-data";
it.skipIf(process.env.QUANT_MX_TOOLS_ACCEPTANCE !== "1")(
  "十一类工具逐项核对内容与范围警告",
  async () => {
    const { appRouter } = await import("../src/server/api/root");
    const caller = appRouter.createCaller({ headers: new Headers() });
    const report = [];
    for (const sample of samples) {
      const input = mxQuerySchema.parse(sample);
      const result = await caller.mxDataQuery(input);
      report.push({ input, result });
      if (process.env.QUANT_MX_TOOLS_REPORT)
        await writeFile(
          process.env.QUANT_MX_TOOLS_REPORT,
          JSON.stringify(report, null, 2),
        );
      expect(result.tool).toBe(mxKinds[input.kind].tool);
      expect(["ok", "with-message"]).toContain(result.status);
      expect(result.data.length).toBeGreaterThan(0);
      const data = JSON.stringify(result.data);
      const identity = {
        ashare: "300750",
        fund: "510300",
        bond: "23广东11",
        index: "000001",
        hk: "00700",
        us: "AAPL",
        comprehensive: "华为",
        macro: "GDP",
        screener: "代码",
        news: "宁德",
        notice: "宁德",
      }[input.kind];
      expect(data).toContain(identity);
      // 供应商原表可能不满足时间/类别；有范围差异时必须对用户显示。
      if (result.scopeWarnings.length)
        expect(result.status).toBe("with-message");
    }
    expect(new Set(report.map((row) => row.input.kind)).size).toBe(11);
  },
  720000,
);
