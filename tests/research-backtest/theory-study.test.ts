import { describe, expect, it } from "vitest";
import { runPortfolio, createPortfolioPreparation } from "quant-backtest";
import type { Bar } from "trading-strategy-core/bars";
import {
  theoryStudyCandidates,
  theoryStudyStrategy,
  summarizeTheoryResult,
  theoryStudyWindows,
} from "../../scripts/theory-study";

describe("theory historical screen", () => {
  it("excludes account allocation policies and labels reused historical windows", () => {
    const ids = theoryStudyCandidates();
    expect(ids).toContain("rsi2");
    expect(ids).toContain("theory-squeeze");
    expect(ids).not.toContain("grid");
    expect(ids).not.toContain("hold");
    expect(new Set(ids).size).toBe(ids.length);
    expect(theoryStudyWindows.map((w) => w.label)).not.toContain("holdout");
  });

  it("routes both markets through actual study-rule objects without external signal simulation", () => {
    for (const market of ["cn-equity", "crypto"] as const) {
      const object = theoryStudyStrategy("rsi2", market, ["A", "B"]);
      expect(object.entry).toEqual({
        kind: "study-rule",
        strategy: "rsi2",
        side: "entry",
      });
      expect(object.exit.rule).toEqual({
        kind: "study-rule",
        strategy: "rsi2",
        side: "exit",
      });
      expect(object.sizing).toEqual({ kind: "weight", weight: 0.5 });
    }
  });

  it("baseline fills next opportunity and keeps marked inventory", () => {
    const bars: Bar[] = [
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ].map((date, i) => ({
      date,
      open: 10 + i,
      high: 11 + i,
      low: 9 + i,
      close: 10 + i,
      volume: 100000,
      amount: 1000000,
    }));
    const request = {
      market: "crypto" as const,
      initial: 1000000,
      start: bars[0]!.date,
      end: bars.at(-1)!.date,
      calendar: bars.map((b) => b.date),
      instruments: [
        {
          market: "crypto" as const,
          symbol: "A",
          bars,
          signalBars: bars,
          execution: {
            evidence: "fixture",
            minimum: 0.01,
            step: 0.01,
            limitUp: null,
            limitDown: null,
            tradable: true,
          },
        },
      ],
      strategies: [theoryStudyStrategy("baseline-hold", "crypto", ["A"])],
      sleeves: [{ id: "swing", share: 1, riskPerTrade: 0.01, maxPositions: 1 }],
    };
    const base = runPortfolio(request);
    const preparation = createPortfolioPreparation();
    expect(runPortfolio(request, undefined, preparation)).toEqual(base);
    expect(runPortfolio(request, undefined, preparation)).toEqual(base);
    expect(base.fills[0]).toMatchObject({
      signalAt: "2026-01-01",
      date: "2026-01-02",
      side: "buy",
    });
    const summary = summarizeTheoryResult(base, request.initial);
    expect(summary.openPositions).toBe(1);
    expect(summary.netReturn).toBeGreaterThan(0);
    expect(summary.sells).toBe(0);
    expect(summary.quality).toBe("rule-check-only");
  });
});
