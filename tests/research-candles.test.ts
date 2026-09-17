import { expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";
import { candlePatterns } from "../src/lib/indicators";
import { breakoutPatterns } from "../src/server/breakout";
import {
  candleStrategyIds,
  researchCandleSeries,
  type CandleStrategyId,
} from "../src/lib/research-candles";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchSignals } from "../src/server/research-signals";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
import { runStrategyResearch } from "../src/server/research-run";
import {
  researchHash,
  type ResearchDataset,
} from "../src/server/research-dataset";
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
function fixture(id: CandleStrategyId): Bar[] {
  const bars = Array.from({ length: 102 }, (_, i) => {
    const close = i >= 61 && i <= 81 ? 80 + (i - 61) : 100;
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
  const put = (
    i: number,
    open: number,
    close: number,
    high = Math.max(open, close) + 1,
    low = Math.min(open, close) - 1,
  ) => Object.assign(bars[i]!, { open, close, high, low });
  for (let i = 85; i < 90; i++) put(i, 113 - (i - 85) * 2, 112 - (i - 85) * 2);
  if (id.includes("hammer") || id.includes("shooting"))
    put(90, 101, 102, 102.1, 98);
  else if (id.includes("engulf")) {
    put(89, 104, 100);
    put(90, 99, 105);
  } else if (id.includes("star") || id.includes("morning")) {
    put(88, 106, 100);
    put(89, 98, id.includes("doji") ? 98 : 98.2, 98.5, 97.5);
    put(90, 99, 105);
  } else put(90, 100, 100, 101, 99);
  if (id.endsWith("-exit")) {
    for (let i = 85; i <= 90; i++) {
      const b = bars[i]!;
      Object.assign(b, {
        open: 200 - b.open,
        close: 200 - b.close,
        high: 200 - b.low,
        low: 200 - b.high,
      });
    }
    if (id.includes("dark-cloud")) {
      put(89, 96, 102, 103, 95);
      put(90, 104, 98, 105, 97);
    }
    put(91, 100, 101);
  } else {
    for (let i = 91; i < 96; i++)
      put(i, 102 + (i - 91) * 2, 103 + (i - 91) * 2);
    put(96, 112, 112, 113, 111);
    put(97, 110, 109);
  }
  return bars;
}
function specFor(id: CandleStrategyId, bars: Bar[]) {
  return researchSpecSchema.parse({
    strategy: id,
    start: bars[61]!.date,
    end: bars.at(-1)!.date,
    validationStart: bars[100]!.date,
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
it.each(candleStrategyIds)(
  "%s has causal signals and a next-open complete trade",
  async (id) => {
    const bars = fixture(id),
      spec = specFor(id, bars),
      series = researchCandleSeries(id, bars),
      point = series[90]!;
    expect(point.reason).toBeNull();
    expect(id.endsWith("-exit") ? point.exit : point.entry).toBe(true);
    expect(researchCandleSeries(id, bars.slice(0, 91))).toEqual(
      series.slice(0, 91),
    );
    const events = await researchSignals("sh600000", bars, spec, native);
    const result = researchPortfolio(
      spec,
      events,
      bars.map((b) => b.date),
      new Map([["sh600000", bars]]),
      () => rules,
    );
    const trade = id.endsWith("-exit")
      ? result.trades.find((t) => t.exitDate === bars[91]!.date)
      : result.trades.find((t) => t.entryDate === bars[91]!.date);
    expect(trade).toBeDefined();
    expect(trade!.exitDate).toBe(bars[id.endsWith("-exit") ? 91 : 97]!.date);
    expect(trade!.signalExit).toEqual(series[id.endsWith("-exit") ? 90 : 96]);
    expect(researchMethodSnapshot(spec).ruleVersion).toBe(`${id}-1`);
    expect(native).not.toHaveBeenCalled();
  },
);

it("keeps the five legacy diagnostic patterns and distinguishes doji, gaps, shadows and engulfing", () => {
  for (const id of candleStrategyIds) {
    const bars = fixture(id);
    for (const direction of ["long", "short"] as const)
      expect(breakoutPatterns(bars, 90, direction)).toEqual(
        candlePatterns(bars, 90, direction),
      );
  }
  const star = fixture("candle-morning-star");
  expect(researchCandleSeries("candle-morning-doji", star)[90]!.entry).toBe(
    false,
  );
  Object.assign(star[89]!, { open: 100, close: 100, high: 101, low: 99 });
  expect(researchCandleSeries("candle-morning-star", star)[90]!.entry).toBe(
    false,
  );
  const hammer = fixture("candle-hammer");
  hammer[90]!.high = 102.3;
  expect(researchCandleSeries("candle-hammer", hammer)[90]!.entry).toBe(false);
  const engulf = fixture("candle-bull-engulf");
  Object.assign(engulf[90]!, { open: 100, close: 104 });
  expect(researchCandleSeries("candle-bull-engulf", engulf)[90]!.entry).toBe(
    false,
  );
  const cloud = fixture("candle-dark-cloud-exit");
  cloud[90]!.close = 99;
  expect(researchCandleSeries("candle-dark-cloud-exit", cloud)[90]!.exit).toBe(
    false,
  );
});

it("rejects invalid background and does not treat a one-price suspension as a doji", () => {
  for (const mutation of [
    { volume: 0 },
    { volume: NaN },
    { high: NaN },
    { low: 200 },
  ]) {
    const bars = fixture("candle-hammer");
    Object.assign(bars[87]!, mutation);
    expect(researchCandleSeries("candle-hammer", bars)[90]).toMatchObject({
      entry: false,
      exit: false,
      reason: expect.any(String),
    });
  }
  const bars = fixture("candle-bottom-doji");
  Object.assign(bars[90]!, { open: 100, close: 100, high: 100, low: 100 });
  expect(researchCandleSeries("candle-bottom-doji", bars)[90]!.entry).toBe(
    false,
  );
  const rising = fixture("candle-hammer");
  rising[87]!.close = 101;
  rising[87]!.low = 100;
  expect(researchCandleSeries("candle-hammer", rising)[90]!.entry).toBe(false);
});

it("keeps a confirmed candle exit pending through a blocked open and requires independent sell rules", async () => {
  const bars = fixture("candle-hammer"),
    spec = specFor("candle-hammer", bars);
  const events = await researchSignals("sh600000", bars, spec, native);
  const simulate = (lookup: Parameters<typeof researchPortfolio>[4]) =>
    researchPortfolio(
      spec,
      events,
      bars.map((b) => b.date),
      new Map([["sh600000", bars]]),
      lookup,
    );
  const delayed = simulate((_symbol, date) => ({
    ...rules,
    tradable: date !== bars[97]!.date,
  }));
  expect(delayed.trades[0]!.exitDate).toBe(bars[98]!.date);
  expect(delayed.trades[0]!.signalExit!.date).toBe(bars[96]!.date);
  const {
    minimumSell: _a,
    sellStep: _b,
    maximumSell: _c,
    sellOddLotAll: _d,
    ...buyOnly
  } = rules;
  expect(simulate(() => buyOnly).trades).toEqual([]);
});

it("requires prehistory action evidence and rejects known ex-rights in the complete research runner", async () => {
  const bars = fixture("candle-hammer"),
    spec = specFor("candle-hammer", bars);
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
    hash: "candle-fixture",
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
    bars[97]!.date,
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
  expect(split.events.length).toBeGreaterThan(0);
  expect(split.warnings.some((warning) => warning.includes("后复权"))).toBe(
    true,
  );
});
