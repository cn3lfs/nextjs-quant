import { researchCanslimWeekly } from "../src/server/strategies/canslim/research-canslim-weekly";
import { researchCanslimPriorityPoint } from "../src/server/strategies/canslim/research-canslim-priority";
import { selectResearchStrategy } from "../src/components/research/research-strategy-fields";
import { researchManagementSchema } from "../src/lib/research-management";
import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { runStrategyResearch } from "../src/server/backtest/research-run";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import type { ResearchDataset } from "../src/server/backtest/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";

function weekdays(count: number) {
  return Array.from(
    { length: count * 2 },
    (_, i) => new Date(Date.UTC(2024, 0, i + 1)),
  )
    .filter((d) => d.getUTCDay() > 0 && d.getUTCDay() < 6)
    .slice(0, count)
    .map((d) => d.toISOString().slice(0, 10));
}

const rules = {
  evidence: "fixture",
  tradable: true,
  limitUp: null,
  limitDown: null,
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
};
const native = async (): Promise<never> => {
  throw Error("unexpected native");
};
const strategy = "canslim-priority-weekly10-half" as const;
function setup() {
  const dates = weekdays(120);
  const bars: Bar[] = Array.from({ length: 120 }, (_, i) => ({
    date: dates[i]!,
    open: i >= 70 ? 102 : 97,
    high: i >= 69 ? 103 : 100,
    low: i >= 70 ? 101 : 95,
    close: i >= 69 ? 102 : 97,
    volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : 70,
    amount: 1000000,
  }));
  const spec = researchSpecSchema.parse({
    strategy,
    symbols: ["sh600000"],
    start: bars[61]!.date,
    end: bars[119]!.date,
    validationStart: bars[118]!.date,
    holdingDays: 60,
    initialCapital: 1000000,
    maxPositions: 1,
    entryMaxWait: 5,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const calendar = bars.map((b) => b.date);
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "fixture",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: spec.symbols!,
      source: null,
      warning: "fixture",
    },
    benchmark: { symbol: "sh000001", bars },
    calendar,
    stocks: [
      {
        symbol: "sh600000",
        name: "fixture",
        bars,
        hash: "fixture",
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "fixture",
    method: researchMethodSnapshot(spec),
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: bars[0]!.date,
        end: spec.end,
        evidenceId: "fixture",
      },
    ],
    rows: bars.map((b) => ({
      symbol: "sh600000",
      date: b.date,
      ...rules,
      evidenceId: "fixture",
    })),
  });
  return { bars, spec, calendar, dataset, evidence };
}

function price(bars: Bar[], index: number, close: number) {
  Object.assign(bars[index]!, {
    open: close,
    close,
    high: close + 1,
    low: close - 1,
  });
}
function simple() {
  return weekdays(75).map((date) => ({
    date,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 100,
    amount: 10000,
  }));
}
const empty = researchCanslimPriorityPoint([]);
function weekly(bars: Bar[], calendar = bars.map((b) => b.date)) {
  return researchCanslimWeekly(
    bars.map((b) => ({ ...empty, date: b.date })),
    bars,
    calendar,
  );
}

it("requires completed 10-week and previous averages, crossing rather than continued weakness", () => {
  const bars = simple();
  price(bars, 54, 90);
  price(bars, 59, 89);
  price(bars, 64, 110);
  price(bars, 69, 90);
  const points = weekly(bars);
  const signals = points.filter((p) => p.weeklyReduction?.triggered);
  expect(signals.map((p) => p.date)).toEqual([bars[54]!.date, bars[69]!.date]);
  expect(signals[0]!.weeklyReduction).toMatchObject({
    average: 99,
    previousAverage: 100,
    previousClose: 100,
    close: 90,
    fraction: 0.5,
  });
  expect(weekly(bars.slice(0, 54))).toEqual(points.slice(0, 54));
  expect(weekly(bars.slice(0, 55))).toEqual(points.slice(0, 55));
  expect(points[49]!.weeklyReduction!.triggered).toBe(false);
});

