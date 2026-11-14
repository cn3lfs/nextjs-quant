import { expect, it } from "vitest";
import {
  growthVolumeReduction,
  growthDistributionReduction,
  growthAddConfirmation,
} from "trading-strategies/research/factors/research-growth-daily";

function input() {
  const bars = Array.from({ length: 50 }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    close: 100,
    high: 140,
    low: 80,
    volume: 1000,
    amount: 100000,
  }));
  return {
    bars,
    calendar: bars.map((b) => b.date),
    market: structuredClone(bars),
  };
}

it("volume reduction requires strictly greater volume and complete history", () => {
  const f = input();
  f.bars[24]!.close = 99;
  f.bars[24]!.volume = 1500;
  expect(growthVolumeReduction(f.bars, f.calendar, f.bars[24]!.date)).toBe(
    false,
  );
  f.bars[24]!.volume = 1501;
  expect(growthVolumeReduction(f.bars, f.calendar, f.bars[24]!.date)).toBe(
    true,
  );
  expect(
    growthVolumeReduction(
      f.bars.filter((_, i) => i !== 23),
      f.calendar,
      f.bars[24]!.date,
    ),
  ).toBeNull();
});

it("distribution reduction confirms on day five without bridging missing dates", () => {
  const f = input();
  for (let i = 24; i <= 30; i++) {
    f.market[i]!.close = f.market[i - 1]!.close * 0.997;
    f.market[i]!.volume = f.market[i - 1]!.volume + 100;
  }
  expect(
    growthDistributionReduction(f.market, f.calendar, f.bars[27]!.date),
  ).toBe(false);
  expect(
    growthDistributionReduction(f.market, f.calendar, f.bars[28]!.date),
  ).toBe(true);
  expect(
    growthDistributionReduction(f.market, f.calendar, f.bars[29]!.date),
  ).toBe(false);
  expect(
    growthDistributionReduction(
      f.market.filter((_, i) => i !== 26),
      f.calendar,
      f.bars[28]!.date,
    ),
  ).toBeNull();
});

it("addition confirmation requires price, volume and market agreement", () => {
  const f = input();
  f.bars[24]!.close = 102.5;
  f.bars[24]!.volume = 1500;
  expect(
    growthAddConfirmation(f.bars, f.market, f.calendar, f.bars[24]!.date, 100),
  ).toBe(true);
  f.market[24]!.close = 102;
  expect(
    growthAddConfirmation(f.bars, f.market, f.calendar, f.bars[24]!.date, 100),
  ).toBe(false);
});
