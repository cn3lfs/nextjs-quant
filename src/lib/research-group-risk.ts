import type { Bar } from "./domain";
import type { BacktestCosts } from "./backtest-costs";
import { plannedStopRisk } from "./research-risk";
import {
  contextRiskPoint,
  type ContextRiskInput,
} from "./research-context-risk";

/** Candidate-connected component, including transitive correlation, never a sum of independent bets. */
export function researchGroupRisk(
  symbol: string,
  date: string,
  calendar: readonly string[],
  series: ReadonlyMap<string, readonly Bar[]>,
  inputs: readonly ContextRiskInput[],
  held: readonly {
    symbol: string;
    quantity: number;
    entry: number;
    stop: number | null;
  }[],
  equity: number,
  costs: BacktestCosts,
) {
  const missing = (reason: string) => ({
    reason,
    members: [] as string[],
    used: null,
    fraction: null,
  });
  if (!Number.isFinite(equity) || equity <= 0) return missing("权益无效");
  const symbols = [...new Set([symbol, ...held.map((h) => h.symbol)])].sort();
  const dates = calendar.filter((d) => d <= date).slice(-61);
  if (dates.length !== 61) return missing("缺61研究日相关性窗口");
  const sectors = new Map<string, string>(),
    returns = new Map<string, number[]>();
  for (const code of symbols) {
    const point = contextRiskPoint(
      "rk-sector-risk",
      inputs,
      code,
      date,
      calendar,
    );
    if (point.status !== "available" || !point.evidence.sector)
      return missing("缺当时行业归属");
    sectors.set(code, point.evidence.sector);
    const indexed = new Map((series.get(code) ?? []).map((b) => [b.date, b]));
    const closes = dates.map((d) => indexed.get(d));
    if (
      closes.some(
        (b) =>
          !b ||
          ![b.close, b.open, b.high, b.low, b.volume].every(
            (v) => Number.isFinite(v) && v > 0,
          ) ||
          b.low > Math.min(b.open, b.close) ||
          b.high < Math.max(b.open, b.close),
      )
    )
      return missing("相关窗口缺日或非法行情");
    returns.set(
      code,
      closes.slice(1).map((b, i) => b!.close / closes[i]!.close - 1),
    );
  }
  const edges = new Map(symbols.map((s) => [s, new Set<string>()]));
  for (let i = 0; i < symbols.length; i++)
    for (let j = i + 1; j < symbols.length; j++) {
      const a = symbols[i]!,
        b = symbols[j]!;
      let connected = sectors.get(a) === sectors.get(b);
      if (!connected) {
        const x = returns.get(a)!,
          y = returns.get(b)!;
        const mx = x.reduce((s, v) => s + v, 0) / 60,
          my = y.reduce((s, v) => s + v, 0) / 60;
        let xy = 0,
          xx = 0,
          yy = 0;
        for (let k = 0; k < 60; k++) {
          const dx = x[k]! - mx,
            dy = y[k]! - my;
          xy += dx * dy;
          xx += dx * dx;
          yy += dy * dy;
        }
        if (xx <= 1e-20 || yy <= 1e-20)
          return missing("零方差收益无法证明低相关");
        connected = xy / Math.sqrt(xx * yy) >= 0.8 - 1e-12;
      }
      if (connected) {
        edges.get(a)!.add(b);
        edges.get(b)!.add(a);
      }
    }
  const members = new Set([symbol]),
    queue = [symbol];
  for (let i = 0; i < queue.length; i++)
    for (const code of edges.get(queue[i]!)!)
      if (!members.has(code)) {
        members.add(code);
        queue.push(code);
      }
  let used = 0;
  for (const h of held.filter((h) => members.has(h.symbol))) {
    if (
      h.stop == null ||
      ![h.quantity, h.entry, h.stop].every((v) => Number.isFinite(v) && v > 0)
    )
      return missing("持仓风险记录不完整");
    used += Math.max(0, plannedStopRisk(h.quantity, h.entry, h.stop, costs));
  }
  return {
    reason: null,
    members: [...members].sort(),
    used,
    fraction: Math.max(0, equity * 0.03 - used) / equity,
  };
}
