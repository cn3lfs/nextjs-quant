import type { Period, Snapshot } from "~/lib/domain";
import { mcpConfigured } from "./mcp";
import { mcpProvider } from "./market-data";
import { onlineChartSnapshot } from "./online-chart-data";

/** Use the application's existing TDX session, including token-file rotation. */
export async function preferredOnlineChart(
  symbol: string,
  period: Period,
): Promise<Snapshot> {
  let reason = "尚未配置通达信 MCP";
  if (await mcpConfigured()) {
    try {
      return await mcpProvider.history(symbol, period);
    } catch {
      reason = "通达信 MCP 行情读取失败";
    }
  }
  return {
    ...(await onlineChartSnapshot(symbol, period)),
    sourceNote: `${reason}，本次使用东方财富在线行情`,
  };
}