it("does not use a still-forming week or treat equality as a downcross", () => {
  const bars = simple();
  price(bars, 50, 80);
  expect(weekly(bars).some((p) => p.weeklyReduction?.triggered)).toBe(false);
  price(bars, 54, 100);
  expect(weekly(bars)[54]!.weeklyReduction).toMatchObject({
    average: 100,
    close: 100,
    triggered: false,
  });
  price(bars, 54, 99.999);
  expect(weekly(bars)[54]!.weeklyReduction!.triggered).toBe(true);
});

it("confirms a holiday short week only after its natural end and refuses stock-specific missing days", () => {
  const bars = simple();
  price(bars, 53, 90);
  const originalCalendar = bars.map((b) => b.date);
  const holiday = bars.filter((_, i) => i !== 54);
  const signals = weekly(holiday).filter((p) => p.weeklyReduction?.triggered);
  expect(signals[0]!.date).toBe(bars[55]!.date);
  expect(signals[0]!.weeklyReduction).toMatchObject({
    closeDate: bars[53]!.date,
    completedAt: bars[54]!.date,
    confirmedDate: bars[55]!.date,
  });
  expect(
    weekly(holiday.slice(0, 54)).some((p) => p.weeklyReduction?.triggered),
  ).toBe(false);
  expect(
    weekly(holiday, originalCalendar).some((p) => p.weeklyReduction?.triggered),
  ).toBe(false);
  const invalid = structuredClone(bars);
  invalid[52]!.volume = 0;
  price(invalid, 54, 90);
  expect(weekly(invalid)[54]!.weeklyReduction!.close).toBeNull();
  const clipped = bars.slice(1);
  price(clipped, 53, 90);
  expect(
    weekly(clipped).find((p) => p.date === bars[54]!.date)!.weeklyReduction!
      .triggered,
  ).toBe(false);
});

it("sells half the remaining position for each fresh downcross using the real signal path", async () => {
  const { bars, spec, dataset, evidence } = setup();
  price(bars, 74, 96);
  price(bars, 79, 96);
  price(bars, 84, 104);
  price(bars, 89, 96);
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.events).toHaveLength(1);
  const trade = result.partitions[0]!.simulation!.trades[0]!;
  expect(trade.quantity).toBe(9800);
  expect(trade.sales!.slice(0, 2).map((s) => [s.date, s.quantity])).toEqual([
    [bars[75]!.date, 4900],
    [bars[90]!.date, 2400],
  ]);
  expect(
    trade.weeklyReductionEvidence!.slice(0, 2).map((e) => e.remainingQuantity),
  ).toEqual([9800, 4900]);
  expect(trade.sales!.every((s) => s.date > s.triggerDate!)).toBe(true);
  expect(
    trade.sales!.reduce((sum, s) => sum + s.quantity, 0) +
      trade.remainingQuantity!,
  ).toBe(trade.quantity);
});

it("keeps the frozen target through blocked and partial fills without raising an R stop", async () => {
  const { bars, spec, dataset, evidence } = setup();
  price(bars, 74, 96);
  price(bars, 79, 96);
  evidence.rows.forEach((r) => {
    r.maximumSell = 1000;
    if ([bars[75]!.date, bars[76]!.date].includes(r.date)) r.tradable = false;
  });
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  const trade = result.partitions[0]!.simulation!.trades[0]!;
  expect(trade.sales!.slice(0, 5).map((s) => [s.date, s.quantity])).toEqual(
    [77, 78, 79, 80, 81].map((i, j) => [bars[i]!.date, j === 4 ? 900 : 1000]),
  );
  expect(
    trade.sales!.slice(0, 5).every((s) => s.triggerDate === bars[74]!.date),
  ).toBe(true);
  expect(trade.stopHistory).toBeUndefined();
});

