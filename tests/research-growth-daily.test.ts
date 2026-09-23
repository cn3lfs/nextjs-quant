import { expect, it } from "vitest";
import {
  growthDailyIds,
  growthDailyTemplate,
  growthDailyBase,
  growthVolumeReduction,
  growthDistributionReduction,
  growthAddConfirmation,
  type GrowthDailyId,
} from "../src/lib/research-growth-daily";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchManagementSchema } from "../src/lib/research-management";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import { applyResearchManagement } from "../src/components/research/research-strategy-fields";
function setup(id: GrowthDailyId) {
  const bars = Array.from({ length: 50 }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    close: 100,
    high: 140,
    low: 80,
    volume: 1000,
    amount: 100000,
  }));
  const calendar = bars.map((b) => b.date),
    market = structuredClone(bars);
  const spec = researchSpecSchema.parse({
    strategy: growthDailyBase(id),
    start: bars[22]!.date,
    end: bars[49]!.date,
    validationStart: bars[49]!.date,
    holdingDays: 60,
    initialCapital: 1000000,
    maxPositions: 5,
    risk: { fraction: 0.015, maxWeight: 0.25 },
    management: growthDailyTemplate(id),
    costs: {
      slippageBps: 0,
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
    },
  });
  const event: ResearchEvent = {
    symbol: "sh600000",
    observedDate: bars[22]!.date,
    endpointDate: bars[22]!.date,
    key: "synthetic",
    strategyVersion: "fixture",
    partition: "development",
    evidence: "synthetic confirmed shape for execution",
    entryPriceRange: { min: 98, max: 102.9 },
  };
  const rules = {
    evidence: "fixture",
    tradable: true,
    limitUp: null,
    limitDown: null,
    minimumBuy: 100,
    buyStep: 100,
    maximumOrder: 100000,
    minimumSell: 100,
    sellStep: 100,
    maximumSell: 100000,
    sellOddLotAll: true,
  };
  const run = (events = [event]) =>
    researchPortfolio(
      spec,
      events,
      calendar,
      new Map([[event.symbol, bars]]),
      () => rules,
      undefined,
      undefined,
      { symbol: "sh000300", bars: market },
    );
  return { bars, calendar, market, spec, event, run };
}
it.each(growthDailyIds)(
  "named independent configuration %s is selectable and versioned",
  (id) => {
    const f = setup(id);
    expect(researchManagementSchema.parse(f.spec.management)).toEqual(
      f.spec.management,
    );
    expect(researchMethodSnapshot(f.spec).growthDaily?.id).toBe(id);
    const selected = applyResearchManagement(
      { ...f.spec, strategy: "dual-breakout" },
      growthDailyTemplate(id),
    );
    expect(researchSpecSchema.parse(selected).strategy).toBe(
      growthDailyBase(id),
    );
    expect(selected.risk).toEqual(
      id === "SE-P-standard"
        ? { fraction: 0.02, maxWeight: 0.3 }
        : { fraction: 0.015, maxWeight: 0.25 },
    );
    expect(selected.maxPositions).toBe(id === "SE-P-standard" ? 8 : 5);
    expect(
      researchSpecSchema.safeParse({ ...selected, maxPositions: 9 }).success,
    ).toBe(false);
  },
);
it("review at 14 days records lack of progress, only broken frozen pivot exits", () => {
  const f = setup("SE-D-review23");
  let t = f.run().trades[0]!;
  expect(t.growthReviews).toEqual([
    { date: f.bars[37]!.date, days: 14, gain: 0, pivot: 98, invalid: false },
    { date: f.bars[44]!.date, days: 21, gain: 0, pivot: 98, invalid: false },
  ]);
  f.bars[37]!.close = 97;
  t = f.run().trades[0]!;
  expect(t.exitDate).toBe(f.bars[38]!.date);
  expect(t.exitReason).toContain("14天复核");
});
it("target distance gates remain independently executable and retain exact boundaries", () => {
  for (const id of ["SE-D-targets", "CA-E-reward25"] as const) {
    const f = setup(id);
    expect(f.run().trades).toHaveLength(1);
    f.spec.management!.stop = {
      kind: "percent",
      fraction: id.startsWith("SE-") ? 0.10001 : 0.08001,
    };
    expect(f.run().trades).toEqual([]);
    expect(f.run().excluded[0]!.reason).toContain("初始止损距离超过");
  }
});
it("20/30 sells initial thirds and raises only after fills", () => {
  const f = setup("SE-D-partial2030");
  f.bars[24]!.close = 120;
  f.bars[25]!.close = 120;
  f.bars[26]!.close = 130;
  const t = f.run().trades[0]!;
  expect(t.quantity).toBe(1500);
  expect(t.sales!.slice(0, 2).map((s) => s.quantity)).toEqual([500, 500]);
  expect(
    t.stopHistory!.some((s) => s.date === f.bars[25]!.date && s.stop === 100),
  ).toBe(true);
  expect(
    t.stopHistory!.some((s) => s.date === f.bars[27]!.date && s.stop === 120),
  ).toBe(true);
});
it("volume reduction is strict and resets only after the condition clears", () => {
  const f = setup("CA-D-volume-sell");
  f.bars[24]!.close = 99;
  f.bars[24]!.volume = 1500;
  expect(growthVolumeReduction(f.bars, f.calendar, f.bars[24]!.date)).toBe(
    false,
  );
  f.bars[24]!.volume = 1501;
  expect(growthVolumeReduction(f.bars, f.calendar, f.bars[24]!.date)).toBe(
    true,
  );
  expect(f.run().trades[0]!.sales![0]).toMatchObject({
    date: f.bars[25]!.date,
    quantity: 900,
  });
  const missing = f.bars.filter((_, i) => i !== 23);
  expect(
    growthVolumeReduction(missing, f.calendar, f.bars[24]!.date),
  ).toBeNull();
});
it("five consecutive distribution days act on day five only; missing dates cannot be counted", () => {
  const f = setup("CA-D-distribution5");
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
  const r = f.run();
  expect(r.trades[0]!.sales).toHaveLength(1);
  expect(r.trades[0]!.sales![0]).toMatchObject({
    date: f.bars[29]!.date,
    quantity: 900,
  });
  expect(
    growthDistributionReduction(
      f.market.filter((_, i) => i !== 26),
      f.calendar,
      f.bars[28]!.date,
    ),
  ).toBeNull();
});
it("full sizing buys the whole risk target; half entry adds once with price/volume/market confirmation", () => {
  const full = setup("CA-P-full");
  expect(full.run().trades[0]!.quantity).toBe(1800);
  const f = setup("CA-P-add23");
  f.bars[24]!.close = 102.5;
  f.bars[24]!.volume = 1500;
  f.bars[25]!.open = 102.5;
  expect(
    growthAddConfirmation(f.bars, f.market, f.calendar, f.bars[24]!.date, 100),
  ).toBe(true);
  const t = f.run().trades[0]!;
  expect(t.entries!.map((e) => e.quantity)).toEqual([900, 900]);
  expect(t.book!.totalQuantity).toBe(1800);
  f.market[24]!.close = 102;
  expect(
    growthAddConfirmation(f.bars, f.market, f.calendar, f.bars[24]!.date, 100),
  ).toBe(false);
  expect(f.run().trades[0]!.entries).toHaveLength(1);
  f.market[24]!.close = 100;
  f.bars[25]!.open = 103.1;
  expect(f.run().trades[0]!.entries).toHaveLength(1);
});
it("same-symbol stop cooling excludes the next three dates, accepts a fresh day-four entry", () => {
  const f = setup("CA-E-cooldown");
  f.bars[24]!.close = 90;
  const events = [
    f.event,
    ...[25, 26, 27, 28].map((i) => ({
      ...f.event,
      key: `event-${i}`,
      observedDate: f.bars[i]!.date,
      endpointDate: f.bars[i]!.date,
    })),
  ];
  const r = f.run(events);
  expect(r.trades.map((t) => t.entryDate)).toEqual([
    f.bars[23]!.date,
    f.bars[29]!.date,
  ]);
  expect(r.excluded.filter((e) => e.reason.includes("冷静期"))).toHaveLength(3);
});
