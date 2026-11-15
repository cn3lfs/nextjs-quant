import { expect, it } from "vitest";
import type { runPortfolio, PortfolioRequest } from "quant-backtest";
import type { ValidationDataset } from "../../src/server/research/validation-capture";
import { scoreBookSleeves } from "../../scripts/lib/research-book-sleeves";
const dates = [
  "2025-01-01",
  "2025-01-02",
  "2025-01-03",
  "2025-01-04",
  "2025-01-05",
];
it("removes transfers and leaves fully unfunded days null, including after the first funding; benchmark has identical active dates", () => {
  const curve = dates.map((date, i) => {
    const swing = [900, 1010, 1010, 910, 910][i]!,
      low = [100, 0, 0, 100, 110][i]!;
    return {
      date,
      cash: swing,
      equity: swing + low,
      sleeves: [
        { id: "swing", cash: swing, equity: swing },
        { id: "low-zone", cash: low, equity: low },
      ],
    };
  });
  const transfers = [
    { date: dates[0]!, sleeve: "low-zone", amount: 100 },
    { date: dates[0]!, sleeve: "swing", amount: -100 },
    { date: dates[1]!, sleeve: "low-zone", amount: -110 },
    { date: dates[1]!, sleeve: "swing", amount: 110 },
    { date: dates[3]!, sleeve: "low-zone", amount: 100 },
    { date: dates[3]!, sleeve: "swing", amount: -100 },
  ];
  const result: ReturnType<typeof runPortfolio> = {
    version: "portfolio-event-1",
    quality: "rule-check-only",
    orders: [],
    fills: [],
    rejections: [],
    positions: [],
    equity: curve,
    curve,
    positionSnapshots: [],
    observations: [],
    transfers,
    terminalValuations: [],
    corporateActions: [],
  };
  const request: PortfolioRequest = {
    market: "cn-equity",
    initial: 1000,
    start: dates[0]!,
    end: dates.at(-1)!,
    calendar: dates,
    instruments: [],
    strategies: [],
    sleeves: [
      { id: "swing", share: 1, riskPerTrade: 0.02, maxPositions: 1 },
      { id: "low-zone", share: 0, riskPerTrade: 0.02, maxPositions: 1 },
    ],
  };
  const benchmark = [10, 11, 22, 22, 24.2].map((close, i) => ({
    date: dates[i]!,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    amount: 1,
  }));
  const dataset: ValidationDataset = {
    period: "day",
    instruments: [],
    sources: [],
    benchmark,
    dates,
    benchmarkName:
      "Synthetic benchmark doubles on unfunded day;not strategy evidence",
  };
  const scores = scoreBookSleeves(result, request, dataset),
    low = scores.get("low-zone")!;
  expect(low.daily[0]).toBeNull();
  expect(low.daily[2]).toBeNull();
  expect(low.daily[3]).toBeNull();
  expect(low.daily[1]).toBeCloseTo(0.1, 12);
  expect(low.daily[4]).toBeCloseTo(0.1, 12);
  expect(low.return).toBeCloseTo(0.21, 12);
  expect(low.excess).toBeCloseTo(0, 12);
  expect(scores.get("swing")!.return).toBeCloseTo(0, 12);
  expect(result.equity.at(-1)!.equity / 1000 - 1).toBeCloseTo(0.02, 12);
});
