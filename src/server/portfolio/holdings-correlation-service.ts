import { z } from "zod";
import {
  holdingsCorrelation,
  type HoldingsCorrelationInput,
} from "~/lib/holdings-correlation";
export const holdingsCorrelationPageSchema = z.object({
  pageIndex: z.number().int().min(0).max(1000000).default(0),
  pageSize: z.number().int().min(1).max(20).default(10),
  desc: z.boolean().default(false),
});
export function pageHoldingsCorrelation(
  input: HoldingsCorrelationInput,
  page: z.infer<typeof holdingsCorrelationPageSchema>,
) {
  const result = holdingsCorrelation(input);
  const indices = result.symbols.map((_, i) => i);
  if (page.desc) indices.reverse();
  const selected = indices.slice(
    page.pageIndex * page.pageSize,
    (page.pageIndex + 1) * page.pageSize,
  );
  return {
    symbols: result.symbols,
    rows: selected.map((i) => ({
      symbol: result.symbols[i]!,
      cells: result.matrix[i]!,
    })),
    rowCount: result.symbols.length,
    averagePairwise: result.averagePairwise,
    pairCount: result.pairCount,
  };
}
