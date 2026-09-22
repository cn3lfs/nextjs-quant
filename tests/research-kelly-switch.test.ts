import { expect, it } from "vitest";
import { researchKellySwitch } from "../src/lib/research-kelly-switch";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { researchKellySchema } from "../src/lib/research-kelly";

const evidence = JSON.stringify({
  checks: {
    trend: "是",
    level: "是",
    volume: "是",
    indicators: "是",
    candle: "否",
  },
});
const row = (i: number) => ({
  event: {
    symbol: "sh600000",
    key: String(i),
    observedDate: "2024-01-01",
    partition: "development",
  },
  entryDate: "2024-01-02",
  exitDate: "2024-01-03",
  profit: i < 15 ? 100 : -50,
  remainingQuantity: 0,
});
it("switches only at thirty prior complete outcomes and uses quarter versus half", () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(i));
  const before = researchKellySwitch(
    rows.slice(0, 29),
    "2024-01-01",
    "2024-02-01",
    "development",
    evidence,
    2,
  );
  expect(before).toMatchObject({
    source: "quality-proxy",
    sampleCount: 29,
    winRate: 0.5,
    fraction: 0.25,
    weight: 0.0625,
  });
  const after = researchKellySwitch(
    rows,
    "2024-01-01",
    "2024-02-01",
    "development",
    evidence,
    2,
  );
  expect(after).toMatchObject({
    source: "closed-trades",
    sampleCount: 30,
    winRate: 0.5,
    fraction: 0.5,
    weight: 0.125,
  });
  expect(
    researchKellySwitch(
      rows,
      "2024-01-01",
      "2024-01-03",
      "development",
      evidence,
      2,
    ).sampleCount,
  ).toBe(0);
  expect(
    researchKellySwitch(
      rows,
      "2024-01-01",
      "2024-02-01",
      "validation",
      evidence,
      2,
    ).sampleCount,
  ).toBe(0);
  expect(
    researchKellySwitch(
      [...rows, rows[0]!],
      "2024-01-01",
      "2024-02-01",
      "development",
      evidence,
      2,
    ).weight,
  ).toBeNull();
  expect(
    researchKellySwitch([], "2024-01-01", "2024-02-01", "development", "{}", 2)
      .weight,
  ).toBeNull();
  expect(
    researchKellySchema.safeParse({
      provenance: "rolling-switch30",
      payoff: 2,
      fraction: 0.25,
    }).success,
  ).toBe(false);
});
it("counts zero as non-win and excludes unfinished or future records", () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({
    ...row(i),
    profit: i < 15 ? 100 : 0,
  }));
  const extra = [
    { ...row(40), remainingQuantity: 100 },
    { ...row(41), exitDate: "2024-03-01" },
  ];
  expect(
    researchKellySwitch(
      [...rows, ...extra],
      "2024-01-01",
      "2024-02-01",
      "development",
      "{}",
      2,
    ),
  ).toMatchObject({ sampleCount: 30, winRate: 0.5, zeros: 15, weight: 0.125 });
});
it("changes actual portfolio sizing only after prior trades close, without future leakage", () => {
  const bars = Array.from({ length: 90 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 10 + i / 10,
    close: 10 + i / 10,
    high: 11 + i / 10,
    low: 9 + i / 10,
    volume: 10000,
    amount: 1000000,
  }));
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: bars[0]!.date,
    end: bars[89]!.date,
    validationStart: bars[89]!.date,
    holdingDays: 1,
    initialCapital: 1000000,
    maxPositions: 1,
    risk: { fraction: 0.1, maxWeight: 1 },
    management: {
      stop: { kind: "percent", fraction: 0.1 },
      kelly: { provenance: "rolling-switch30", payoff: 2, fraction: 0.5 },
    },
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const events: ResearchEvent[] = bars.map((bar, i) => ({
    symbol: "sh600000",
    key: String(i),
    observedDate: bar.date,
    endpointDate: bar.date,
    strategyVersion: "fixture",
    evidence,
    partition: "development",
  }));
  const rules = {
    evidence: "fixture",
    minimumBuy: 100,
    buyStep: 100,
    maximumOrder: 100000,
    minimumSell: 100,
    sellStep: 100,
    maximumSell: 100000,
    sellOddLotAll: true,
    tradable: true,
    limitUp: null,
    limitDown: null,
  };
  const run = (input = bars) =>
    researchPortfolio(
      spec,
      events,
      bars.map((b) => b.date),
      new Map([["sh600000", input]]),
      () => rules,
    );
  const result = run();
  expect(result.kellyChecks![0]!.parameterSwitch).toMatchObject({
    sampleCount: 0,
    source: "quality-proxy",
    fraction: 0.25,
  });
  const switched = result.kellyChecks!.find(
    (check) => check.parameterSwitch?.source === "closed-trades",
  );
  expect(switched).toBeDefined();
  expect(switched!.parameterSwitch).toMatchObject({
    sampleCount: 30,
    winRate: 1,
    fraction: 0.5,
    weight: 0.5,
  });
  expect(switched!.filledQuantity).toBeGreaterThan(0);
  for (const check of result.kellyChecks!) {
    const closed = result.trades.filter(
      (trade) =>
        trade.exitDate &&
        trade.exitDate < check.date &&
        (trade.remainingQuantity == null || trade.remainingQuantity === 0),
    );
    expect(check.parameterSwitch!.sampleCount).toBe(closed.length);
  }
  const future = bars[75]!.date;
  const rerun = run(
    bars.map((bar) =>
      bar.date >= future
        ? {
            ...bar,
            open: bar.open / 2,
            close: bar.close / 2,
            high: bar.high / 2,
            low: bar.low / 2,
          }
        : bar,
    ),
  );
  expect(rerun.kellyChecks!.filter((check) => check.date < future)).toEqual(
    result.kellyChecks!.filter((check) => check.date < future),
  );
});