it("does not stack a new half target while an earlier reduction is blocked", async () => {
  const { bars, spec, dataset, evidence } = setup();
  price(bars, 74, 96);
  price(bars, 84, 104);
  price(bars, 89, 96);
  evidence.rows.forEach((r) => {
    if (r.date >= bars[75]!.date && r.date <= bars[89]!.date)
      r.tradable = false;
  });
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  const trade = result.partitions[0]!.simulation!.trades[0]!;
  expect(
    trade.weeklyReductionEvidence!.slice(0, 2).map((e) => e.disposition),
  ).toEqual(["queued", "existing-partial"]);
  expect(trade.sales![0]).toMatchObject({
    date: bars[90]!.date,
    quantity: 4900,
    triggerDate: bars[74]!.date,
  });
});

it("leaves an unsellable half-lot remainder instead of converting a reduction into a full exit", async () => {
  const { bars, spec, dataset, evidence } = setup();
  price(bars, 74, 96);
  spec.initialCapital = 100000;
  spec.maxPositions = 5;
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  const trade = result.partitions[0]!.simulation!.trades[0]!;
  expect(trade.quantity).toBe(100);
  expect(trade.sales).toEqual([]);
  expect(trade.remainingQuantity).toBe(100);
  expect(
    trade.managementWarnings!.some((w) => w.reason.includes("不足最小卖出量")),
  ).toBe(true);
});

it("preserves full-exit priority and the original company-action proof requirement", async () => {
  const { bars, spec, dataset, evidence } = setup();
  price(bars, 74, 93);
  spec.management = researchManagementSchema.parse({
    stop: { kind: "percent", fraction: 0.08 },
  });
  spec.risk = { fraction: 0.015, maxWeight: 0.25 };
  dataset.method = researchMethodSnapshot(spec);
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  const trade = result.partitions[0]!.simulation!.trades[0]!;
  expect(trade.sales![0]).toMatchObject({
    date: bars[75]!.date,
    quantity: trade.quantity,
  });
  expect(trade.exitReason).toContain("止损");
  evidence.corporateActionFree[0]!.start = bars[1]!.date;
  expect(
    (await runStrategyResearch(spec, dataset, evidence, native)).partitions[0]!
      .simulation!.trades,
  ).toEqual([]);
});

it("does not sell on a Friday purchase even when that close confirms the weekly reduction", async () => {
  const { bars, spec, dataset, evidence } = setup();
  Object.assign(bars[74]!, { open: 102, close: 96, high: 103, low: 95 });
  evidence.rows.forEach((row) => {
    if (row.date >= bars[70]!.date && row.date < bars[74]!.date)
      row.tradable = false;
  });
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  const trade = result.partitions[0]!.simulation!.trades[0]!;
  expect(trade.entryDate).toBe(bars[74]!.date);
  expect(trade.sales![0]).toMatchObject({
    date: bars[75]!.date,
    triggerDate: bars[74]!.date,
    quantity: 4900,
  });
});

it("retains an unavailable weekly check on the held trade without inventing a reduction", async () => {
  const { bars, spec, dataset, evidence } = setup();
  price(bars, 74, 96);
  bars[74]!.volume = 0;
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  const trade = result.partitions[0]!.simulation!.trades[0]!;
  const check = trade.weeklyReductionChecks!.find(
    (row) => row.confirmedDate === bars[74]!.date,
  )!;
  expect(check).toMatchObject({ close: null, average: null, triggered: false });
  expect(check.reason).toContain("缺少");
  expect(trade.sales).toEqual([]);
});

it("registers a separate source/version and a usable weekly holding horizon", () => {
  const { spec } = setup();
  const selected = selectResearchStrategy(
    { ...spec, strategy: "canslim-priority", holdingDays: 5 },
    strategy,
  );
  expect(selected.holdingDays).toBe(60);
  expect(researchSpecSchema.safeParse(selected).success).toBe(true);
  expect(
    researchMethodSnapshot(selected).sources.some(
      (s) => s.path === "canslim-analyst/references/entry-exit-rules.md",
    ),
  ).toBe(true);
  expect(
    selectResearchStrategy({ ...selected, holdingDays: 5 }, strategy)
      .holdingDays,
  ).toBe(5);
});
