import { expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";
import { priceChannel } from "../src/lib/indicators";
import {
  channelIds,
  researchChannelSeries,
  channelWarmupBars,
  type ChannelId,
} from "../src/lib/research-channels";
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
const lengthOf = (id: ChannelId) => Number(id.split("-")[1]);
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
function shape(bars: Bar[], id: ChannelId, end: number, down: boolean) {
  const n = lengthOf(id),
    start = end - n,
    flag = id.startsWith("flag");
  if (flag)
    for (let j = 0; j < 6; j++)
      put(bars, start - 6 + j, 99.8 + j * 2, 100 + j * 2);
  for (let j = 0; j < n; j++) {
    const high = flag ? 109.5 - j * 0.03 : 112 - (j * 3) / (n - 1),
      low = flag ? 107.5 - j * 0.03 : 100 + (j * 3) / (n - 1),
      close = (high + low) / 2;
    put(bars, start + j, close - 0.1, close, high, low);
  }
  put(bars, end, 111, 113, 114, 110);
  if (down) {
    if (flag)
      for (let i = start - 6; i <= end; i++) {
        const b = bars[i]!;
        Object.assign(b, {
          open: 200 - b.open,
          close: 200 - b.close,
          high: 200 - b.low,
          low: 200 - b.high,
        });
      }
    else put(bars, end, 100, 98, 101, 97);
  }
}
function fixture(id: ChannelId) {
  const bars = Array.from({ length: 151 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 113.8,
    close: 114,
    high: 115,
    low: 113,
    volume: 10000,
    amount: 1140000,
  }));
  shape(bars, id, 90, false);
  shape(bars, id, 140, true);
  return bars;
}
function settings(id: ChannelId, bars: Bar[]) {
  return researchSpecSchema.parse({
    strategy: id,
    start: bars[61]!.date,
    end: bars.at(-1)!.date,
    validationStart: bars[149]!.date,
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
it.each(channelIds)(
  "%s freezes a pre-break channel and completes next-open trades",
  async (id) => {
    const bars = fixture(id),
      spec = settings(id, bars),
      series = researchChannelSeries(id, bars);
    expect(series[90]!.entry).toBe(true);
    expect(series[89]!.entry).toBe(false);
    expect(series[140]!.exit).toBe(true);
    expect(series[90]!.channel.end).toBe(bars[89]!.date);
    expect(series[90]!.ruleStop!.price).toBe(
      series[90]!.channel.geometry!.lower.next,
    );
    expect(researchChannelSeries(id, bars.slice(0, 91))).toEqual(
      series.slice(0, 91),
    );
    const changed = structuredClone(bars);
    changed[90]!.high = 10000;
    expect(researchChannelSeries(id, changed)[90]!.channel).toEqual(
      series[90]!.channel,
    );
    const events = await researchSignals("sh600000", bars, spec, native);
    const result = researchPortfolio(
      spec,
      events,
      bars.map((b) => b.date),
      new Map([["sh600000", bars]]),
      () => rules,
    );
    const trade = result.trades.find(
      (t) => t.event.observedDate === bars[90]!.date,
    );
    expect(trade).toBeDefined();
    expect(trade!.entryDate).toBe(bars[91]!.date);
    expect(trade!.exitDate).toBe(bars[141]!.date);
    expect(trade!.signalExit).toEqual(series[140]);
    expect(researchMethodSnapshot(spec).ruleVersion).toBe(`${id}-1`);
    expect(native).not.toHaveBeenCalled();
  },
);
it("fits outward lines with hand-computable widths, slopes and distributed touches", () => {
  const bars = fixture("triangle-15"),
    window = bars.slice(75, 90),
    copy = structuredClone(window),
    c = priceChannel(window)!;
  expect(c.upper.slope).toBeCloseTo(-3 / 14, 12);
  expect(c.lower.slope).toBeCloseTo(3 / 14, 12);
  expect(c.startWidth).toBeCloseTo(12, 10);
  expect(c.endWidth).toBeCloseTo(6, 10);
  expect(c.nextWidth).toBeCloseTo(6 - 6 / 14, 10);
  expect(c.wellFormed).toBe(true);
  expect(c.upper.touches).toHaveLength(15);
  expect(window).toEqual(copy);
  const sparse = structuredClone(window);
  sparse[7]!.high += 0.4;
  expect(priceChannel(sparse)!.wellFormed).toBe(false);
  const crossed = window.map((b, i) => ({
    ...b,
    open: 106,
    close: 106,
    high: 112 - i * 0.42,
    low: 100 + i * 0.42,
  }));
  expect(priceChannel(crossed)).toBeNull();
  const current = { ...bars[90]!, open: 106, close: 106, high: 107, low: 105 };
  expect(
    researchChannelSeries("triangle-15", [...crossed, current])[15],
  ).toMatchObject({ entry: false, exit: false, reason: null });
});
it("rejects weak poles, nonparallel flags and insufficient triangle convergence", () => {
  const weak = fixture("flag-10");
  for (let i = 74; i < 80; i++)
    put(weak, i, 104 + (i - 74) * 0.2, 104.1 + (i - 74) * 0.2);
  expect(researchChannelSeries("flag-10", weak)[90]!.entry).toBe(false);
  const flag = fixture("flag-10");
  for (let j = 0; j < 10; j++) {
    const b = flag[80 + j]!;
    b.low = 107.5 - j * 0.15;
  }
  expect(researchChannelSeries("flag-10", flag)[90]!.entry).toBe(false);
  const triangle = fixture("triangle-15");
  for (let j = 0; j < 15; j++) {
    const b = triangle[75 + j]!;
    b.high = 112 - j * 0.01;
    b.low = 100 + j * 0.01;
  }
  expect(researchChannelSeries("triangle-15", triangle)[90]!.entry).toBe(false);
  const touch = fixture("triangle-15"),
    line = researchChannelSeries("triangle-15", touch)[90]!.channel.geometry!
      .upper.next;
  put(touch, 90, line - 0.1, line, line + 1, line - 1);
  expect(researchChannelSeries("triangle-15", touch)[90]!.entry).toBe(false);
});
it("rejects missing or invalid pole/consolidation data and never creates a one-price channel", () => {
  for (const [i, change] of [
    [75, { volume: 0 }],
    [85, { high: NaN }],
    [90, { open: 113, close: 113, high: 113, low: 113 }],
  ] as const) {
    const bars = fixture("flag-10");
    Object.assign(bars[i]!, change);
    expect(researchChannelSeries("flag-10", bars)[90]).toMatchObject({
      entry: false,
      exit: false,
      reason: expect.any(String),
    });
  }
  expect(
    priceChannel(
      fixture("flag-10")
        .slice(80, 90)
        .map((b) => ({ ...b, open: 1, close: 1, high: 1, low: 1 })),
    ),
  ).toBeNull();
});
it("rejects entry below the frozen floor and preserves a queued exit through a tradability block", async () => {
  const id = "flag-10",
    bars = fixture(id),
    spec = settings(id, bars),
    events = await researchSignals("sh600000", bars, spec, native);
  const run = (input: Bar[], lookup: Parameters<typeof researchPortfolio>[4]) =>
    researchPortfolio(
      spec,
      events,
      input.map((b) => b.date),
      new Map([["sh600000", input]]),
      lookup,
    );
  const gap = structuredClone(bars);
  put(gap, 91, 100, 101);
  expect(
    run(gap, () => rules).trades.some(
      (t) => t.event.observedDate === bars[90]!.date,
    ),
  ).toBe(false);
  const delayed = run(bars, (_s, date) => ({
    ...rules,
    tradable: date !== bars[141]!.date,
  }));
  expect(delayed.trades[0]!.exitDate).toBe(bars[142]!.date);
  expect(delayed.trades[0]!.signalExit!.date).toBe(bars[140]!.date);
  const broken = structuredClone(bars);
  put(broken, 92, 110, 100, 111, 99);
  const stopped = run(broken, () => rules);
  expect(stopped.trades[0]!.exitDate).toBe(bars[93]!.date);
  expect(stopped.trades[0]!.ruleStopTriggeredAt).toBe(bars[92]!.date);
});
it.each(["flag-20", "triangle-30"] as const)(
  "%s requires its own action warmup in the full runner",
  async (id) => {
    const bars = fixture(id),
      spec = settings(id, bars),
      warmup = channelWarmupBars(id);
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
      hash: "channel-fixture",
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
          start: bars[61 - warmup]!.date,
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
    expect(result.partitions[0]!.simulation!.trades[0]!.exitDate).toBe(
      bars[141]!.date,
    );
    expect(result.warnings[0]).toContain(`前${warmup}根`);
    const short = await runStrategyResearch(
      spec,
      dataset,
      {
        ...evidence,
        corporateActionFree: evidence.corporateActionFree.map((row) => ({
          ...row,
          start: bars[50]!.date,
        })),
      },
      native,
    );
    // corporateActionFree is legacy evidence metadata the engine no longer
    // consumes: admission is decided purely by prepareResearchAdjustedCoverage
    // (a complete GBBQ-derived price-factor prefix), which this dataset has
    // regardless of the asserted window. Shrinking the window must not
    // change anything.
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
              date: bars[61 - warmup]!.date,
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
    // A category-1 bonus event still yields a complete price-factor prefix
    // (adjustmentFactors handles it directly), and channel/continuation
    // patterns only require price coverage, not volume comparability — so
    // admission now succeeds where the old "any action in window" gate used
    // to reject it wholesale.
    expect(split.events.length).toBeGreaterThan(0);
  },
);
