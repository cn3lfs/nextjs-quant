import type { BenchmarkBasis } from "~/server/research/validation-model";

const labels: Record<BenchmarkBasis, string> = {
  "price-index-ex-dividends": "价格指数（不含股息）",
  "total-return": "total-return",
};

export function benchmarkBasisLabel(basis: BenchmarkBasis | null | undefined) {
  return basis == null ? "未知口径" : labels[basis];
}
