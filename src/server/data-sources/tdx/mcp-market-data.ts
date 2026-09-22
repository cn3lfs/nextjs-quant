import { createHash } from "node:crypto";
import type { Bar, Period, Snapshot } from "~/lib/domain";
import { symbolSchema } from "~/lib/domain";
import { queryMcp } from "~/server/data-sources/tdx/tdx-mcp-disabled";
export interface MarketDataProvider {
  readonly name: string;
  history(symbol: string, period: Period): Promise<Snapshot>;
}
const setcode = (symbol: string) =>
  symbol.startsWith("sh") ? "1" : symbol.startsWith("sz") ? "0" : "2";
function numericField(value: unknown): number {
  if (typeof value !== "number" && typeof value !== "string") return NaN;
  if (typeof value === "string" && !value.trim()) return NaN;
  return Number(value);
}
export function normalizeMcpBars(data: unknown, period: Period): Bar[] {
  const object = data as { Rows?: Record<string, unknown>[] };
  if (!Array.isArray(object?.Rows)) throw new Error("MCP K 线结构不受支持");
  const bars = object.Rows.map((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row))
      throw new Error("MCP K 线行结构不受支持");
    const raw = String(row.Data),
      day = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
    const parsedDay = Date.parse(`${day}T00:00:00Z`);
    if (
      !/^\d{8}$/.test(raw) ||
      !Number.isFinite(parsedDay) ||
      new Date(parsedDay).toISOString().slice(0, 10) !== day
    )
      throw new Error("MCP 行情日期不合法");
    const second = numericField(row.Second);
    if (
      period === "5m" &&
      (!Number.isInteger(second) ||
        second < 0 ||
        second >= 86400 ||
        second % 300 !== 0)
    )
      throw new Error("MCP 分钟时间不合法");
    const date =
      period === "day"
        ? day
        : `${day}T${String(Math.floor(second / 3600)).padStart(2, "0")}:${String(Math.floor((second % 3600) / 60)).padStart(2, "0")}:00+08:00`;
    const b: Bar = {
      date,
      open: numericField(row.Open),
      high: numericField(row.High),
      low: numericField(row.Low),
      close: numericField(row.Close),
      volume: numericField(row.RawVolume),
      amount: numericField(row.Amount),
    };
    if (
      !Number.isFinite(Date.parse(date)) ||
      ![b.open, b.high, b.low, b.close].every(
        (n) => Number.isFinite(n) && n > 0,
      ) ||
      !Number.isFinite(b.volume) ||
      b.volume < 0 ||
      !Number.isFinite(b.amount) ||
      b.amount < 0 ||
      b.low > Math.min(b.open, b.close) ||
      b.high < Math.max(b.open, b.close)
    )
      throw new Error("MCP 行情字段或原始成交量缺失，拒绝混用口径");
    return b;
  });
  if (!bars.length) throw new Error("MCP 没有返回行情");
  for (let i = 1; i < bars.length; i++)
    if (bars[i]!.date <= bars[i - 1]!.date)
      throw new Error("MCP 行情时间倒序或重复");
  return bars;
}
export const mcpProvider: MarketDataProvider = {
  name: "tdx-mcp",
  async history(symbol, period) {
    symbolSchema.parse(symbol);
    const result = await queryMcp("tdx_kline", {
      code: symbol.slice(2),
      setcode: setcode(symbol),
      period: period === "day" ? "4" : "0",
      wantNum: "1000",
      tqFlag: "0",
    });
    const bars = normalizeMcpBars(result, period),
      hash = createHash("sha256").update(JSON.stringify(bars)).digest("hex");
    return {
      id: `snapshot-mcp-${symbol}-${period}-${hash.slice(0, 16)}`,
      symbol,
      name: (result as { AttachInfo?: { Name?: string } })?.AttachInfo?.Name,
      period,
      source: "tdx-mcp",
      adjustment: "none",
      createdAt: Date.now(),
      bars,
      hash,
    };
  },
};
