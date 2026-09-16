import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import { researchCanslimVolumeTier } from "../src/server/research-canslim-volume-tier";
import { researchSignals } from "../src/server/research-signals";
import { researchSpecSchema } from "../src/lib/strategy-research";
const fixture = (): Bar[] =>
  Array.from({ length: 90 }, (_, i) => ({
    date: new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    high: 110,
    low: 80,
    close: 100,
    volume: 100,
    amount: 10000,
  }));
it.each([
  [119.99, 0],
  [120, 3],
  [150, 6],
  [199.99, 6],
  [200, 8],
])("scores volume %s as %s without overlap", (volume, points) => {
  const bars = fixture();
  bars[70]!.volume = volume!;
  const series = researchCanslimVolumeTier(
    "canslim-volume-tier",
    bars,
    bars.map((b) => b.date),
  );
  expect(series[70]!.diagnostic.points).toBe(points);
  expect(series[70]!.entry).toBe(points === 8);
  expect(series[70]!.diagnostic.mean20).toBe(100);
});
it.each(["canslim-volume-tier", "canslim-volume-tier-crash"] as const)(
  "%s confirms next-open intent and is prefix stable",
  async (id) => {
    const bars = fixture();
    bars[70]!.volume = 200;
    const calendar = bars.map((b) => b.date),
      market = {
        symbol: "sh000300",
        source: "fixture",
        hash: "fixture",
        bars: fixture(),
      };
    const full = researchCanslimVolumeTier(id, bars, calendar, market);
    expect(full.filter((p) => p.entry).map((p) => p.date)).toEqual([
      bars[70]!.date,
    ]);
    expect(
      researchCanslimVolumeTier(id, bars.slice(0, 71), calendar.slice(0, 71), {
        ...market,
        bars: market.bars.slice(0, 71),
      }),
    ).toEqual(full.slice(0, 71));
    const spec = researchSpecSchema.parse({
      strategy: id,
      symbols: ["sh600000"],
      start: bars[65]!.date,
      end: bars[89]!.date,
      validationStart: bars[85]!.date,
      holdingDays: 2,
    });
    const events = await researchSignals(
      "sh600000",
      bars,
      spec,
      async () => {
        throw Error("native");
      },
      () => false,
      () => {},
      calendar,
      market,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.observedDate).toBe(bars[70]!.date);
    expect(events[0]!.entryPriceRange).toBeUndefined();
    for (const field of ["volume", "low"] as const) {
      const bad = structuredClone(bars);
      bad[70]![field] = 0;
      expect(
        researchCanslimVolumeTier(id, bad, calendar, market)[70],
      ).toMatchObject({ entry: false, diagnostic: { points: null } });
    }
    expect(
      researchCanslimVolumeTier(
        id,
        bars.filter((_, i) => i !== 69),
        calendar,
        market,
      ).find((p) => p.date === bars[70]!.date),
    ).toMatchObject({ entry: false, diagnostic: { points: null } });
  },
);
it("excludes only recent crash/decline/volume conjunction, keeps denominator and never backfills", () => {
  const bars = fixture(),
    index = fixture();
  bars[70]!.volume = 200;
  bars[70]!.close = 99;
  index[70]!.close = 97;
  const calendar = bars.map((b) => b.date),
    market = {
      symbol: "sh000300",
      source: "fixture",
      hash: "fixture",
      bars: index,
    };
  const result = researchCanslimVolumeTier(
    "canslim-volume-tier-crash",
    bars,
    calendar,
    market,
  );
  expect(result[70]).toMatchObject({
    entry: false,
    diagnostic: { points: 0, mean20: 100, excludedDates: [bars[70]!.date] },
  });
  index[70]!.close = 97.001;
  expect(
    researchCanslimVolumeTier(
      "canslim-volume-tier-crash",
      bars,
      calendar,
      market,
    )[70]!.entry,
  ).toBe(true);
  expect(
    researchCanslimVolumeTier("canslim-volume-tier-crash", bars, calendar)[70]!
      .diagnostic.points,
  ).toBeNull();
  index[70]!.close = 97;
  bars[70]!.close = 100;
  expect(
    researchCanslimVolumeTier(
      "canslim-volume-tier-crash",
      bars,
      calendar,
      market,
    )[70]!.entry,
  ).toBe(true);
  const missing = { ...market, bars: index.filter((_, i) => i !== 69) };
  expect(
    researchCanslimVolumeTier(
      "canslim-volume-tier-crash",
      bars,
      calendar,
      missing,
    )[70]!.diagnostic.points,
  ).toBeNull();
});
