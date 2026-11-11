/** Daily simple returns, in ratio units, explicitly aligned by the data adapter. */
export type PortfolioReturn = { date: string; value: number };
export const riskParityPeriod = 60;
export const riskParityRidge = 1e-6;
export const riskParityMaximumCandidates = 200;

/**
 * Equal risk contribution for a sample covariance matrix. The diagonal ridge
 * makes the Gram matrix positive definite, including duplicated assets.
 * CCD solves 0.5*x'Cx - sum(log(x))/n, then normalizes x to long-only weights.
 * Algorithm reference: https://arxiv.org/abs/1311.4057 (no external code copied).
 */
export function riskParityWeights(
  inputs: readonly { symbol: string; returns: readonly PortfolioReturn[] }[],
  asOf: string,
) {
  if (inputs.length > riskParityMaximumCandidates)
    throw new Error(`风险平价最多${riskParityMaximumCandidates}个候选`);
  const cutoff = Date.parse(asOf);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(asOf) ||
    !Number.isFinite(cutoff) ||
    new Date(cutoff).toISOString().slice(0, 10) !== asOf
  )
    throw new Error("风险平价截止日期无效");
  const symbols = new Set<string>();
  const excluded: string[] = [];
  const valid = inputs
    .filter((input) => {
      if (!input.symbol || symbols.has(input.symbol))
        throw new Error("风险平价证券代码为空或重复");
      symbols.add(input.symbol);
      const rows = input.returns;
      let previous = "";
      for (const row of rows) {
        const time = Date.parse(row.date);
        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
          !Number.isFinite(time) ||
          new Date(time).toISOString().slice(0, 10) !== row.date ||
          row.date <= previous ||
          row.date > asOf ||
          !Number.isFinite(row.value) ||
          row.value <= -1
        )
          throw new Error("风险平价收益日期、顺序或数值无效");
        previous = row.date;
      }
      const eligible =
        rows.length === riskParityPeriod && rows.at(-1)?.date === asOf;
      if (!eligible) excluded.push(input.symbol);
      return eligible;
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const dates = valid[0]?.returns.map((row) => row.date);
  if (
    valid.some((input) =>
      input.returns.some((row, i) => row.date !== dates![i]),
    )
  )
    throw new Error("风险平价需要完全对齐的60日收益，不补齐缺失行情");
  const centered = valid.map((input) => {
    const mean =
      input.returns.reduce((sum, row) => sum + row.value, 0) / riskParityPeriod;
    return input.returns.map((row) => row.value - mean);
  });
  const active = valid
    .map((input, index) => ({ input, values: centered[index]! }))
    .filter(({ input, values }) => {
      const variance = values.reduce((sum, value) => sum + value * value, 0);
      if (
        !(variance > 0) ||
        !input.returns.some((row) => row.value !== input.returns[0]!.value)
      ) {
        excluded.push(input.symbol);
        return false;
      }
      return true;
    });
  const n = active.length;
  if (!n) return { weights: [], excluded, diagnostics: null };
  const sample = active.map((a) =>
    active.map(
      (b) =>
        a.values.reduce((sum, value, k) => sum + value * b.values[k]!, 0) /
        (riskParityPeriod - 1),
    ),
  );
  const ridge =
    (sample.reduce((sum, row, i) => sum + row[i]!, 0) / n) * riskParityRidge;
  const covariance = sample.map((row, i) =>
    row.map((value, j) => value + (i === j ? ridge : 0)),
  );
  // Scale the covariance to improve arithmetic conditioning; weights are invariant.
  const scale = Math.max(...covariance.map((row, i) => row[i]!));
  const c = covariance.map((row) => row.map((value) => value / scale));
  const x = c.map((row, i) => 1 / Math.sqrt(n * row[i]!));
  const cx = c.map((row) =>
    row.reduce((sum, value, i) => sum + value * x[i]!, 0),
  );
  let error = Infinity,
    iterations = 0;
  for (; iterations < 10000; iterations++) {
    for (let i = 0; i < n; i++) {
      const diagonal = c[i]![i]!,
        off = cx[i]! - diagonal * x[i]!;
      const root = Math.sqrt(off * off + (4 * diagonal) / n);
      const next =
        off >= 0 ? 2 / n / (root + off) : (root - off) / (2 * diagonal);
      const change = next - x[i]!;
      x[i] = next;
      for (let j = 0; j < n; j++) cx[j] = cx[j]! + c[j]![i]! * change;
    }
    const totalRisk = x.reduce((sum, value, i) => sum + value * cx[i]!, 0);
    error = Math.max(
      ...x.map((value, i) => Math.abs((value * cx[i]!) / totalRisk - 1 / n)),
    );
    if (error <= 1e-8) break;
  }
  if (!Number.isFinite(error) || error > 1e-8)
    throw new Error("风险平价未收敛，不退化为等权或反波动配置");
  const total = x.reduce((sum, value) => sum + value, 0);
  return {
    weights: active.map(({ input }, i) => ({
      symbol: input.symbol,
      weight: x[i]! / total,
    })),
    excluded,
    diagnostics: {
      covariance,
      ridge,
      iterations: iterations + 1,
      maxRiskShareError: error,
    },
  };
}
