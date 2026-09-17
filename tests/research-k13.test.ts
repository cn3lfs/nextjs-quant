import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import type { ResearchTrade } from "../src/server/research-portfolio";
import {
  compareK13Contracts,
  researchK13Cycle100,
  researchK13Emotion20,
  researchK13MaeQuantile,
  researchK13MfeTail,
  researchK13Overlap,
  researchK13Records,
  researchK13Regime,
  researchK13Report,
  researchK13Review,
  researchK13TightenResize,
  researchK13WidenResize,
  type K13Contract,
  type K13TradeRecord,
} from "../src/lib/research-k13";

const date = (index: number) =>
  new Date(Date.UTC(2020, 0, 1 + index)).toISOString().slice(0, 10);

const record = (
  index: number,
  overrides: Partial<K13TradeRecord> = {},
): K13TradeRecord => ({
  id: `trade-${index}`,
  symbol: "sh600000",
  eventKey: `event-${index}`,
  strategyVersion: "dual-breakout-v1",
  observedDate: date(index),
  entryDate: date(index + 1),
  exitDate: date(index + 3),
  entryPrice: 100,
  exitPrice: 102,
  quantity: 100,
  initialStop: 98,
  initialR: 200,
  entryAtr: 2,
  finalR: 1,
  profit: 200,
  netReturn: 0.02,
  mae: 0.01,
  mfe: 0.05,
  exitReason: "止盈",
  exitCategory: "profit",
  complete: true,
  reason: null,
  ...overrides,
});

const contract = (candidateId = "baseline"): K13Contract => ({
  version: "k13-contract-1",
  candidateId,
  strategy: "dual-breakout",
  strategyVersion: "dual-breakout-v1",
  timeframe: "daily",
  universeHash: "universe-fixture",
  knownOn: "2020-01-01",
  start: "2020-01-01",
  end: "2021-12-31",
  adjustment: "none",
  costs: {
    commissionBps: 1,
    minimumCommission: 5,
    sellTaxBps: 5,
    slippageBps: 2,
  },
  initialCapital: 100000,
  execution: {
    signal: "close",
    fill: "next-tradable-open",
    t1: true,
    cashRule: "cash-and-known-holdings",
    companyActions: "evidence-required",
  },
  baselines: [
    { id: "cash", status: "available" },
    { id: "buy-and-hold", status: "not-run", reason: "fixture" },
    { id: "dual-breakout", status: "available" },
    { id: "ma-cross", status: "data-insufficient", reason: "fixture" },
  ],
});

it("compares only candidates sharing the complete frozen contract", () => {
  expect(compareK13Contracts([contract("q80"), contract("q90")])).toMatchObject(
    {
      comparable: true,
      candidateCount: 2,
    },
  );
  expect(
    compareK13Contracts([
      contract("q80"),
      { ...contract("q90"), costs: { ...contract().costs, slippageBps: 3 } },
    ]).comparable,
  ).toBe(false);
});

it("derives MAE/MFE only through the actual exit date", () => {
  const calendar = Array.from({ length: 6 }, (_, index) => date(index));
  const bars: Bar[] = calendar.map((day, index) => ({
    date: day,
    open: 100,
    high: index === 3 ? 1000 : 103,
    low: index === 3 ? 1 : index === 1 ? 99 : 98,
    close: 101,
    volume: 1000,
    amount: 100000,
  }));
  const trade: ResearchTrade = {
    event: {
      symbol: "sh600000",
      key: "one",
      observedDate: calendar[0]!,
      endpointDate: calendar[0]!,
      strategyVersion: "v1",
      partition: "development",
      evidence: "fixture",
      stopAtr: 2,
    },
    entryDate: calendar[1]!,
    entryIndex: 1,
    entryPrice: 100,
    quantity: 100,
    entryCost: 10000,
    exitDate: calendar[3]!,
    exitPrice: 102,
    profit: 200,
    netReturn: 0.02,
    lastPrice: 102,
    initialStop: 98,
    exitReason: "止盈",
  };
  const derived = researchK13Records(
    [trade],
    new Map([[trade.event.symbol, bars]]),
    calendar,
  )[0]!;
  expect(derived).toMatchObject({
    complete: true,
    mae: 0.02,
    mfe: 0.03,
    entryAtr: 2,
  });
});

it.each([
  ["RK-MAE-q80", 0.02],
  ["RK-MAE-q90", 0.02],
  ["RK-MAE-q50", 0.015],
  ["RK-MAE-q100", 0.02],
] as const)(
  "freezes %s as a next-batch-only MAE candidate",
  (methodId, width) => {
    const rows = Array.from({ length: 100 }, (_, index) =>
      record(index, {
        profit: index < 60 ? 200 : -100,
        netReturn: index < 60 ? 0.02 : -0.01,
        finalR: index < 60 ? 1 : -0.5,
        mae: index < 30 ? 0.01 : 0.02,
      }),
    );
    const result = researchK13MaeQuantile(methodId, rows);
    expect(result).toMatchObject({
      width,
      minimumTrades: 100,
      nextBatchOnly: true,
      riskBudgetPreserved: true,
      reason: null,
    });
  },
);

