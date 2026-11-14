import { researchFormulaRuntime } from "~/lib/research/technical/research-formula-runtime";
import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { canslimSaucerShape } from "trading-strategies/research/canslim/research-canslim-strategies";
import { researchCanslimSaucerPoint } from "trading-strategies/research/canslim/research-canslim-saucer";
import { researchRuleSeries } from "trading-strategies/research/composition/research-rule-series";

function fixture(shape: "U" | "W"): Bar[] {
  return Array.from({ length: 174 }, (_, i) => {
    let high =
      i < 130 ? 100 : i < 160 ? 93 + 7 * ((i - 144.5) / 14.5) ** 2 : 103;
    if (shape === "W" && i >= 130 && i < 160) {
      const knots = [
        [130, 100],
        [138, 94],
        [145, 99],
        [152, 94],
        [159, 100],
      ] as const;
      const right = Math.max(
        1,
        knots.findIndex(([index]) => index >= i),
      );
      const a = knots[right - 1]!,
        b = knots[right]!;
      high = a[1] + ((b[1] - a[1]) * (i - a[0])) / (b[0] - a[0]);
    }
    return {
      date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
      high,
      low: i > 160 ? 101 : high - 1,
      open: high - 0.5,
      close: high - 0.2,
      volume: i < 130 ? 100 : i < 160 ? 30 : 200,
      amount: 1000000,
    };
  });
}

it.each(["U", "W"] as const)(
  "%s keeps its geometry and original pivot with prefix-only confirmation",
  (shape) => {
    const bars = fixture(shape);
    const point = researchCanslimSaucerPoint(shape, bars.slice(0, 161));
    expect(point).toMatchObject({
      entry: true,
      maxEntryPrice: 105,
      candidate: { shape, high: 100, qualified: true },
    });
    expect(point.candidate!.points).toBe(shape === "U" ? 10 : 9);
    expect(point.candidate!.length).toBeLessThanOrEqual(120);
    expect(
      researchCanslimSaucerPoint(shape === "U" ? "W" : "U", bars.slice(0, 161))
        .entry,
    ).toBe(false);
    if (shape === "W")
      expect(point.candidate!.doubleBottom).toMatchObject({
        second: bars[152]!.date,
        secondConfirmedAt: bars[155]!.date,
      });
    expect(researchCanslimSaucerPoint(shape, bars.slice(0, 160)).entry).toBe(
      false,
    );
    const id = shape === "U" ? "canslim-saucer-u" : "canslim-saucer-w";
    const before = researchRuleSeries(
      id,
      bars,
      undefined,
      undefined,
      undefined,
      researchFormulaRuntime,
    );
    const future = structuredClone(bars);
    future[166]!.high = 1000;
    expect(
      researchRuleSeries(
        id,
        future,
        undefined,
        undefined,
        undefined,
        researchFormulaRuntime,
      ).slice(0, 166),
    ).toEqual(before.slice(0, 166));
  },
);

it("requires breakout volume and the 1%/5% price interval without treating invalid bars as no signal", () => {
  const bars = fixture("U").slice(0, 161);
  for (const close of [101, 105.01]) {
    const changed = structuredClone(bars);
    Object.assign(changed[160]!, {
      close,
      high: Math.max(106, close),
      low: 100,
    });
    expect(researchCanslimSaucerPoint("U", changed)).toMatchObject({
      entry: false,
      reason: null,
    });
  }
  const lowVolume = structuredClone(bars);
  lowVolume[160]!.volume = 1;
  expect(researchCanslimSaucerPoint("U", lowVolume)).toMatchObject({
    entry: false,
    reason: null,
  });
  lowVolume[160]!.volume = 0;
  expect(researchCanslimSaucerPoint("U", lowVolume).reason).not.toBeNull();
  expect(
    researchCanslimSaucerPoint("U", bars.slice(-45)).reason,
  ).not.toBeNull();
});

it.each(["canslim-saucer-u-hold3", "canslim-saucer-w-hold3"] as const)(
  "%s confirms only after three aligned lows hold the original pivot",
  (id) => {
    const bars = fixture(canslimSaucerShape(id));
    const calendar = bars.map((b) => b.date);
    const run = (input = bars) =>
      researchRuleSeries(
        id,
        input,
        calendar,
        undefined,
        undefined,
        researchFormulaRuntime,
      );
    expect(
      run()
        .filter((p) => p.entry)
        .map((p) => p.date),
    ).toEqual([bars[163]!.date]);
    expect(run(bars.slice(0, 163)).some((p) => p.entry)).toBe(false);
    expect(run(bars.filter((_, i) => i !== 162)).some((p) => p.entry)).toBe(
      false,
    );
    bars[162]!.low = 99.99;
    expect(run().some((p) => p.entry)).toBe(false);
    bars[162]!.low = 100;
    expect(run()[163]!.entry).toBe(true);
  },
);
