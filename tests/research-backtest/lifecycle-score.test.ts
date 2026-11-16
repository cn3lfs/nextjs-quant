import { expect, it } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { executionCostsSchema } from "trading-strategy-core/costs";
import {
  lifecycleDailyEvidence,
  lifecycleSegments,
} from "~/server/research/lifecycle-score";

const axis = ["2026-01-01", "2026-01-02", "2026-01-03"];
function request(): PortfolioRequest {
  const bars = Array.from({ length: 19 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 0, 1, i * 4)).toISOString(),
    open: 10,
    high: 10,
    low: 10,
    close: 10,
    volume: 1,
    amount: 10,
  }));
  return {
    market: "crypto",
    initial: 100000,
    start: axis[0]!,
    end: axis.at(-1)!,
    calendar: bars.map((b) => b.date),
    observationDetail: "counts",
    instruments: [
      {
        symbol: "BTCUSDT",
        market: "crypto",
        bars,
        signalBars: bars,
        execution: {
          evidence: "fixed model",
          step: 0.001,
          minimum: 0.001,
          limitUp: null,
          limitDown: null,
          tradable: true,
        },
      },
    ],
    strategies: [
      {
        id: "four-hour-count",
        version: 1,
        market: "crypto",
        period: "4h",
        sleeve: "swing",
        universe: { kind: "symbols", symbols: ["BTCUSDT"] },
        entry: { kind: "constant", value: false },
        exit: {},
        overlay: { symbolWeight: 1 },
        sizing: { kind: "weight", weight: 1 },
      },
    ],
    sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 1 }],
    costs: executionCostsSchema.parse({}),
  };
}
it("scores full UTC days with next-midnight included and preserves exact per-day signal counts in counts mode", () => {
  const q = request(),
    result = runPortfolio(q);
  expect(result.curve[0]!.date).toBe("2026-01-01T04:00:00.000Z");
  expect(result.curve.at(-1)!.date).toBe("2026-01-04T00:00:00.000Z");
  expect(result.equity.map((e) => e.date)).toEqual(axis);
  expect(result.dailyDecisionCounts).toHaveLength(18);
  expect(lifecycleDailyEvidence(result, q, axis)).toEqual(
    axis.map((date) => ({ date, return: 0, signals: 0, missing: false })),
  );
});
it("missing 4h component is insufficient, never a zero daily return or a bridge across the hole", () => {
  const q = request();
  q.calendar = q.calendar.filter((d) => d !== "2026-01-02T08:00:00.000Z");
  q.instruments = q.instruments.map((s) => ({
    ...s,
    bars: s.bars.filter((b) => q.calendar.includes(b.date)),
    signalBars: s.signalBars.filter((b) => q.calendar.includes(b.date)),
  }));
  const evidence = lifecycleDailyEvidence(runPortfolio(q), q, axis);
  expect(evidence[0]!.return).toBe(0);
  expect(evidence.slice(1).map((e) => e.return)).toEqual([null, null]);
});
it("freezes independent OOS segments before holdout and counts physical engine calls separately", () => {
  const days = Array.from({ length: 100 }, (_, i) =>
    new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10),
  );
  const segments = lifecycleSegments(days);
  expect(segments.windows).toHaveLength(4);
  expect(segments.windows.at(-1)!.end).toBe(days[79]);
  expect(segments.holdoutWindow.start).toBe(days[80]);
  expect(segments.callsPerConfiguration).toBe(20);
});
