import { parseTencentChart } from "../src/server/market/free-chart-sources";
import type { ChartPeriod } from "../src/lib/chart/chart-view";

/** Minimum representative matrix for every source; support must be disclosed per cell. */
export const sourceAcceptanceSamples = [
  { kind: "sh-main", symbol: "sh600000", name: "浦发银行" },
  { kind: "sz-main", symbol: "sz000001", name: "平安银行" },
  { kind: "chinext", symbol: "sz300750", name: "宁德时代" },
  { kind: "star", symbol: "sh688981", name: "中芯国际" },
  { kind: "beijing", symbol: "bj920002", name: "万达轴承" },
  { kind: "index", symbol: "sh000001", name: "上证指数" },
  { kind: "sector", symbol: "pt01801081", name: "半导体（申万二级）" },
  { kind: "etf", symbol: "sh510300", name: "沪深300ETF华泰柏瑞" },
] as const;
export const sourceAcceptancePeriods = ["day", "week", "5m"] as const;

/** A nonempty batch is insufficient: every requested security needs valid data. */
export function validateWestockBatch(
  raw: unknown,
  symbols: readonly string[],
  period: ChartPeriod,
) {
  if (!Array.isArray(raw)) throw new Error("批量响应不是数组");
  if (raw.some((r) => !r || !symbols.includes(r.symbol)))
    throw new Error("响应含未请求或未标明身份的品种");
  return symbols.map((symbol) => {
    const rows = raw.filter((r) => r.symbol === symbol);
    if (!rows.length)
      return { symbol, ok: false as const, reason: "批量响应遗漏品种" };
    try {
      const bars = parseTencentChart(rows, symbol, period);
      if (bars.length !== 3) throw new Error("未返回要求的3根行情");
      return {
        symbol,
        ok: true as const,
        count: bars.length,
        latest: bars.at(-1)!,
      };
    } catch (error) {
      return {
        symbol,
        ok: false as const,
        reason: error instanceof Error ? error.message : "行情校验失败",
      };
    }
  });
}
