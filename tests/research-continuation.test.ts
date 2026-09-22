import { expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";
import { threeMethods } from "../src/lib/indicators";
import {
  continuationIds,
  researchContinuationSeries,
  type ContinuationId,
} from "../src/lib/research-continuation";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchSignals } from "../src/server/strategies/shared/research-signals";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import { runStrategyResearch } from "../src/server/backtest/research-run";
import {
  researchHash,
  type ResearchDataset,
} from "../src/server/backtest/research-dataset";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";

const native = vi.fn(async (): Promise<never> => {
  throw new Error("native must not run");
});
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
function put(
  bars: Bar[],
  i: number,
  open: number,
  close: number,
  high = Math.max(open, close) + 1,
  low = Math.min(open, close) - 1,
) {
  Object.assign(bars[i]!, { open, close, high, low });
}
function pattern(
  bars: Bar[],
  end: number,
  length: 5 | 6 | 7,
  falling: boolean,
) {
  const start = end - length + 1;
  for (let j = 0; j < 3; j++) put(bars, start - 3 + j, 99.8 + j, 100 + j);
  put(bars, start, 100, 108, 109, 99);
  for (let j = 1; j < length - 1; j++)
    put(
      bars,
      start + j,
      107 - j * 0.6,
      106.5 - j * 0.6,
      107.4 - j * 0.6,
      106.1 - j * 0.6,
    );
  put(bars, end, 106, 112, 113, 105);
  if (falling)
    for (let i = start - 3; i <= end; i++) {
      const b = bars[i]!;
      Object.assign(b, {
        open: 200 - b.open,
        close: 200 - b.close,
        high: 200 - b.low,
        low: 200 - b.high,
      });
    }
}
function fixture(length: 5 | 6 | 7, falling = false) {
  const bars = Array.from({ length: 116 }, (_, i) => {
    const close = i >= 61 && i <= 81 ? 80 + i - 61 : 100;
    return {
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      open: close - 0.2,
      close,
      high: close + 1,
      low: close - 1,
      volume: 10000,
      amount: close * 10000,
    };
  });
  pattern(bars, 90, length, falling);
  if (!falling) pattern(bars, 107, length, true);
  return bars;
}
function settings(id: ContinuationId, bars: Bar[]) {
  return researchSpecSchema.parse({
    strategy: id,
    start: bars[61]!.date,
    end: bars[115]!.date,
    validationStart: bars[114]!.date,
    symbols: ["sh600000"],
    initialCapital: 200000,
    holdingDays: 60,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
}
it.each(continuationIds)(
  "%s runs exact-length confirmation and next-open entry/exit without native calls",
  async (id) => {
    const length = Number(id.match(/[567]/)![0]) as 5 | 6 | 7,
      falling = id.includes("falling"),
      bars = fixture(length, falling),
      spec = settings(id, bars),
      series = researchContinuationSeries(id, bars);
    expect(falling ? series[90]!.exit : series[90]!.entry).toBe(true);
    expect(series[89]!.entry).toBe(false);
    expect(researchContinuationSeries(id, bars.slice(0, 91))).toEqual(
      series.slice(0, 91),
    );
    const events = await researchSignals("sh600000", bars, spec, native);
    const run = researchPortfolio(
      spec,
      events,
      bars.map((b) => b.date),
      new Map([["sh600000", bars]]),
      () => rules,
    );
    const trade = falling
      ? run.trades.find((t) => t.exitDate === bars[91]!.date)
      : run.trades.find((t) => t.entryDate === bars[91]!.date);
    expect(trade).toBeDefined();
    expect(trade!.exitDate).toBe(bars[falling ? 91 : 108]!.date);
    expect(trade!.signalExit).toEqual(series[falling ? 90 : 107]);
    expect(researchMethodSnapshot(spec).ruleVersion).toBe(`${id}-1`);
    expect(native).not.toHaveBeenCalled();
  },
);
it("separates all three lengths and preserves immutable geometric evidence", () => {
  for (const length of [5, 6, 7] as const) {
    const bars = fixture(length),
      copy = structuredClone(bars);
    const point = threeMethods(bars, 90, length, "long");
    expect(point).toMatchObject({
      matched: true,
      high: 109,
      low: 99,
      start: bars[91 - length]!.date,
      checks: {
        context: true,
        firstLarge: true,
        lastLarge: true,
        oppositeSmall: true,
        contained: true,
        break: true,
      },
    });
    for (const other of [5, 6, 7] as const)
      if (other !== length)
        expect(threeMethods(bars, 90, other, "long").matched).toBe(false);
    expect(bars).toEqual(copy);
  }
});
it("rejects wrong direction, oversize middles, escaped ranges and incomplete final breaks", () => {
  for (const [index, change, failed] of [
    [87, { open: 105, close: 106, high: 107, low: 104 }, "oppositeSmall"],
    [87, { open: 107, close: 102, high: 108, low: 101 }, "oppositeSmall"],
    [87, { high: 109.01 }, "contained"],
    [90, { close: 109 }, "break"],
    [90, { open: 110, close: 112, low: 109 }, "lastLarge"],
    [85, { close: 99, low: 98 }, "context"],
  ] as const) {
    const bars = fixture(5);
    Object.assign(bars[index]!, change);
    const point = threeMethods(bars, 90, 5, "long");
    expect(point.matched).toBe(false);
    expect(point.checks![failed]).toBe(false);
  }
});
it("requires all context bars and does not fill missing or suspended middle candles", () => {
  for (const change of [
    { volume: 0 },
    { high: NaN },
    { open: 105, close: 105, high: 105, low: 105 },
  ]) {
    const bars = fixture(7);
    Object.assign(bars[86]!, change);
    expect(threeMethods(bars, 90, 7, "long")).toMatchObject({
      matched: false,
      reason: expect.any(String),
    });
  }
  const bars = fixture(5);
  Object.assign(bars[87]!, { open: 105, close: 105, high: 106, low: 104 });
  expect(threeMethods(bars, 90, 5, "long").checks!.oppositeSmall).toBe(false);
  expect(threeMethods(bars.slice(86, 91), 4, 5, "long").reason).not.toBeNull();
});
it("keeps a confirmed exit through a blocked session and does not infer sell quantities", async () => {
  const bars = fixture(5),
    spec = settings("three-rising-5", bars),
    events = await researchSignals("sh600000", bars, spec, native);
  const run = (lookup: Parameters<typeof researchPortfolio>[4]) =>
    researchPortfolio(
      spec,
      events,
      bars.map((b) => b.date),
      new Map([["sh600000", bars]]),
      lookup,
    );
  expect(
    run((_s, date) => ({ ...rules, tradable: date !== bars[108]!.date }))
      .trades[0]!.exitDate,
  ).toBe(bars[109]!.date);
  const {
    minimumSell: _a,
    sellStep: _b,
    maximumSell: _c,
    sellOddLotAll: _d,
    ...buyOnly
  } = rules;
  expect(run(() => buyOnly).trades).toEqual([]);
});
it("applies the eleven-bar action window through the full research runner", async () => {
  const bars = fixture(7),
    spec = settings("three-rising-7", bars);
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "synthetic",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: spec.symbols!,
      source: null,
      warning: "合成",
    },
    benchmark: { symbol: "sh000001", bars },
    calendar: bars.map((b) => b.date),
    stocks: [
      {
        symbol: "sh600000",
        name: "合成",
        bars,
        hash: researchHash(bars),
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: { path: "fixture", modified: 0 },
    capturedAt: 0,
    hash: "three-fixture",
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
        start: bars[50]!.date,
        end: spec.end,
        evidenceId: "fixture",
      },
    ],
    rows: bars.map((b) => ({
      ...rules,
      evidence: undefined,
      symbol: "sh600000",
      date: b.date,
      evidenceId: "fixture",
    })),
  });
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.partitions[0]!.simulation!.trades[0]!.entryDate).toBe(
    bars[91]!.date,
  );
  expect(result.partitions[0]!.simulation!.trades[0]!.exitDate).toBe(
    bars[108]!.date,
  );
  const short = await runStrategyResearch(
    spec,
    dataset,
    {
      ...evidence,
      corporateActionFree: evidence.corporateActionFree.map((row) => ({
        ...row,
        start: spec.start,
      })),
    },
    native,
  );
  // corporateActionFree is legacy evidence metadata the engine no longer
  // consumes: admission is decided purely by prepareResearchAdjustedCoverage
  // (a complete GBBQ-derived price-factor prefix), which this dataset has
  // regardless of the asserted window. Shrinking the window must not change
  // anything.
  expect(short.events).toEqual(result.events);
  expect(short.partitions[0]!.simulation!.trades).toEqual(
    result.partitions[0]!.simulation!.trades,
  );
  const split = await runStrategyResearch(
    spec,
    {
      ...dataset,
      stocks: dataset.stocks.map((stock) => ({
        ...stock,
        actions: [
          {
            date: bars[55]!.date,
            category: 1,
            name: "合成除权",
            bonusRatio: 1,
          },
        ],
      })),
    },
    evidence,
    native,
  );
  // A category-1 bonus event still yields a complete price-factor prefix,
  // and continuation patterns only require price coverage, not volume
  // comparability — so admission now succeeds where the old "any action in
  // window" gate used to reject it wholesale.
  expect(split.events.length).toBeGreaterThan(0);
});
