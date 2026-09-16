import { expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  adjustedVolumeBar,
  chipFractions,
  volumeProfileBands,
  volumePeriodGate,
  researchVolumeAdaptedSeries,
  type VolumeAdaptedEvidence,
  type VolumeAdaptedId,
} from "../src/lib/research-volume-adapted";
function fixture(n = 65) {
  const b: Bar[] = Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: 9.9,
    close: 10,
    high: 10.1,
    low: 9.8,
    volume: 1e6,
    amount: 1e7,
  }));
  b[n - 1] = {
    ...b[n - 1]!,
    open: 10,
    low: 10,
    high: 10.7,
    close: 10.6,
    volume: 2e6,
    amount: 2e7,
  };
  const e: VolumeAdaptedEvidence[] = b.map((v) => ({
    date: v.date,
    availableDate: v.date,
    source: "fixed historical fixture",
    amount: { unit: "CNY", scope: "exchange" },
    adjustment: {
      priceFactor: 1,
      volumeFactor: 1,
      cashOffset: 0,
      basis: "historical-origin",
      complete: true,
    },
    instrument: {
      kind: "stock",
      board: "chinext",
      settlement: "T+1",
      identitySource: "historical listing",
    },
    floatShares: 5e7,
    volumeUnit: "shares",
    chips: {
      method: "point-in-time-fixture",
      adjustment: "raw",
      start: b[0]!.date,
      end: v.date,
      bins: [
        { price: 9, fraction: 0.8 },
        { price: 11, fraction: 0.2 },
      ],
    },
    money: {
      algorithm: "vendor-v1",
      currency: "CNY",
      large: 100,
      extraLarge: 200,
    },
  }));
  return { b, e, i: n - 1 };
}
it.each([
  "vp-basis-amount",
  "vp-basis-adjusted",
  "vp-board-volume18",
  "vp-board-price3",
  "vp-board-price4",
  "vp-small-turnover",
  "vp-chip-overhang",
  "vp-money-confirm",
  "vp-float-segment",
] as const)("%s has positive, rejected-price and missing-input paths", (id) => {
  const { b, e, i } = fixture();
  expect(researchVolumeAdaptedSeries(id, b, e)[i]).toMatchObject({
    entry: true,
    reason: null,
  });
  const original = b[i]!.close;
  b[i]!.close = 10;
  expect(researchVolumeAdaptedSeries(id, b, e)[i]!.entry).toBe(false);
  b[i]!.close = original;
  expect(researchVolumeAdaptedSeries(id, b, [])[i]!.entry).toBe(false);
  expect(researchVolumeAdaptedSeries(id, b, [])[i]!.reason).not.toBeNull();
});
it("amount never averages raw volume or mixes scopes/units", () => {
  const { b, e, i } = fixture();
  b[i]!.amount = 1e7;
  b[i]!.volume = 1e9;
  expect(researchVolumeAdaptedSeries("vp-basis-amount", b, e)[i]!.entry).toBe(
    false,
  );
  b[i]!.amount = 1.5e7;
  expect(researchVolumeAdaptedSeries("vp-basis-amount", b, e)[i]!.entry).toBe(
    true,
  );
  e[i - 1]!.amount!.scope = "other";
  expect(
    researchVolumeAdaptedSeries("vp-basis-amount", b, e)[i]!.reason,
  ).toContain("scope");
});
it("split transforms prices and volumes inversely; cash dividends leave volume unchanged", () => {
  const { b } = fixture();
  const bar = b[0]!;
  const split = adjustedVolumeBar(bar, {
    priceFactor: 2,
    volumeFactor: 0.5,
    cashOffset: 0,
    basis: "original",
    complete: true,
  })!;
  expect(split.close).toBe(20);
  expect(split.volume).toBe(5e5);
  const cash = adjustedVolumeBar(bar, {
    priceFactor: 1,
    volumeFactor: 1,
    cashOffset: 1,
    basis: "original",
    complete: true,
  })!;
  expect(cash.close).toBe(11);
  expect(cash.volume).toBe(bar.volume);
  expect(
    adjustedVolumeBar(bar, {
      priceFactor: 2,
      volumeFactor: 1,
      cashOffset: 0,
      basis: "wrong",
      complete: true,
    }),
  ).toBeNull();
});
it("volume and price thresholds stay independent, with strict price equality", () => {
  const { b, e, i } = fixture();
  b[i]!.volume = 1.8e6;
  b[i]!.close = 10.3;
  expect(researchVolumeAdaptedSeries("vp-board-volume18", b, e)[i]!.entry).toBe(
    true,
  );
  expect(researchVolumeAdaptedSeries("vp-board-price3", b, e)[i]!.entry).toBe(
    false,
  );
  b[i]!.close = 10.4;
  expect(researchVolumeAdaptedSeries("vp-board-price4", b, e)[i]!.entry).toBe(
    false,
  );
  e[i]!.instrument!.board = "beijing";
  expect(
    researchVolumeAdaptedSeries("vp-board-volume18", b, e)[i]!.reason,
  ).toContain("不适用");
});
it("ETF 1.3 threshold requires historical domestic stock-ETF T+1 identity", () => {
  const { b, e, i } = fixture();
  e[i]!.instrument!.kind = "stock-etf";
  b[i]!.volume = 1.3e6;
  expect(researchVolumeAdaptedSeries("vp-etf-volume13", b, e)[i]!.entry).toBe(
    true,
  );
  b[i]!.volume = 1.299e6;
  expect(researchVolumeAdaptedSeries("vp-etf-volume13", b, e)[i]!.entry).toBe(
    false,
  );
  e[i]!.instrument!.settlement = "T+0";
  expect(
    researchVolumeAdaptedSeries("vp-etf-volume13", b, e)[i]!.reason,
  ).toContain("T+0");
});
it("float changes require a fresh full segment and turnover uses share units", () => {
  const { b, e, i } = fixture();
  e[i]!.floatShares = 1e8;
  expect(
    researchVolumeAdaptedSeries("vp-float-segment", b, e)[i]!.reason,
  ).toContain("新段");
  e[i]!.floatShares = 5e7;
  e[i]!.volumeUnit = "hands";
  expect(researchVolumeAdaptedSeries("vp-small-turnover", b, e)[i]!.entry).toBe(
    false,
  );
});
it("chip mass and algorithm evidence are required, money signs are separate", () => {
  const { b, e, i } = fixture();
  expect(chipFractions(e[i]!.chips, b[i]!.date, 10.6)).toEqual({
    overhang: 0.2,
    profit: 0.8,
  });
  e[i]!.chips!.bins[0]!.fraction = 0.5;
  expect(chipFractions(e[i]!.chips, b[i]!.date, 10.6)).toBeNull();
  e[i]!.money!.extraLarge = 0;
  expect(researchVolumeAdaptedSeries("vp-money-confirm", b, e)[i]!.entry).toBe(
    false,
  );
  e[i]!.money!.extraLarge = -10;
  e[i]!.money!.large = -20;
  expect(researchVolumeAdaptedSeries("vp-money-confirm", b, e)[i]!.exit).toBe(
    true,
  );
});
it("profile conserves volume, handles flat bars, uses historical HVN and rejects insufficient data", () => {
  const { b, i } = fixture();
  const window = b.slice(i - 20, i);
  const p = volumeProfileBands(window)!;
  expect(p.bins.reduce((s, v) => s + v.volume, 0)).toBeCloseTo(20e6, 5);
  expect(volumeProfileBands(window.slice(1))).toBeNull();
  for (let j = i - 20; j < i; j++)
    b[j] = { ...b[j]!, open: 10, low: 10, high: 10, close: 10 };
  b[i - 20]!.high = 10.12;
  b[i - 20]!.low = 9.88;
  expect(researchVolumeAdaptedSeries("vp-profile-edge", b)[i]!.entry).toBe(
    true,
  );
  b[i]!.close = 9.9;
  b[i]!.low = 9.8;
  expect(researchVolumeAdaptedSeries("vp-profile-edge", b)[i]!.exit).toBe(true);
});
it("high acceleration waits for both continued new highs and seven complete non-distribution facts", () => {
  const { b, e, i } = fixture();
  b[i - 1] = { ...b[i - 1]!, open: 15, close: 16, high: 16.1, low: 14.9 };
  b[i] = { ...b[i]!, open: 16, close: 17, high: 17.1, low: 16 };
  e[i]!.distribution = {
    complete: true,
    price: false,
    volume: false,
    intraday: false,
    chips: false,
    news: false,
    duration: false,
    recovery: false,
  };
  expect(
    researchVolumeAdaptedSeries("vp-high-accelerate", b, e)[i]!.entry,
  ).toBe(true);
  e[i]!.distribution!.chips = true;
  expect(
    researchVolumeAdaptedSeries("vp-high-accelerate", b, e)[i],
  ).toMatchObject({ entry: false, exit: true });
  delete e[i]!.distribution;
  expect(
    researchVolumeAdaptedSeries("vp-high-accelerate", b, e)[i]!.reason,
  ).toContain("七维");
});
it("multi-period adapter enforces A-share completed hour slots and excludes the developing week", () => {
  const { b, e, i } = fixture();
  let day = new Date(Date.UTC(2021, 11, 1));
  for (let j = 0; j < b.length; j++) {
    while ([0, 6].includes(day.getUTCDay()))
      day.setUTCDate(day.getUTCDate() + 1);
    const date = day.toISOString().slice(0, 10);
    b[j] = {
      ...b[j]!,
      date,
      open: 10 + j,
      close: 11 + j,
      high: 12 + j,
      low: 9 + j,
    };
    e[j] = { ...e[j]!, date, availableDate: date };
    day.setUTCDate(day.getUTCDate() + 1);
  }
  const date = b[i]!.date;
  const week = Array.from({ length: 21 }, (_, j) => ({
    ...b[j]!,
    date: new Date(Date.UTC(2021, 9, 8 + j * 7)).toISOString().slice(0, 10),
  }));
  const slots = b
    .slice(-3)
    .flatMap((v) =>
      ["10:30", "11:30", "14:00", "15:00"].map(
        (t) => `${v.date}T${t}:00+08:00`,
      ),
    )
    .slice(-11);
  const hour = slots.map((date, j) => {
    const close = j === 10 ? 20 : 10;
    return {
      ...b[j]!,
      date,
      open: close,
      close,
      high: close + 1,
      low: close - 1,
    };
  });
  e[i]!.periods = {
    complete: true,
    calendarSource: "complete fixture",
    observedAt: `${date}T15:00:00+08:00`,
    weekEnd: week.at(-1)!.date,
    hourEnd: hour.at(-1)!.date,
    week,
    hour,
  };
  expect(volumePeriodGate(b, e[i], date)).toBe(true);
  expect(researchVolumeAdaptedSeries("vp-week-day-hour", b, e)[i]!.entry).toBe(
    true,
  );
  const original = hour[5]!.date;
  hour[5]!.date = hour[5]!.date.replace("11:30", "11:00");
  // Choose a definitely invalid start-labelled hour regardless of this slot's label.
  hour[5]!.date = hour[5]!.date.slice(0, 10) + "T09:00:00+08:00";
  expect(volumePeriodGate(b, e[i], date)).toBeNull();
  hour[5]!.date = original;
  const last = week.at(-1)!;
  const lastDate = last.date;
  last.date = date;
  e[i]!.periods!.weekEnd = date;
  expect(volumePeriodGate(b, e[i], date)).toBeNull();
  last.date = lastDate;
  e[i]!.periods!.weekEnd = "2099-01-01";
  expect(volumePeriodGate(b, e[i], date)).toBeNull();
});
