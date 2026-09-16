import type { Bar } from "./domain";
import type { ResearchManagement } from "./research-management";
import { researchMarketEnvironment } from "./research-market-regime";

export const researchMarketChopVersion = "research-market-chop-1";
export function researchMarketChop(
  benchmark: { symbol: string; bars: readonly Bar[] } | undefined,
  calendar: readonly string[],
  config: NonNullable<ResearchManagement["marketChop"]>,
) {
  const observations = researchMarketEnvironment(benchmark, calendar, {
    kind: "ma20",
    neutralBand: 0,
    weakWeight: 0,
  });
  return observations.map((row, i) => {
    const window = observations.slice(
      Math.max(0, i - config.window + 1),
      i + 1,
    );
    const ready =
      window.length === config.window &&
      window.every((r) => r.regime !== "unknown");
    const distances = ready ? window.map((r) => r.close! / r.ma20! - 1) : [];
    // Exact touches do not cross and break adjacent crossing pairs.
    const crosses = ready
      ? distances.slice(1).filter((d, n) => d * distances[n]! < 0).length
      : null;
    const near = ready
      ? distances.every((d) => Math.abs(d) <= config.nearBand + 1e-12)
      : null;
    const state = !ready
      ? "unknown"
      : near && crosses! >= config.minCrosses
        ? "choppy"
        : "clear";
    return {
      date: row.date,
      observedDate: row.observedDate,
      benchmark: row.benchmark,
      windowStart: ready ? window[0]!.observedDate : null,
      state,
      crosses,
      near,
      close: row.close,
      ma20: row.ma20,
      reason:
        state === "unknown"
          ? "大盘震荡过滤缺少连续有效基准日线，暂停买入"
          : state === "choppy"
            ? "大盘在MA20附近反复穿越，退出持仓并暂停买入"
            : null,
    };
  });
}
