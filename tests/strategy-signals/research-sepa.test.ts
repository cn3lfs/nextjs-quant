import { expect, it } from "vitest";
import type { Bar } from "../../src/lib/domain";
import {
  researchSepaSeries,
  sepaVcpScore,
} from "../../src/server/strategies/canslim/research-sepa";
import { researchSignals } from "../../src/server/strategies/shared/research-signals";
import { researchSpecSchema } from "../../src/lib/research/strategy-research";
const fixture = (): Bar[] => {
  const knots = [
    [0, 90],
    [8, 100],
    [16, 80],
    [24, 108],
    [32, 98],
    [40, 112],
    [48, 107],
    [56, 114],
    [59, 113],
  ];
  return Array.from({ length: 373 }, (_, i) => {
    let price = 50 + i * 0.08;
    if (i >= 310 && i < 370) {
      const j = i - 310,
        right = knots.findIndex((p) => p[0]! >= j),
        b = knots[right]!,
        a = knots[Math.max(0, right - 1)]!;
      price =
        b[0] === a[0]
          ? b[1]!
          : a[1]! + ((b[1]! - a[1]!) * (j - a[0]!)) / (b[0]! - a[0]!);
    }
    if (i >= 370) price = 116;
    return {
      date: new Date(Date.UTC(2023, 0, i + 1)).toISOString().slice(0, 10),
      open: price,
      close: price,
      high: price,
      low: price,
      volume: i >= 370 ? 200 : i >= 365 ? 10 : i >= 318 ? 40 : 100,
      amount: 10000,
    };
  });
};
it("uses confirmed pre-breakout VCP and six price-only trend checks", async () => {
  const bars = fixture(),
    points = researchSepaSeries("sepa-vcp-close", bars);
  expect(sepaVcpScore(bars.slice(0, 370))).toMatchObject({ score: 11 });
  expect(points[370]).toMatchObject({
    entry: true,
    candidate: { high: 114 },
    maxEntryPrice: 119.7,
    historyStart: bars[0]!.date,
  });
  expect(points.filter((p) => p.entry)).toHaveLength(1);
  expect(researchSepaSeries("sepa-vcp-close", bars.slice(0, 371))).toEqual(
    points.slice(0, 371),
  );
  const spec = researchSpecSchema.parse({
    strategy: "sepa-vcp-close",
    start: bars[369]!.date,
    end: bars[372]!.date,
    validationStart: bars[372]!.date,
  });
  const events = await researchSignals("sh600000", bars, spec, async () => {
    throw Error("unexpected native");
  });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    observedDate: bars[370]!.date,
    entryPriceRange: { min: 114, max: 119.7 },
  });
});
it("keeps volume variants and exact close/volume thresholds separate", () => {
  const bars = fixture();
  const previous = bars.slice(350, 370).reduce((s, b) => s + b.volume / 20, 0);
  bars[370]!.volume = previous * 1.5;
  expect(researchSepaSeries("sepa-vcp-close", bars)[370]!.entry).toBe(true);
  expect(researchSepaSeries("sepa-vcp-volume2", bars)[370]!.entry).toBe(false);
  bars[370]!.volume = previous * 2;
  expect(researchSepaSeries("sepa-vcp-volume2", bars)[370]!.entry).toBe(true);
  expect(researchSepaSeries("sepa-vcp-volume25", bars)[370]!.entry).toBe(false);
  bars[370]!.volume = previous * 2.5;
  expect(researchSepaSeries("sepa-vcp-volume25", bars)[370]!.entry).toBe(true);
  const fifty = bars.slice(320, 370).reduce((s, b) => s + b.volume / 50, 0);
  bars[370]!.volume = fifty * 1.5;
  expect(researchSepaSeries("sepa-vcp-volume50", bars)[370]!.entry).toBe(true);
  bars[370]!.close =
    bars[370]!.open =
    bars[370]!.high =
    bars[370]!.low =
      114 * 1.01;
  expect(researchSepaSeries("sepa-vcp-close", bars)[370]!.entry).toBe(false);
});
it("rejects incomplete/invalid history and cannot use future confirmation", () => {
  const bars = fixture();
  expect(
    researchSepaSeries("sepa-vcp-close", bars)[300]!.reason,
  ).not.toBeNull();
  const broken = structuredClone(bars);
  broken[100]!.volume = 0;
  expect(researchSepaSeries("sepa-vcp-close", broken)[370]!.entry).toBe(false);
  expect(
    researchSepaSeries(
      "sepa-vcp-close",
      bars.filter((_, i) => i !== 300),
      bars.map((b) => b.date),
    ).at(-1)!.reason,
  ).not.toBeNull();
  const future = [
    ...bars,
    { ...bars.at(-1)!, date: "2025-01-01", close: 10000, high: 10000 },
  ];
  expect(
    researchSepaSeries("sepa-vcp-close", future).slice(0, bars.length),
  ).toEqual(researchSepaSeries("sepa-vcp-close", bars));
});
it("bear exit is strict at both boundaries, independent of a fresh entry", () => {
  const bars = fixture();
  const prior = bars[370]!;
  const bar = bars[371]!;
  const mean = bars.slice(351, 371).reduce((s, b) => s + b.volume / 20, 0);
  Object.assign(bar, {
    open: prior.close,
    high: prior.close,
    low: 100,
    close: prior.close * 0.96,
    volume: mean * 2,
  });
  expect(researchSepaSeries("sepa-vcp-bear4", bars)[371]!.exit).toBe(false);
  bar.close -= 0.01;
  bar.volume = mean * 1.5;
  expect(researchSepaSeries("sepa-vcp-bear4", bars)[371]!.exit).toBe(false);
  bar.volume += 0.01;
  expect(researchSepaSeries("sepa-vcp-bear4", bars)[371]!.exit).toBe(true);
});

