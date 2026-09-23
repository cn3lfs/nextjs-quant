import type { Bar } from "~/lib/domain";
import { isMinutePeriod, type ChartPeriod } from "~/lib/chart/chart-view";
import { normalizeMcpBars } from "~/server/data-sources/tdx/mcp-market-data";
import { queryMcp } from "../data-sources/tdx/tdx-mcp-disabled";
import { eastmoneyKlines } from "../data-sources/eastmoney/eastmoney-adapter";

const codes = {
  day: "4",
  week: "5",
  month: "6",
  "5m": "0",
  "15m": "1",
  "30m": "2",
  "60m": "3",
};
/** MCP's live lunch record uses 13:00 for the last morning bar (verified by
 * matching the 5m constituents to native 15m/60m OHLCV). Historical bars use 11:30.
 * This is a timestamp correction within one provider, never a price splice. */
export function normalizeChartMcpPage(raw: unknown, period: ChartPeriod) {
  const bars = normalizeMcpBars(raw, isMinutePeriod(period) ? "5m" : "day");
  if (!isMinutePeriod(period)) return bars;
  for (const bar of bars) {
    if (bar.date.includes("T13:00:00")) {
      const corrected = bar.date.replace("T13:00:00", "T11:30:00");
      if (bars.some((b) => b.date === corrected))
        throw new Error("MCP 午休时间标签冲突");
      bar.date = corrected;
    }
    const minute =
      Number(bar.date.slice(11, 13)) * 60 + Number(bar.date.slice(14, 16));
    const start =
      minute > 570 && minute <= 690
        ? 570
        : minute > 780 && minute <= 900
          ? 780
          : -1;
    if (start < 0 || (minute - start) % Number.parseInt(period))
      throw new Error("MCP 目标周期时间不在交易边界");
  }
  return bars;
}
export async function mcpChartHistory(
  symbol: string,
  period: ChartPeriod,
  limit: number,
  query = queryMcp,
) {
  const collected = new Map<string, Bar>();
  let exhausted = false;
  for (let offset = 0; offset < limit; offset += 700) {
    const raw = await query("tdx_kline", {
      code: symbol.slice(2),
      setcode: symbol.startsWith("sh") ? "1" : "0",
      period: codes[period],
      wantNum: "700",
      startxh: String(offset),
      tqFlag: "0",
    });
    if (
      Array.isArray((raw as { Rows?: unknown[] })?.Rows) &&
      !(raw as { Rows: unknown[] }).Rows.length
    ) {
      exhausted = true;
      break;
    }
    const page = normalizeChartMcpPage(raw, period);
    const size = collected.size;
    for (const bar of page) {
      const prior = collected.get(bar.date);
      if (prior && JSON.stringify(prior) !== JSON.stringify(bar))
        throw new Error("MCP 分页重叠行情发生变化，请刷新");
      collected.set(bar.date, bar);
    }
    if (collected.size === size || page.length < 700) {
      exhausted = true;
      break;
    }
  }
  if (!collected.size) throw new Error("MCP 未返回目标周期行情");
  return {
    bars: [...collected.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-limit),
    historyExhausted: exhausted,
    source: "tdx-mcp",
    volumeUnit: "源单位",
  };
}
/** 只取最近 count 根：盘中补当日增量时用一次请求，不重取整段历史。 */
export async function mcpLatestBars(
  symbol: string,
  period: ChartPeriod,
  count: number,
  query = queryMcp,
) {
  if (!Number.isInteger(count) || count < 1 || count > 1000)
    throw new Error("MCP 尾段 K 线数量必须在 1..1000");
  const raw = await query("tdx_kline", {
    code: symbol.slice(2),
    setcode: symbol.startsWith("sh") ? "1" : "0",
    period: codes[period],
    wantNum: String(count),
    startxh: "0",
    tqFlag: "0",
  });
  const bars = normalizeChartMcpPage(raw, period).sort((a, b) =>
    a.date.localeCompare(b.date),
  );
  if (!bars.length) throw new Error("MCP 未返回目标周期行情");
  return bars;
}
/** `beg` 限定起始日期：东方财富的 `lmt` 不生效，实测 lmt=12 仍返回全部历史，
 * 只补尾部时必须用日期截断，否则响应和重叠校验都落到全history上。 */
export async function onlinePeriodHistory(
  symbol: string,
  period: ChartPeriod,
  limit: number,
  beg = "0",
) {
  const result = await eastmoneyKlines({
    symbols: [symbol],
    period,
    limit,
    ...(beg !== "0"
      ? {
          start:
            beg.length === 8
              ? `${beg.slice(0, 4)}-${beg.slice(4, 6)}-${beg.slice(6, 8)}`
              : beg,
        }
      : {}),
  });
  const item = result.items[0]!;
  if (item.status !== "ok") throw new Error(item.message);
  return {
    name: item.name,
    bars: item.bars,
    source: result.source,
    volumeUnit: result.volumeUnit,
    historyExhausted: item.historyExhausted,
    sourceNote: `${result.version}；${result.warnings.join("；")}`,
  };
}
