import { createHash } from "node:crypto";
import type { Metrics, Period, Strategy } from "~/lib/domain";
export type PoolObservation = {
  symbol: string;
  metrics: Metrics;
  amount: number;
  hash: string;
};
export function summarizePool(
  symbols: string[],
  rows: PoolObservation[],
  asOf: string | null,
  period: Period,
  strategy: Strategy,
) {
  const ordered = [...rows].sort((a, b) => a.symbol.localeCompare(b.symbol));
  const changes = rows.map((row) => row.metrics.change).sort((a, b) => a - b);
  const count = rows.length;
  const hash = (value: unknown) =>
    createHash("sha256").update(JSON.stringify(value)).digest("hex");
  return {
    version: "pool-breadth-1",
    scope: "submitted-universe",
    asOf,
    period,
    universeHash: hash([...new Set(symbols)].sort()),
    observationHash: hash(ordered),
    requested: new Set(symbols).size,
    observed: count,
    up: changes.filter((change) => change > 0).length,
    down: changes.filter((change) => change < 0).length,
    flat: changes.filter((change) => change === 0).length,
    aboveFast: rows.filter((row) => row.metrics.close > row.metrics.fast)
      .length,
    aboveSlow: rows.filter((row) => row.metrics.close > row.metrics.slow)
      .length,
    fastBars: strategy.fast,
    slowBars: strategy.slow,
    meanChange: count
      ? changes.reduce((sum, change) => sum + change, 0) / count
      : null,
    medianChange: count
      ? (changes[Math.floor((count - 1) / 2)]! +
          changes[Math.floor(count / 2)]!) /
        2
      : null,
    amount: ordered.reduce((sum, row) => sum + row.amount, 0),
    amountUnit: "CNY",
    changeUnit: "percent",
    warnings: [
      "只代表本次提交证券池中的同一时点有效记录，不代表全市场或指数。",
      "涨跌为相邻 K 线收盘变化；分钟周期不是日涨跌。均线周期采用本次策略参数。",
      "隔离记录和读取错误不参与统计；没有行业分类、独立指数或资金流数据，不能据此推断板块热度或机构资金。",
    ],
  };
}
export type PoolContext = ReturnType<typeof summarizePool>;