it("retest freezes the original pivot, waits a later day and cancels a breach", () => {
  const bars = fixture();
  Object.assign(bars[371]!, {
    low: 114,
    close: 116,
    open: 115,
    high: 117,
    volume: 200,
  });
  const p = researchSepaSeries("sepa-vcp-retest", bars);
  expect(p[370]!.entry).toBe(false);
  expect(p[371]).toMatchObject({
    entry: true,
    candidate: { high: 114 },
    retest: { breakoutDate: bars[370]!.date, confirmed: true },
  });
  expect(researchSepaSeries("sepa-vcp-retest", bars.slice(0, 372))).toEqual(
    p.slice(0, 372),
  );
  bars[371]!.low = 113.99;
  expect(researchSepaSeries("sepa-vcp-retest", bars).some((p) => p.entry)).toBe(
    false,
  );
});
it("weekly exit reuses completed-week reduction independent of the current entry", () => {
  const bars = fixture();
  for (let i = 0; i < 14; i++)
    bars.push({
      ...bars[0]!,
      date: new Date(Date.UTC(2023, 0, 374 + i)).toISOString().slice(0, 10),
      open: 40,
      high: 41,
      low: 39,
      close: 40,
    });
  const points = researchSepaSeries("sepa-vcp-weekly10-half", bars);
  const reductions = points.filter(
    (p) => "weeklyReduction" in p && p.weeklyReduction?.triggered,
  );
  expect(reductions).toHaveLength(1);
  expect(reductions[0]).toMatchObject({
    entry: false,
    weeklyReduction: { fraction: 0.5 },
  });
  const index = points.indexOf(reductions[0]!);
  expect(
    researchSepaSeries("sepa-vcp-weekly10-half", bars.slice(0, index + 1)),
  ).toEqual(points.slice(0, index + 1));
});

it("accepts production's bounded benchmark calendar with full stock history", () => {
  const bars = fixture();
  expect(
    researchSepaSeries(
      "sepa-vcp-close",
      bars,
      bars.slice(120).map((b) => b.date),
    )[370],
  ).toMatchObject({ entry: true });
});
