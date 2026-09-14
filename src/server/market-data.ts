import { createHash } from "node:crypto";
import type { Bar, Period, Snapshot, Evidence, Strategy } from "~/lib/domain";
import { symbolSchema } from "~/lib/domain";
import { queryMcp, mcpConfigured } from "./tdx-mcp-disabled";
import { get, put } from "./db";
import { snapshotEvidence } from "./research";
import { remoteResearchEvidence } from "./evidence";
import { queryFinance } from "./hithink-finance";
import { localIndexEvidence } from "./index-context";
import { settings } from "./settings";
import { queryIndustryContext } from "./hithink-context";
import { queryPriceRsEvidence } from "./price-rs";
import { industryNewsEvidence } from "./industry-news-evidence";
import { tmtCandidateEvidence } from "./tmt-cache";
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
export async function gatherEvidence(
  source: Snapshot,
  strategy: Strategy,
  signal?: AbortSignal,
  options: { relativeStrength?: boolean } = {},
): Promise<Evidence[]> {
  const evidence = snapshotEvidence(source, strategy);
  const index = await localIndexEvidence(
    source,
    source.dataRoot ?? settings().tdxRoot,
  );
  if (index) evidence.push(index);
  signal?.throwIfAborted();
  if (source.historicalAsOf) return evidence;
  if (options.relativeStrength && process.env.IWENCAI_API_KEY) {
    try {
      evidence.push(await queryPriceRsEvidence(source, signal));
    } catch {
      signal?.throwIfAborted();
      evidence.push({
        id: `missing-rs-${source.symbol}`,
        source: "RS可用性检查",
        asOf: "未知",
        text: "全市场RS排名未能核验，不得推断RS达标。",
      });
    }
  }
  if (process.env.IWENCAI_API_KEY) {
    const contextId = `hithink-industry-v2-${source.symbol}`;
    const cachedContext = get<{ entries: Evidence[]; fetchedAt: number }>(
      contextId,
    );
    try {
      signal?.throwIfAborted();
      if (cachedContext && Date.now() - cachedContext.fetchedAt < 1800000)
        evidence.push(...cachedContext.entries);
      else {
        const entries = await queryIndustryContext(source.symbol, signal);
        if (entries.length === 2 && entries.every((e) => e.envelope))
          put("evidence", contextId, { entries, fetchedAt: Date.now() });
        evidence.push(...entries);
      }
    } catch {
      signal?.throwIfAborted();
      evidence.push({
        id: `missing-industry-context-${source.symbol}`,
        source: "行业资料可用性检查",
        asOf: "未知",
        text: "当前行业归属查询失败，不得推断行业背景。",
      });
    }
    for (const profile of ["overview", "growth"] as const) {
      const id = `hithink-finance-v4-${profile}-${source.symbol}`;
      const cached = get<Evidence & { fetchedAt: number }>(id);
      try {
        signal?.throwIfAborted();
        if (
          cached?.envelope?.version === "evidence-1" &&
          Date.now() - cached.fetchedAt < 1800000
        ) {
          evidence.push(cached);
        } else {
          const entry = await queryFinance(source.symbol, signal, profile);
          put("evidence", id, entry);
          evidence.push(entry);
        }
      } catch {
        signal?.throwIfAborted();
        evidence.push({
          id: `missing-hithink-finance-${profile}-${source.symbol}`,
          source: "数据可用性检查",
          asOf: new Date().toISOString(),
          text: `同花顺问财 ${profile === "growth" ? "多季度增长" : "财务概览"} 查询失败或身份不匹配；不得推断缺失财务事实。`,
        });
      }
    }
  }
  evidence.push(...industryNewsEvidence(source, evidence));
  evidence.push(...(await tmtCandidateEvidence(source, evidence, signal)));
  if (!(await mcpConfigured())) return evidence;
  const queries = [
    {
      tool: "tdx_quotes",
      args: {
        code: source.symbol.slice(2),
        setcode: setcode(source.symbol),
        hasCwInfo: "1",
      },
    },
    {
      tool: "wenda_notice_query",
      args: {
        query: `${source.symbol.slice(2)} 最近公司公告及重大风险`,
        symbol: source.symbol.slice(2),
      },
    },
  ] as const;
  for (const query of queries) {
    if (signal?.aborted) throw new Error("已取消");
    const id = `evidence-v1-${source.symbol}-${query.tool}`,
      cached = get<Evidence & { fetchedAt: number }>(id);
    const ttl = query.tool === "tdx_quotes" ? 30000 : 1800000;
    if (
      cached?.envelope?.version === "evidence-1" &&
      Date.now() - cached.fetchedAt < ttl
    ) {
      evidence.push(cached);
      continue;
    }
    try {
      const data = await queryMcp(query.tool, query.args, signal),
        now = Date.now(),
        entry = remoteResearchEvidence(source.symbol, query.tool, data, now);
      put("evidence", id, entry);
      evidence.push(entry);
    } catch {
      if (signal?.aborted) throw new Error("已取消");
      evidence.push({
        id: `missing-${query.tool}`,
        source: "数据可用性检查",
        asOf: new Date().toISOString(),
        text: `${query.tool} 查询失败；不得推断缺失的财务或公告事实。`,
      });
    }
  }
  return evidence;
}