it("keeps stop widening as an exit-window diagnostic and exposes risk resizing", () => {
  const result = researchK13WidenResize([
    record(0, { exitCategory: "stop", finalR: -1 }),
    record(1, { exitCategory: "profit", finalR: 1 }),
  ]);
  expect(result).toMatchObject({
    candidates: 1,
    returnedToTwoR: null,
    nextBatchOnly: true,
    riskBudgetPreserved: true,
  });
});

it("uses a frozen near-zero ATR threshold without increasing the current batch", () => {
  const rows = Array.from({ length: 100 }, (_, index) =>
    record(index, {
      finalR: 1,
      profit: 100,
      mae: index < 80 ? 0.2 : 0.8,
      entryAtr: 1,
    }),
  );
  expect(researchK13TightenResize(rows)).toMatchObject({
    nearZeroAtr: 0.25,
    profitableRecords: 100,
    nearZeroRecords: 80,
    nextBatchOnly: true,
    capacityLimitsRemain: true,
  });
});

it("reports overlap as local evidence rather than a universal invalidity claim", () => {
  const rows = Array.from({ length: 100 }, (_, index) =>
    record(index, {
      finalR: index < 50 ? 1 : -1,
      profit: index < 50 ? 100 : -100,
      mae: index < 25 ? 0.1 : 0.2,
      entryAtr: 1,
    }),
  );
  const result = researchK13Overlap(rows);
  expect(result).toMatchObject({
    statistic: "empirical-cdf-min-area-v1",
    validRecords: 100,
    conclusion: "样本证据不足以区分",
    reason: null,
  });
});

it("requires both independent MFE-tail exit alternatives", () => {
  const rows = Array.from({ length: 50 }, (_, index) =>
    record(index, { mfe: 0.2, finalR: 0.05 }),
  );
  expect(researchK13MfeTail(rows).reason).toContain("吊灯与回撤止损");
  const result = researchK13MfeTail(rows, [
    { id: "chandelier-22-3", records: rows },
    { id: "retracement-2-7r", records: rows },
  ]);
  expect(result.alternatives.map((item) => item.id)).toEqual([
    "chandelier-22-3",
    "retracement-2-7r",
  ]);
});

it("does not fill missing regime observations from another market state", () => {
  const rows = Array.from({ length: 51 }, (_, index) =>
    record(index, {
      regime:
        index === 0
          ? undefined
          : {
              atrBucket: index % 2 ? "low" : "high",
              indexTrend: index % 2 ? "up" : "down",
              knownOn: date(index),
            },
    }),
  );
  expect(researchK13Regime(rows)).toMatchObject({
    validRecords: 50,
    missingRegimeRecords: 1,
    reason: "部分记录缺状态，未跨状态补样本",
  });
});

it("resets the 100-trade cycle when strategy version changes", () => {
  const sameVersion = Array.from({ length: 200 }, (_, index) => record(index));
  expect(researchK13Cycle100(sameVersion).blocks[0]).toMatchObject({
    trainingCount: 100,
    validationCount: 100,
    status: "available",
  });
  const changed = sameVersion.map((row, index) =>
    index === 120 ? { ...row, strategyVersion: "v2" } : row,
  );
  expect(
    researchK13Cycle100(changed).blocks.some(
      (block) => block.status === "available",
    ),
  ).toBe(false);
  expect(researchK13Cycle100(sameVersion.slice(0, 80)).blocks[0]).toMatchObject(
    {
      status: "insufficient",
      reason: "50至99笔，未满足100笔校准门槛",
    },
  );
});

it("does not infer discipline from an automatic strategy without real exit categories", () => {
  const missing = researchK13Emotion20([
    record(0, { exitCategory: null }),
    record(1, { exitCategory: "profit" }),
  ]);
  expect(missing).toMatchObject({
    automaticStrategyPass: false,
    resultLabel: "数据不足",
    reason: "真实退出原因分类缺失，不能填为非情绪",
  });
  const labelled = researchK13Emotion20(
    Array.from({ length: 5 }, (_, index) =>
      record(index, { exitCategory: index === 0 ? "emotion" : "profit" }),
    ),
  );
  expect(labelled).toMatchObject({
    emotionFraction: 0.2,
    resultLabel: "当前样本表现较好",
    reason: null,
  });
});

it("keeps complete trade review and monthly realized-profit evidence together", () => {
  const rows = [
    record(0, { exitDate: "2020-01-05", profit: 200 }),
    record(1, { exitDate: "2020-01-06", profit: -100, finalR: -0.5 }),
    record(2, { exitDate: "2020-02-05", profit: 0, finalR: 0 }),
  ];
  const result = researchK13Review(rows, 100000);
  expect(result).toMatchObject({
    statistics: {
      count: 3,
      winRate: 1 / 3,
      payoffRatio: 2,
      realizedProfit: 100,
      maxLossStreak: 1,
    },
    resultLabel: "当前样本表现较好",
  });
  expect(result.monthly).toHaveLength(2);
});

it("downgrades every report method when historical data is unavailable", () => {
  const report = researchK13Report({
    contract: contract(),
    dataStatus: "data-insufficient",
    dataReason: "缺少历史可知证券池与完整公司行动证据",
  });
  expect(report.dataReason).toContain("证券池");
  expect(
    Object.values(report.methods).every(
      (method) => method.resultLabel === "数据不足",
    ),
  ).toBe(true);
});
