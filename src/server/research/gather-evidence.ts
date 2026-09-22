import type { Snapshot, Evidence, Strategy } from "~/lib/domain";
import { queryMcp, mcpConfigured } from "../data-sources/tdx/tdx-mcp-disabled";
import { get, put } from "../db";
import { snapshotEvidence } from "./research";
import { remoteResearchEvidence } from "../infra/evidence";
import { queryFinance } from "../data-sources/hithink/hithink-finance";
import { localIndexEvidence } from "./index-context";
import { settings } from "../infra/settings";
import { queryIndustryContext } from "../data-sources/hithink/hithink-context";
import { queryPriceRsEvidence } from "./price-rs";
import { industryNewsEvidence } from "./industry-news-evidence";
import { tmtCandidateEvidence } from "../strategies/sentiment/tmt-cache";
const setcode = (symbol: string) =>
  symbol.startsWith("sh") ? "1" : symbol.startsWith("sz") ? "0" : "2";
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
