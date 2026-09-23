import { expect, it } from "vitest";
import { westockKlines } from "../../src/server/data-sources/westock/westock-adapter";
import {
  sourceAcceptanceSamples,
  sourceAcceptancePeriods,
} from "../data-source-acceptance";

// The adapter, not raw CLI nonemptiness, is the application acceptance boundary.
it.skipIf(process.env.QUANT_WESTOCK_ACCEPTANCE !== "1")(
  "accepts all eight asset classes or explicitly declares unsupported periods",
  async () => {
    const reports = await Promise.all(
      sourceAcceptancePeriods.map((period) =>
        westockKlines({
          symbols: sourceAcceptanceSamples.map((s) => s.symbol),
          period,
          limit: 3,
        }),
      ),
    );
    for (const report of reports) {
      console.info(
        JSON.stringify({
          period: report.period,
          requests: report.requests.length,
          warnings: report.warnings,
          items: report.items.map((item) => ({
            symbol: item.symbol,
            status: item.status,
            ...(item.status === "ok"
              ? { last: item.bars.at(-1) }
              : { message: item.message }),
          })),
        }),
      );
      for (const item of report.items) {
        const unsupported =
          report.period === "5m" &&
          ["bj920002", "sh000001", "pt01801081"].includes(item.symbol);
        expect(item.status, `${report.period}/${item.symbol}`).toBe(
          unsupported ? "unsupported" : "ok",
        );
        if (item.status === "ok") expect(item.bars).toHaveLength(3);
      }
    }
  },
  60000,
);
it.skipIf(process.env.QUANT_WESTOCK_ACCEPTANCE !== "1")(
  "recovers ETF in the observed index-sector-ETF omission case",
  async () => {
    for (const period of ["day", "week"] as const) {
      const result = await westockKlines({
        symbols: ["sh000001", "pt01801081", "sh510300"],
        period,
        limit: 3,
      });
      console.info(
        JSON.stringify({
          period,
          requests: result.requests,
          warnings: result.warnings,
        }),
      );
      expect(result.items.map((item) => [item.symbol, item.status])).toEqual([
        ["sh000001", "ok"],
        ["pt01801081", "ok"],
        ["sh510300", "ok"],
      ]);
      expect(result.requests.length).toBeLessThanOrEqual(2);
    }
  },
  60000,
);
