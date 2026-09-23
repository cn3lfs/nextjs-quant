import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { analyzeCzsc, closeCzsc } from "../../../src/server/strategies/chan/czsc";
import { analyzeBreakout } from "../../../src/server/strategies/breakout/breakout";
import { closeMcp } from "../../../src/server/mcp";
import { mcpChartHistory } from "../../../src/server/market/chart-history";
import { chartPeriodSchema } from "../../../src/lib/chart/chart-view";
it.skipIf(!process.env.QUANT_MCP_AUDIT_ROOT)(
  "loads seven native periods through the app MCP",
  async () => {
    const directory = join(process.env.QUANT_DATA_DIR!, "credentials");
    await mkdir(directory, { recursive: true });
    await copyFile(
      join(process.env.QUANT_MCP_AUDIT_ROOT!, "credentials", "mcp.bin"),
      join(directory, "mcp.bin"),
    );
    try {
      for (const symbol of ["sh600000", "sh000001"])
        for (const period of chartPeriodSchema.options) {
          const started = Date.now();
          const result = await mcpChartHistory(symbol, period, 2000);
          expect(result.bars.length).toBeGreaterThan(60);
          const structure = await analyzeCzsc(result.bars);
          expect(structure.families).toHaveLength(2);
          const breakout = analyzeBreakout(result.bars, 0, true);
          expect(breakout.points).toHaveLength(result.bars.length);
          expect(breakout.latest?.missing.join(" ")).not.toContain("日期无效");
          console.info({
            symbol,
            period,
            bars: result.bars.length,
            first: result.bars[0]?.date,
            last: result.bars.at(-1)?.date,
            historyExhausted: result.historyExhausted,
            ms: Date.now() - started,
          });
        }
    } finally {
      await closeMcp();
      await closeCzsc();
    }
  },
  120000,
);
