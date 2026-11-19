import { readTdxLocalBlocks, type TdxLocalBlock } from "tstdx/local";
import { z } from "zod";
import { isAShareStockSymbol } from "~/lib/market/security-classification";

export const marketPoolAssociationsInput = z.object({
  symbol: z.string().refine(isAShareStockSymbol, "仅支持 A 股股票"),
});

/** Compact row: membership evidence stays on disk, never in the response. */
export type MarketPoolAssociation = {
  category: "industry" | "concept";
  code: string;
  name: string;
  selectionName: string;
  sourceDate: string | null;
};

export type MarketPoolAssociations = {
  symbol: string;
  status: "ready" | "source-unconfigured" | "source-unavailable";
  /** Read time of the current TDX membership files, not the chart's own date. */
  observedAt: number | null;
  industry: MarketPoolAssociation[];
  concept: MarketPoolAssociation[];
  message?: string;
};

export function selectMarketPoolAssociations(
  blocks: readonly TdxLocalBlock[],
  symbol: string,
) {
  const industry: MarketPoolAssociation[] = [];
  const concept: MarketPoolAssociation[] = [];
  for (const block of blocks) {
    if (block.category !== "industry" && block.category !== "concept") continue;
    if (!block.code || !block.members.includes(symbol)) continue;
    const row: MarketPoolAssociation = {
      category: block.category,
      code: block.code,
      name: block.name,
      selectionName: block.selectionName,
      sourceDate: block.sourceDate,
    };
    (block.category === "industry" ? industry : concept).push(row);
  }
  return { industry, concept };
}

/** Reverse lookup of a stock's supported TDX industry/concept memberships. */
export async function marketPoolAssociations(
  input: unknown,
  tdxRoot: string,
): Promise<MarketPoolAssociations> {
  const { symbol } = marketPoolAssociationsInput.parse(input);
  if (!tdxRoot.trim())
    return {
      symbol,
      status: "source-unconfigured",
      observedAt: null,
      industry: [],
      concept: [],
      message: "未配置本机通达信目录，无法读取所属板块。",
    };
  try {
    const local = await readTdxLocalBlocks(tdxRoot);
    return {
      symbol,
      status: "ready",
      observedAt: local.observedAt,
      ...selectMarketPoolAssociations(local.blocks, symbol),
    };
  } catch (error) {
    return {
      symbol,
      status: "source-unavailable",
      observedAt: null,
      industry: [],
      concept: [],
      message: `通达信板块资料不可用，无法读取所属板块：${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
