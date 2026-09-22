import { createHash } from "node:crypto";
import type { ParsedClsReport } from "./cls-report-parser";
import type { ClsSampleCandidate } from "./cls-sample";

export async function clsCandidates(
  report: ParsedClsReport,
  deps: {
    securities: { symbol: string; name: string }[];
    pools: { category: "industry" | "concept"; name: string }[];
    pool: (
      category: "industry" | "concept",
      name: string,
    ) => Promise<{ members: string[]; hash: string }>;
    ranking: { symbol: string; rps: number }[];
    rpsDate: string;
    rpsHash: string;
  },
) {
  const candidates: ClsSampleCandidate[] = [];
  const unmatched: { sectionId: string; reason: string }[] = [];
  const evidenceHashes: string[] = [deps.rpsHash];
  const symbols = new Set(deps.securities.map((security) => security.symbol));
  const ranks = new Map(deps.ranking.map((row) => [row.symbol, row.rps]));
  for (const [index, section] of report.sections.entries()) {
    if (!["bullish", "bearish"].includes(section.direction)) continue;
    const priority =
      (section.confidence === "high"
        ? 0
        : section.confidence === "medium"
          ? 1
          : section.confidence === "low"
            ? 2
            : 3) *
        10000 +
      index;
    // Only explicitly labelled recommendation/attention rows qualify. General
    // news mentions, risk lists and whole-section company names do not.
    const recommendation = section.text
      .split("\n")
      .filter((line) =>
        /(?:推荐标的|重点关注标的|首选标的|推荐个股)[*\s]*[：:]/.test(line),
      );
    let explicit = false;
    for (const line of recommendation) {
      const matched = deps.securities.filter((security) => {
        const code = security.symbol.slice(2);
        return (
          new RegExp(`(?:^|[^0-9])${code}(?:[^0-9]|$)`).test(line) ||
          (security.name.length >= 2 && line.includes(security.name))
        );
      });
      for (const security of matched) {
        // Ambiguous names are not resolved by arbitrarily choosing a code.
        if (
          !line.includes(security.symbol.slice(2)) &&
          deps.securities.filter((entry) => entry.name === security.name)
            .length !== 1
        )
          continue;
        if (!/^(sh|sz)\d{6}$/.test(security.symbol)) continue;
        explicit = true;
        candidates.push({
          symbol: security.symbol,
          sectionId: section.id,
          direction: section.direction,
          priority,
          basis: "explicit-recommendation",
          rps: ranks.get(security.symbol) ?? null,
          evidence: line,
        });
      }
    }
    if (explicit) continue;
    const pools = deps.pools.filter((pool) => pool.name === section.name);
    if (pools.length !== 1) {
      unmatched.push({
        sectionId: section.id,
        reason: pools.length
          ? "板块名称跨分类重复，需明确映射"
          : `未匹配板块：${section.name}`,
      });
      continue;
    }
    try {
      const pool = await deps.pool(pools[0]!.category, pools[0]!.name);
      evidenceHashes.push(pool.hash);
      for (const symbol of new Set(pool.members)) {
        const rps = ranks.get(symbol);
        if (
          !symbols.has(symbol) ||
          !/^(sh|sz)\d{6}$/.test(symbol) ||
          rps === undefined
        )
          continue;
        candidates.push({
          symbol,
          sectionId: section.id,
          direction: section.direction,
          priority,
          basis: "sector-rps",
          rps,
          evidence: `${deps.rpsDate} 全沪深RPS50；板块 ${section.name}；${pool.hash}`,
        });
      }
    } catch (error) {
      unmatched.push({
        sectionId: section.id,
        reason: error instanceof Error ? error.message : "板块读取失败",
      });
    }
  }
  return {
    candidates,
    unmatched,
    poolHash: createHash("sha256")
      .update(JSON.stringify({ evidenceHashes, candidates }))
      .digest("hex"),
  };
}
