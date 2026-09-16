import { expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  researchVolumeFailureSeries as series,
  volumeFailureIds,
  type VolumeFailureId,
} from "../src/lib/research-volume-failure";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchSignals } from "../src/server/research-signals";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
import { researchMarketEvidenceSchema } from "../src/lib/research-market-evidence";
import { runStrategyResearch } from "../src/server/research-run";
import {
  researchHash,
  type ResearchDataset,
} from "../src/server/research-dataset";

const native = vi.fn(async () => {
  throw new Error("no CZSC");
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
function fixture(): Bar[] {
  return Array.from({ length: 99 }, (_, i) => {
    const close = i < 90 ? 100 + i * 0.2 : i === 90 ? 121 : 119,
      volume = i === 90 ? 300 : 100;
    return {
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume,
      amount: close * volume,
    };
  });
}
function breakAt(at: number) {
  const bars = fixture();
  Object.assign(bars[at]!, {
    open: 119,
    close: 118.1,
    high: 119.5,
    low: 117.9,
  });
  return bars;
}
function shape(wick: boolean) {
  const bars = fixture();
  Object.assign(
    bars[91]!,
    wick
      ? { open: 121, close: 121.2, high: 123, low: 120.8, volume: 350 }
      : { open: 122, close: 121, high: 122.5, low: 120.5, volume: 350 },
  );
  return bars;
}
function specFor(id: VolumeFailureId, bars: Bar[]) {
  return researchSpecSchema.parse({
    strategy: id,
    start: bars[90]!.date,
    end: bars.at(-1)!.date,
    validationStart: bars.at(-1)!.date,
    holdingDays: 6,
    entryMaxWait: 3,
    initialCapital: 100000,
    maxPositions: 1,
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
}
async function run(id: VolumeFailureId, bars: Bar[], blocked: number[] = []) {
  const spec = specFor(id, bars),
    events = await researchSignals("sh600000", bars, spec, native);
  const result = researchPortfolio(
    spec,
    events,
    bars.map((b) => b.date),
    new Map([["sh600000", bars]]),
    (_symbol, date) => ({
      ...rules,
      tradable: !blocked.some((i) => bars[i]!.date === date),
    }),
  );
  return { events, result };
}
it("counts false-break windows from the signal, including the last allowed bar", () => {
  for (const [id, window] of [
    ["vp-failure-1", 1],
    ["vp-failure-2", 2],
    ["vp-failure-3", 3],
  ] as const) {
    const at = 90 + window,
      rows = series(id, breakAt(at));
    expect(rows[90]!.entry).toBe(true);
    expect(rows[90]!.ruleStop?.days).toBe(0);
    expect(rows[at]!.failure.active[0]!.age).toBe(window);
    expect(rows[at]!.failure.triggered).toEqual([rows[90]!.date]);
    expect(rows[at]!.exit).toBe(true);
    const expired = series(id, breakAt(at + 1));
    expect(expired[at + 1]!.failure.triggered).toEqual([]);
    expect(expired[at + 1]!.exit).toBe(false);
  }
});
it("does not reset the clock on delayed entry or silently apply the old three-bar guard", async () => {
  const bars = breakAt(92);
  const one = await run("vp-failure-1", bars, [91]);
  expect(one.events).toHaveLength(1);
  expect(one.result.trades[0]!.entryDate).toBe(bars[92]!.date);
  expect(one.result.trades[0]!.ruleStopTriggeredAt).toBeUndefined();
  expect(one.result.trades[0]!.exitDate).toBe(bars[98]!.date);
  const two = await run("vp-failure-2", bars, [91]);
  expect(two.result.trades[0]!.entryDate).toBe(bars[92]!.date);
  expect(two.result.trades[0]!.exitDate).toBe(bars[93]!.date);
  expect(two.result.trades[0]!.signalExit).toEqual(
    series("vp-failure-2", bars)[92],
  );
  const cancelled = await run("vp-failure-2", bars, [91, 92]);
  expect(cancelled.result.trades).toEqual([]);
  expect(
    cancelled.result.excluded.some((e) => e.reason.includes("取消旧买入意图")),
  ).toBe(true);
});
it("keeps a confirmed exit pending through a blocked sale and rejects opening below the frozen level", async () => {
  const bars = breakAt(92),
    blocked = await run("vp-failure-2", bars, [93]);
  expect(blocked.result.trades[0]!.exitDate).toBe(bars[94]!.date);
  expect(blocked.result.trades[0]!.signalExit?.date).toBe(bars[92]!.date);
  Object.assign(bars[91]!, { open: 118, low: 117.5 });
  const gap = await run("vp-failure-1", bars);
  expect(gap.result.trades).toEqual([]);
  expect(gap.result.excluded.some((e) => e.reason.includes("开盘已失守"))).toBe(
    true,
  );
});
it("separates a red candle from a price decline and a long upper wick, with strict larger volume", async () => {
  const bear = shape(false),
    wick = shape(true);
  expect(series("vp-next-bear-exit", bear)[91]!.exit).toBe(true);
  expect(series("vp-next-wick-exit", bear)[91]!.exit).toBe(false);
  expect(series("vp-next-bear-exit", wick)[91]!.exit).toBe(false);
  expect(series("vp-next-wick-exit", wick)[91]!.exit).toBe(true);
  for (const bars of [bear, wick]) {
    const rows = series("vp-next-shape-exit", bars);
    expect(rows[91]!.failure.triggered).toEqual([bars[90]!.date]);
    const result = await run("vp-next-shape-exit", bars);
    expect(result.result.trades[0]!.entryDate).toBe(bars[91]!.date);
    expect(result.result.trades[0]!.exitDate).toBe(bars[92]!.date);
    expect(result.result.trades[0]!.signalExit).toEqual(rows[91]);
    bars[91]!.volume = 300;
    expect(series("vp-next-shape-exit", bars)[91]!.failure.triggered).toEqual(
      [],
    );
  }
});
it("uses the exact upper-wick boundary and only the next bar", () => {
  const bars = shape(true);
  Object.assign(bars[91]!, { open: 121, close: 121.2, high: 122, low: 120.4 });
  expect(
    series("vp-next-wick-exit", bars)[91]!.failure.upperWickFraction,
  ).toBeCloseTo(0.5);
  expect(series("vp-next-wick-exit", bars)[91]!.exit).toBe(true);
  bars[91]!.high = 121.99;
  expect(series("vp-next-wick-exit", bars)[91]!.exit).toBe(false);
  const late = fixture();
  Object.assign(late[92]!, {
    open: 122,
    close: 121,
    high: 122.5,
    low: 120.5,
    volume: 350,
  });
  expect(series("vp-next-shape-exit", late)[92]!.failure.triggered).toEqual([]);
});
it.each(volumeFailureIds)(
  "%s preserves causal prefixes and method source identity",
  (id) => {
    const bars = id.startsWith("vp-failure")
        ? breakAt(92)
        : shape(id === "vp-next-wick-exit"),
      full = series(id, bars);
    for (let n = 89; n <= bars.length; n++)
      expect(series(id, bars.slice(0, n))).toEqual(full.slice(0, n));
    const invalid = bars.map((b, i) => (i === 91 ? { ...b, volume: 0 } : b));
    expect(series(id, invalid)[91]!.reason).not.toBeNull();
    expect(series(id, invalid)[92]!.failure.triggered).toEqual([]);
    expect(researchMethodSnapshot(id).sources).toHaveLength(4);
    expect(native).not.toHaveBeenCalled();
  },
);

it("freezes every overlapping signal separately instead of replacing the earlier line", () => {
  const bars = fixture();
  Object.assign(bars[91]!, { open: 120, close: 120, high: 120.5, low: 119.5 });
  Object.assign(bars[92]!, {
    open: 124,
    close: 124,
    high: 124.5,
    low: 123.5,
    volume: 350,
  });
  Object.assign(bars[93]!, { open: 122, close: 121, high: 122.5, low: 120.5 });
  const rows = series("vp-failure-3", bars);
  expect(rows[92]!.entry).toBe(true);
  expect(rows[93]!.failure.active.map((r) => [r.date, r.level, r.age])).toEqual(
    [
      [bars[90]!.date, 118.3, 3],
      [bars[92]!.date, 121.5, 1],
    ],
  );
  expect(rows[93]!.failure.triggered).toEqual([bars[92]!.date]);
});

it.each(volumeFailureIds)(
  "%s has a complete entry and independently confirmed exit",
  async (id) => {
    const bars = id.startsWith("vp-failure")
      ? breakAt(91)
      : shape(id === "vp-next-wick-exit");
    const { events, result } = await run(id, bars);
    expect(events).toHaveLength(1);
    expect(events[0]!.observedDate).toBe(bars[90]!.date);
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]!.entryDate).toBe(bars[91]!.date);
    expect(result.trades[0]!.exitDate).toBe(bars[92]!.date);
    expect(result.trades[0]!.signalExit).toEqual(series(id, bars)[91]);
  },
);

it("requires volume warmup action evidence in the complete research runner", async () => {
  const bars = breakAt(92),
    spec = researchSpecSchema.parse({
      ...specFor("vp-failure-2", bars),
      symbols: ["sh600000"],
    });
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
    hash: "failure-fixture",
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: bars[19]!.date,
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
  expect(result.partitions[0]!.simulation!.statistics.count).toBe(1);
  expect(result.partitions[0]!.simulation!.trades[0]!.exitDate).toBe(
    bars[93]!.date,
  );
  expect(result.warnings[0]).toContain("71根价格");
  const short = await runStrategyResearch(
    spec,
    dataset,
    {
      ...evidence,
      corporateActionFree: evidence.corporateActionFree.map((r) => ({
        ...r,
        start: bars[29]!.date,
      })),
    },
    native,
  );
  expect(short.events).toEqual(result.events);
  expect(short.partitions[0]!.simulation!.trades).toEqual([]);
  const split = await runStrategyResearch(
    spec,
    {
      ...dataset,
      stocks: dataset.stocks.map((s) => ({
        ...s,
        actions: [
          {
            date: bars[20]!.date,
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
  expect(split.events).toEqual([]);
  expect(split.exclusions[0]!.reason).toContain("量价窗口含除权");
});
