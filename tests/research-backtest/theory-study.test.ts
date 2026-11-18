import {
  relativeStrengthInputs,
  relativeStrengthStrategy,
} from "../../scripts/lib/research/method-pool-relative-strength";
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
      expect(object.sizing).toEqual({ kind: "weight", weight: 0.1 });
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
    const symbols = Array.from({ length: 12 }, (_, i) =>
      String(i).padStart(2, "0"),
    );
    const crowdedRequest = {
      ...request,
      instruments: symbols.map((symbol) => ({
        ...request.instruments[0]!,
        symbol,
      })),
      strategies: [theoryStudyStrategy("baseline-hold", "crypto", symbols)],
      sleeves: [{ ...request.sleeves[0]!, maxPositions: 10 }],
    };
    const crowded = runPortfolio(crowdedRequest);
    const permuted = runPortfolio({
      ...crowdedRequest,
      instruments: [...crowdedRequest.instruments].reverse(),
      strategies: [
        theoryStudyStrategy("baseline-hold", "crypto", [...symbols].reverse()),
      ],
    });
    expect(
      permuted.fills.map(({ symbol, date, quantity, side }) => ({
        symbol,
        date,
        quantity,
        side,
      })),
    ).toEqual(
      crowded.fills.map(({ symbol, date, quantity, side }) => ({
        symbol,
        date,
        quantity,
        side,
      })),
    );
    expect(crowded.fills.map((fill) => fill.symbol)).toEqual(
      symbols.slice(0, 10),
    );
    expect(summarizeTheoryResult(crowded, request.initial).peakPositions).toBe(
      10,
    );
    expect(
      crowded.rejections.some((row) => row.reason.includes("持仓上限")),
    ).toBe(true);
    expect(summary.quality).toBe("rule-check-only");
  });
});

it("allocates completed weekly RPS ranks at 10% each and preserves cash with fewer than ten", () => {
  const calendar = Array.from({ length: 185 }, (_, index) =>
    new Date(Date.UTC(2023, 0, 2 + index)).toISOString().slice(0, 10),
  ).filter((date) => ![0, 6].includes(new Date(date).getUTCDay()));
  const instruments = ["sz000001", "sz000002"].map((symbol, index) => {
    const bars = calendar.map((date, day) => {
      const close = 20 + day * (index + 1) * 0.01;
      return {
        date,
        open: close,
        close,
        high: close + 1,
        low: close - 1,
        volume: 1000000,
        amount: close * 1000000,
      };
    });
    return {
      symbol,
      market: "cn-equity" as const,
      bars,
      signalBars: bars,
      execution: {
        minimum: 100,
        step: 100,
        tradable: true,
        evidence: "fixture",
        limitUp: null,
        limitDown: null,
      },
    };
  });
  const start = calendar[120]!,
    end = calendar.at(-1)!;
  const ranked = relativeStrengthInputs(instruments, calendar, start, end);
  expect(ranked.signalWeeks).toBeGreaterThan(0);
  const result = runPortfolio({
    market: "cn-equity",
    initial: 1000000,
    start,
    end,
    calendar,
    instruments: ranked.instruments,
    strategies: [relativeStrengthStrategy()],
    sleeves: [{ id: "swing", share: 1, maxPositions: 10, riskPerTrade: 0.01 }],
  });
  const buys = result.fills.filter((fill) => fill.side === "buy");
  expect(buys.slice(0, 2).map((fill) => fill.symbol)).toEqual([
    "sz000002",
    "sz000001",
  ]);
  expect(buys.every((fill) => fill.date > fill.signalAt)).toBe(true);
  expect(
    result.orders.filter((order) => order.targetWeight === 0.1).length,
  ).toBeGreaterThan(0);
  expect(result.curve.at(-1)!.cash).toBeGreaterThan(790000);
});
