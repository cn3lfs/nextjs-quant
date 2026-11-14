import { researchFormulaRuntime } from "~/lib/research/technical/research-formula-runtime";
import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { researchRuleSeries } from "trading-strategies/research/composition/research-rule-series";

function fixture(confirm = 72): Bar[] {
  return Array.from({ length: 80 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: i >= 70 ? 102 : 97,
    high: i >= 69 ? 103 : 100,
    low: i >= 70 ? 101 : 95,
    close: i >= 69 ? 102 : 97,
    volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : i === confirm ? 100 : 20,
    amount: 1000000,
  }));
}
const ids = [
  "canslim-priority-volume-wait3",
  "canslim-priority-volume-wait5",
] as const;

it.each(ids)(
  "%s freezes the original pivot and confirms only within the explicit calendar deadline",
  (id) => {
    const max = id.endsWith("3") ? 3 : 5;
    for (const elapsed of [1, max, max + 1]) {
      const bars = fixture(69 + elapsed);
      const points = researchRuleSeries(
        id,
        bars,
        undefined,
        undefined,
        undefined,
        researchFormulaRuntime,
      );
      expect(points[69]).toMatchObject({
        entry: false,
        volumeWait: {
          status: "waiting",
          breakoutDate: bars[69]!.date,
          pivot: 100,
          initialVolume20: 40,
        },
      });
      expect(points.filter((p) => p.entry).map((p) => p.date)).toEqual(
        elapsed <= max ? [bars[69 + elapsed]!.date] : [],
      );
      if (elapsed <= max)
        expect(points[69 + elapsed]).toMatchObject({
          candidate: { family: "flat", high: 100 },
          historyStart: bars[0]!.date,
          volumeWait: {
            status: "confirmed",
            confirmationDate: bars[69 + elapsed]!.date,
            elapsed,
          },
        });
      else
        expect(points[69 + max]).toMatchObject({
          volumeWait: { status: "expired" },
        });
      expect(
        researchRuleSeries(
          id,
          bars.slice(0, 70 + elapsed),
          undefined,
          undefined,
          undefined,
          researchFormulaRuntime,
        ),
      ).toEqual(points.slice(0, 70 + elapsed));
    }
  },
);

it("uses strict initial volume below one mean and inclusive confirmation at 1.5 means", () => {
  for (const volume of [39.99, 40, 50, 60]) {
    const bars = fixture(70);
    bars[69]!.volume = volume;
    const average = bars
      .slice(50, 70)
      .reduce((sum, b) => sum + b.volume / 20, 0);
    bars[70]!.volume = average * 1.5;
    const points = researchRuleSeries(
      ids[0],
      bars,
      undefined,
      undefined,
      undefined,
      researchFormulaRuntime,
    );
    expect(points.some((p) => p.entry)).toBe(volume < 40);
    if (volume < 40) {
      expect(points[70]!.entry).toBe(true);
      bars[70]!.volume -= 0.0001;
      expect(
        researchRuleSeries(
          ids[0],
          bars,
          undefined,
          undefined,
          undefined,
          researchFormulaRuntime,
        )[70]!.entry,
      ).toBe(false);
    }
  }
});

it("cancels close breaches, chase, missing days and invalid bars without replacing the pending shape", () => {
  for (const patch of [
    { low: 98, close: 99 },
    { high: 107, close: 106 },
    { volume: 0 },
  ]) {
    const bars = fixture(72);
    Object.assign(bars[70]!, patch);
    const points = researchRuleSeries(
      ids[0],
      bars,
      undefined,
      undefined,
      undefined,
      researchFormulaRuntime,
    );
    expect(points[70]).toMatchObject({
      entry: false,
      volumeWait: { status: "cancelled", pivot: 100 },
    });
    expect(points.some((p) => p.entry)).toBe(false);
  }
  const bars = fixture(72),
    calendar = bars.map((b) => b.date);
  const points = researchRuleSeries(
    ids[0],
    bars.filter((_, i) => i !== 70),
    calendar,
    undefined,
    undefined,
    researchFormulaRuntime,
  );
  expect(points.find((p) => p.date === bars[71]!.date)).toMatchObject({
    volumeWait: { status: "cancelled" },
  });
  expect(points.some((p) => p.entry)).toBe(false);
});

it("allows intraday pivot touches and close equality while waiting, but confirmation must exceed 101 percent", () => {
  const bars = fixture(72);
  Object.assign(bars[70]!, { low: 99, close: 100 });
  Object.assign(bars[71]!, { close: 101, volume: 100 });
  const points = researchRuleSeries(
    ids[0],
    bars,
    undefined,
    undefined,
    undefined,
    researchFormulaRuntime,
  );
  expect(points[70]).toMatchObject({
    entry: false,
    volumeWait: { status: "waiting" },
  });
  expect(points[71]).toMatchObject({
    entry: false,
    volumeWait: { status: "waiting" },
  });
  expect(points[72]).toMatchObject({
    entry: true,
    volumeWait: {
      breakoutDate: bars[69]!.date,
      confirmationDate: bars[72]!.date,
    },
  });
});
