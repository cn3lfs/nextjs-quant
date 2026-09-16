import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  researchVolumeIntradaySeries,
  volumeIntradayFacts,
  volumeIntradayIds,
  type VolumeIntradayEvidence,
} from "../src/lib/research-volume-intraday";
const bars = (): Bar[] =>
  Array.from({ length: 25 }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    close: 100,
    high: 101,
    low: 99,
    volume: 1000,
    amount: 100000,
  }));
function snapshot(input: Bar[]): VolumeIntradayEvidence {
  const date = input.at(-1)!.date;
  return {
    date,
    availableDate: date,
    source: "minute-fixture",
    volume: 1312.5,
    elapsedMinutes: 210,
    sessionMinutes: 240,
    volumeUnit: "share",
    prior5DailyVolumes: input.slice(-6, -1).map((b) => b.volume),
    priorDates: input.slice(-6, -1).map((b) => b.date),
    observedAt: `${date}T14:30:00+08:00`,
    availableAt: `${date}T14:30:00+08:00`,
    price: 102,
  };
}
it("reports the source's five distinct bands, projection units and early-session warning", () => {
  const input = bars(),
    e = snapshot(input);
  for (const [ratio, band] of [
    [0.79, "contracted"],
    [0.8, "normal"],
    [1.5, "active"],
    [2.5, "unusual"],
    [5, "unusual"],
    [5.01, "extreme"],
  ] as const) {
    const facts = volumeIntradayFacts({ ...e, volume: ratio * 875 }, e.date)!;
    expect(facts.ratio).toBeCloseTo(ratio);
    expect(facts.band).toBe(band);
    expect(facts.projectedVolume).toBeCloseTo(ratio * 1000);
  }
  expect(
    volumeIntradayFacts({ ...e, elapsedMinutes: 30 }, e.date)!.openingWarning,
  ).toBe(true);
});
it.each(volumeIntradayIds)(
  "%s uses the fixed snapshot rather than final-day volume",
  (id) => {
    const input = bars(),
      e = snapshot(input);
    expect(researchVolumeIntradaySeries(id, input, [e]).at(-1)).toMatchObject({
      entry: true,
      values: { ratio: 1.5, projectedVolume: 1500 },
    });
    input.at(-1)!.volume = 100000;
    expect(researchVolumeIntradaySeries(id, input, [e]).at(-1)!.entry).toBe(
      true,
    );
    expect(
      researchVolumeIntradaySeries(id, input, [{ ...e, volume: 1312 }]).at(-1)!
        .entry,
    ).toBe(false);
    expect(
      researchVolumeIntradaySeries(id, input, [{ ...e, price: 101 }]).at(-1)!
        .entry,
    ).toBe(false);
    expect(
      researchVolumeIntradaySeries(id, input, [{ ...e, volume: 4375 }]).at(-1)!
        .entry,
    ).toBe(true);
    expect(
      researchVolumeIntradaySeries(id, input, [{ ...e, volume: 4376 }]).at(-1)!
        .entry,
    ).toBe(false);
  },
);
it("rejects late snapshots, mismatched previous sessions, duplicate inputs and post-2022 history", () => {
  const input = bars(),
    e = snapshot(input);
  for (const proof of [
    [],
    [e, e],
    [{ ...e, availableAt: `${e.date}T14:31:00+08:00` }],
    [{ ...e, priorDates: e.priorDates.map(() => "2022-01-01") }],
    [{ ...e, prior5DailyVolumes: [100, 100, 100, 100, 100] }],
    [{ ...e, elapsedMinutes: 30 }],
  ])
    expect(
      researchVolumeIntradaySeries("vp-intraday-rate", input, proof).at(-1),
    ).toMatchObject({
      entry: false,
      reason: expect.stringContaining("待数据"),
    });
  expect(
    volumeIntradayFacts(
      { ...e, date: "2023-01-01", availableDate: "2023-01-01" },
      "2023-01-01",
    ),
  ).toBeNull();
});
