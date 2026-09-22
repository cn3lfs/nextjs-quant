import type { ResearchSpec } from "~/lib/strategy-research";
import type { readMarketPool } from "../market/market-pool-files";
export function requireA500Selection(
  spec: ResearchSpec,
  pool: Awaited<ReturnType<typeof readMarketPool>>,
) {
  if (
    spec.pool?.category !== "index" ||
    !["中证A500", "通达信·成分·中证A500"].includes(spec.pool.name) ||
    pool.category !== "index" ||
    pool.name !== spec.pool.name
  )
    throw new Error("新研究使用中证A500成分清单");
  if (pool.members.length !== 500 || new Set(pool.members).size !== 500)
    throw new Error("A500名单应有500只不重复成分，请更新名单后重试");
  const members = new Set(pool.members);
  if (
    !spec.symbols?.length ||
    spec.symbols.some((symbol) => !members.has(symbol))
  )
    throw new Error("请从已加载的A500清单选择研究品种");
}
