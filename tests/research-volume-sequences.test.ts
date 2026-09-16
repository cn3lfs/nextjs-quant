import { expect, it, vi } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  researchVolumeContextSeries,
  type VolumeContextId,
} from "../src/lib/research-volume-context";
import { researchSpecSchema } from "../src/lib/strategy-research";
import { researchSignals } from "../src/server/research-signals";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";

function fixture(tail: { close: number; volume: number }[]): Bar[] {
  return [
    ...Array.from({ length: 90 }, (_, i) => ({
      close: i >= 86 ? 117.4 : 100 + i * 0.2,
      volume: 100,
    })),
    ...tail,
  ].map((b, i) => ({
    ...b,
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: b.close,
    high: b.close + 0.5,
    low: b.close - 0.5,
    amount: b.close * b.volume,
  }));
}
const interval = fixture([
  ...Array.from({ length: 7 }, (_, i) => ({
    close: i === 6 ? 119 : 117.8,
    volume: i % 3 === 0 ? 300 : 30,
  })),
  { close: 120, volume: 100 },
  { close: 121, volume: 100 },
]);
const isolated = fixture([
  { close: 119, volume: 300 },
  { close: 120, volume: 300 },
  { close: 121, volume: 100 },
  { close: 122, volume: 100 },
]).map((b, i) => (i >= 87 && i <= 89 ? { ...b, volume: 20 } : b));
const stall = fixture([
  { close: 120, volume: 200 },
  { close: 121.2, volume: 250 },
  { close: 121.806, volume: 300 },
  { close: 122, volume: 100 },
]);
const lowVolume = fixture([
  { close: 119, volume: 200 },
  { close: 120, volume: 100 },
  { close: 121, volume: 100 },
]);
const cases: [VolumeContextId, Bar[], number, number, number][] = [
  ["vp-interval-3", interval, 96, 97, 98],
  ["vp-isolated-filter", isolated, 91, 92, 93],
  ["vp-stall-exit", stall, 90, 91, 93],
  ["vp-high-low-volume-exit", lowVolume, 90, 91, 92],
];
const native = vi.fn(async () => {
  throw new Error("unexpected native");
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
it.each(cases)(
  "%s preserves event timing, independent exits and causal evidence",
  async (id, input, signalIndex, entryIndex, exitIndex) => {
    const points = researchVolumeContextSeries(id, input);
    expect(points.flatMap((p, i) => (p.entry && i >= 90 ? [i] : []))).toEqual([
      signalIndex,
    ]);
    const spec = researchSpecSchema.parse({
      strategy: id,
      start: input[90]!.date,
      end: input.at(-1)!.date,
      validationStart: input.at(-1)!.date,
      holdingDays: id.endsWith("exit") ? 60 : 1,
      initialCapital: 100000,
      maxPositions: 1,
      costs: {
        commissionBps: 0,
        minimumCommission: 0,
        sellTaxBps: 0,
        slippageBps: 0,
      },
    });
    const events = await researchSignals("sh600000", input, spec, native);
    expect(events).toHaveLength(1);
    expect(events[0]!.observedDate).toBe(input[signalIndex]!.date);
    const result = researchPortfolio(
      spec,
      events,
      input.map((b) => b.date),
      new Map([["sh600000", input]]),
      () => rules,
    );
    expect(result.trades[0]!.entryDate).toBe(input[entryIndex]!.date);
    expect(result.trades[0]!.exitDate).toBe(input[exitIndex]!.date);
    expect(result.trades[0]!.profit).toBeGreaterThan(0);
    if (id.endsWith("exit"))
      expect(result.trades[0]!.signalExit).toEqual(points[exitIndex - 1]);
    expect(researchMethodSnapshot(id).sources).toHaveLength(
      id === "vp-interval-3" ? 4 : 5,
    );
    for (let length = 87; length <= input.length; length++)
      expect(researchVolumeContextSeries(id, input.slice(0, length))).toEqual(
        points.slice(0, length),
      );
    expect(
      researchVolumeContextSeries(id, [
        ...input,
        {
          ...input.at(-1)!,
          date: "2025-12-01",
          close: 1,
          open: 1,
          high: 2,
          low: 0.5,
          volume: 999999,
        },
      ]).slice(0, input.length),
    ).toEqual(points);
  },
);

it("identifies an isolated pulse only after its next bar and retains non-risk baseline entries", () => {
  const rows = researchVolumeContextSeries("vp-isolated-filter", isolated);
  expect(rows[90]!.multiDay!.isolatedRisk).toBe(true);
  expect(rows[90]!.entry).toBe(false);
  expect(rows[91]!.entry).toBe(true);
  expect(rows[91]!.ruleStop!.price).toBeCloseTo(117.9);
  const rejected = isolated.map((b, i) =>
    i === 91 ? { ...b, volume: 20 } : b,
  );
  const bad = researchVolumeContextSeries("vp-isolated-filter", rejected);
  expect(bad[91]!.decision).toContain("前后缩量形成孤量");
  expect(bad.slice(90).some((p) => p.entry)).toBe(false);
  const broken = isolated.map((b, i) => (i === 91 ? { ...b, low: 117 } : b));
  expect(
    researchVolumeContextSeries("vp-isolated-filter", broken)[91]!.entry,
  ).toBe(false);
  expect(
    researchVolumeContextSeries("vp-isolated-filter", lowVolume)[90]!.entry,
  ).toBe(true);
});

it("uses the most recent tied price high and compares its volume rather than an average", () => {
  const tied = fixture([
    { close: 119, volume: 200 },
    { close: 119, volume: 50 },
    { close: 120, volume: 100 },
  ]);
  const row = researchVolumeContextSeries("vp-high-low-volume-exit", tied)[92]!;
  expect(row.multiDay!.previousHigh).toEqual({
    date: tied[91]!.date,
    high: 119.5,
    volume: 50,
  });
  expect(row.exit).toBe(false);
  const lower = researchVolumeContextSeries(
    "vp-high-low-volume-exit",
    lowVolume,
  )[91]!;
  expect(lower.multiDay!.previousHigh!.volume).toBe(200);
  expect(lower.exit).toBe(true);
});

it("rejects a malformed interval, a missing bar and rising rather than contracting gains", () => {
  const malformed = interval.map((b, i) =>
    i === 94 ? { ...b, volume: 300 } : b,
  );
  expect(
    researchVolumeContextSeries("vp-interval-3", malformed)[96]!.entry,
  ).toBe(false);
  const suspended = interval.map((b, i) =>
    i === 94 ? { ...b, volume: 0 } : b,
  );
  expect(
    researchVolumeContextSeries("vp-interval-3", suspended)[96]!.reason,
  ).not.toBeNull();
  const increasing = stall.map((b, i) =>
    i === 92 ? { ...b, close: 123, open: 123, high: 123.5, low: 122.5 } : b,
  );
  expect(
    researchVolumeContextSeries("vp-stall-exit", increasing)[92]!.exit,
  ).toBe(false);
  expect(native).not.toHaveBeenCalled();
});
