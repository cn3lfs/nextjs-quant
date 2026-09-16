import type { Bar } from "../src/lib/domain";
import { expect, it } from "vitest";
import {
  growthIntradayIds,
  growthIntradayTemplate,
  growthIntradayBase,
  type GrowthIntradayId,
} from "../src/lib/research-growth-intraday";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchManagementSchema } from "../src/lib/research-management";
import {
  growthMinuteTimes,
  growthMinuteDay,
  growthIntradayEntries,
  researchGrowthIntraday,
} from "../src/server/research-growth-intraday";
import { researchPortfolio } from "../src/server/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research-method";
import { applyResearchManagement } from "../src/components/research-strategy-fields";

function setup(id: GrowthIntradayId) {
  const bars = Array.from({ length: 6 }, (_, i) => ({
    date: `2022-11-${21 + i}`,
    open: 100,
    high: 110,
    low: 80,
    close: 100,
    volume: 4800,
    amount: 480000,
  }));
  const minutes = bars.flatMap((b) =>
    growthMinuteTimes.map((time) => ({
      ...b,
      date: `${b.date}T${time}:00+08:00`,
      high: 101,
      low: 99,
      volume: 100,
      amount: 10000,
    })),
  );
  const spec = researchSpecSchema.parse({
    strategy: growthIntradayBase(id),
    start: bars[0]!.date,
    end: bars[5]!.date,
    validationStart: bars[5]!.date,
    holdingDays: 60,
    initialCapital: 100000,
    maxPositions: 1,
    risk: { fraction: 0.1, maxWeight: 1 },
    management: growthIntradayTemplate(id),
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const rules = {
    evidence: "synthetic fixed input",
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
  const event: ResearchEvent = {
    symbol: "sh600000",
    observedDate: bars[0]!.date,
    endpointDate: bars[0]!.date,
    key: "synthetic confirmed shape",
    strategyVersion: "fixture",
    partition: "development",
    evidence: "Synthetic execution input, not a shape detection test",
  };
  const calendar = bars.map((b) => b.date),
    daily = new Map([[event.symbol, bars]]);
  const run = (rule = () => rules) =>
    researchGrowthIntraday(
      spec,
      [event],
      calendar,
      daily,
      new Map([[event.symbol, minutes]]),
      rule,
      researchPortfolio(spec, [], calendar, daily, rule),
    );
  return { bars, minutes, spec, rules, event, run };
}
it.each(growthIntradayIds)(
  "named method is validated, selected, and versioned: %s",
  (id) => {
    const { spec } = setup(id);
    expect(researchManagementSchema.parse(spec.management)).toEqual(
      spec.management,
    );
    expect(researchMethodSnapshot(spec).growthIntraday?.id).toBe(id);
    expect(
      applyResearchManagement(
        { ...spec, strategy: "dual-breakout" },
        spec.management!,
      ).strategy,
    ).toBe(growthIntradayBase(id));
    expect(
      researchSpecSchema.safeParse({ ...spec, end: "2023-01-01" }).success,
    ).toBe(false);
    expect(
      researchManagementSchema.safeParse({
        ...spec.management,
        lossPauseDays: 1,
      }).success,
    ).toBe(false);
  },
);
it("requires the exact 48 right endpoints; rejects gaps, duplicate times and invalid OHLCV", () => {
  const { minutes, bars } = setup("CA-D-review1430");
  const day = minutes.slice(0, 48),
    date = bars[0]!.date;
  expect(growthMinuteDay(day, date)).toHaveLength(48);
  expect(day[41]!.date).toContain("14:30");
  expect(growthMinuteDay(day.slice(1), date)).toBeNull();
  expect(growthMinuteDay([...day.slice(0, 47), day[0]!], date)).toBeNull();
  expect(
    growthMinuteDay(
      day.map((b, i) => (i === 20 ? { ...b, volume: 0 } : b)),
      date,
    ),
  ).toBeNull();
});
it.each(["SE-D-gapup3", "CA-D-gapup3"] as const)(
  "uses daily opening gap, never first five-minute close: %s",
  (id) => {
    const f = setup(id);
    f.bars[2]!.open = 103;
    f.minutes[96]!.close = 104;
    f.minutes[96]!.high = 105;
    expect(f.run().trades[0]!.stopHistory).toHaveLength(1);
    f.bars[2]!.open = 103.01;
    const t = f.run().trades[0]!;
    expect(t.stopHistory![1]).toMatchObject({
      date: "2022-11-23T09:35:00+08:00",
      stop: 100,
    });
    // Later gaps cannot re-run the next-day-only instruction.
    f.bars[2]!.open = 100;
    f.bars[3]!.open = 105;
    expect(f.run().trades[0]!.stopHistory).toHaveLength(1);
  },
);
it.each(["SE-D-gapdown3", "CA-D-gapdown3"] as const)(
  "reduces at 9:35 and later sells at next bar open: %s",
  (id) => {
    const f = setup(id);
    f.bars[2]!.open = 97;
    expect(f.run().trades[0]!.sales).toEqual([]);
    f.bars[2]!.open = 96.9;
    let t = f.run().trades[0]!;
    expect(t.sales![0]).toMatchObject({
      date: "2022-11-23T09:35:00+08:00",
      quantity: 500,
      price: 100,
    });
    f.minutes[98]!.close = 89;
    f.minutes[98]!.low = 88;
    f.minutes[99]!.open = 88;
    f.minutes[99]!.low = 87;
    t = f.run().trades[0]!;
    expect(t.sales![1]).toMatchObject({
      date: "2022-11-23T09:45:00+08:00",
      quantity: 500,
      price: 88,
    });
    expect(t.exitDate).toBe("2022-11-23");
  },
);
it("14:30 uses the 14:25–14:30 close; later recovery does not revoke the next-open order", () => {
  const f = setup("CA-D-review1430"),
    p = f.minutes[96 + 41]!;
  p.close = 98;
  p.low = 97;
  expect(f.run().trades[0]!.sales).toEqual([]);
  p.close = 97.9;
  const t = f.run().trades[0]!;
  expect(t.sales![0]).toMatchObject({
    date: "2022-11-24T09:30:00+08:00",
    quantity: 500,
    triggerDate: "2022-11-23T14:30:00+08:00",
  });
  for (let i = 96 + 42; i < 144; i++)
    Object.assign(f.minutes[i]!, { close: 105, high: 106 });
  expect(f.run().trades[0]!.sales).toEqual(t.sales);
});
it("missing next day is unavailable, not a shifted gap instruction", () => {
  const f = setup("SE-D-gapdown3");
  f.bars[2]!.open = 96;
  f.bars[3]!.open = 96;
  f.minutes.splice(96, 48);
  const r = f.run();
  expect(r.trades[0]!.sales).toEqual([]);
  expect(r.signalGaps).toContainEqual({
    symbol: "sh600000",
    date: "2022-11-23",
    reason: expect.stringContaining("不可用"),
  });
  expect(r.staleValuation).toBe(true);
});
it("blocked sale keeps a fixed target and retries; no sale on acquisition day", () => {
  const f = setup("SE-D-gapdown3");
  f.bars[2]!.open = 96;
  const r = f.run((_s?: string, date?: string) => ({
    ...f.rules,
    tradable: date !== "2022-11-23",
  }));
  expect(r.trades[0]!.sales![0]).toMatchObject({
    date: "2022-11-24T09:30:00+08:00",
    quantity: 500,
  });
  expect(
    r.trades[0]!.sales!.every(
      (s) => s.date.slice(0, 10) > r.trades[0]!.entryDate,
    ),
  ).toBe(true);
});
it("half entry executes after observation, closes confirm next-open addition and per-lot T+1", () => {
  const f = setup("SE-E-intraday50");
  f.event.intradayAt = "2022-11-21T10:00:00+08:00";
  f.event.entryPriceRange = { min: 98, max: 102.9 };
  const r = f.run(),
    t = r.trades[0]!;
  expect(t.entries![0]).toMatchObject({
    date: "2022-11-21T10:00:00+08:00",
    quantity: 500,
  });
  expect(t.entries![1]).toMatchObject({
    date: "2022-11-22T09:30:00+08:00",
    quantity: 500,
  });
  expect(t.book!.lots.map((l) => l.date)).toEqual(["2022-11-21", "2022-11-22"]);
  expect(r.nav[0]!.cash).toBe(50000);
  expect(r.nav[1]!.cash).toBe(0);
  f.minutes[47]!.close = 98;
  f.minutes[47]!.low = 97;
  expect(f.run().trades[0]!.entries).toHaveLength(1);
});

const shapeFixture = (): Bar[] => {
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
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: price,
      close: price,
      high: price,
      low: price,
      volume: i >= 370 ? 200 : i >= 365 ? 10 : i >= 318 ? 40 : 100,
      amount: 10000,
    };
  });
};

it("real VCP plus cumulative intraday volume produces no earlier or future-informed entry", () => {
  const daily = shapeFixture(),
    date = daily[370]!.date;
  const spec = researchSpecSchema.parse({
    strategy: "sepa-vcp-close",
    start: date,
    end: daily[372]!.date,
    validationStart: daily[372]!.date,
    risk: { fraction: 0.015, maxWeight: 0.25 },
    management: growthIntradayTemplate("SE-E-intraday50"),
  });
  const minute = growthMinuteTimes.map((time, i) => ({
    date: `${date}T${time}:00+08:00`,
    open: 116,
    high: 117,
    low: 115,
    close: 116,
    volume: 2,
    amount: 232,
  }));
  const calendar = daily.map((b) => b.date);
  const full = growthIntradayEntries("sh600000", daily, minute, calendar, spec);
  expect(full).toHaveLength(1);
  // Previous 20 whole-day mean: (15*40+5*10)/20=32.5; 1.5*=48.75. First cumulative crossing at bar25 (13:05).
  expect(full[0]!.intradayAt).toBe(`${date}T13:05:00+08:00`);
  expect(full[0]!.entryPriceRange).toEqual({ min: 114, max: 119.7 });
  const changed = structuredClone(daily);
  Object.assign(changed[370]!, { close: 200, high: 200, volume: 999999 });
  expect(
    growthIntradayEntries("sh600000", changed, minute, calendar, spec),
  ).toEqual(full);
  expect(
    growthIntradayEntries(
      "sh600000",
      daily.slice(0, 371),
      minute,
      calendar,
      spec,
    ),
  ).toEqual(full);
  const weak = minute.map((b) => ({ ...b, volume: 0.5 }));
  expect(
    growthIntradayEntries("sh600000", daily, weak, calendar, spec),
  ).toEqual([]);
});

it("lunch observation executes at 13:00, never at 11:30 or a fabricated lunch bar", () => {
  const f = setup("SE-E-intraday50");
  f.event.intradayAt = "2022-11-21T11:30:00+08:00";
  expect(f.run().trades[0]!.entries![0]!.date).toBe(
    "2022-11-21T13:00:00+08:00",
  );
});

it("RK-B-touch uses completed minute lows at equality, not daily lows or an invented same-bar stop fill", () => {
  const f = setup("RK-B-touch");
  expect(f.run().trades[0]!.exitDate).toBeNull(); // all daily lows=80, minutes never touch 95
  f.minutes[96 + 10]!.low = 95;
  f.minutes[96 + 11]!.open = 94;
  f.minutes[96 + 11]!.low = 93;
  const t = f.run().trades[0]!;
  expect(t.sales![0]).toMatchObject({
    date: "2022-11-23T10:25:00+08:00",
    price: 94,
    triggerDate: "2022-11-23T10:25:00+08:00",
  });
});
it("RK-B-touch latches an entry-day touch across T+1 and a 15:00 touch across sessions", () => {
  const f = setup("RK-B-touch");
  f.minutes[48 + 10]!.low = 94;
  expect(f.run().trades[0]!.sales![0]!.date).toBe("2022-11-23T09:30:00+08:00");
  f.minutes[48 + 10]!.low = 99;
  f.minutes[96 + 47]!.low = 95;
  expect(f.run().trades[0]!.sales![0]!.date).toBe("2022-11-24T09:30:00+08:00");
});

it.each(["RK-A-intraday-structure30", "RK-A-intraday-points30"] as const)(
  "%s confirms 30 trading minutes and preserves T+1 pending exit",
  (id) => {
    const f = setup(id);
    f.minutes.forEach((b) => (b.low = 99.8));
    f.minutes[40]!.low = 98.5;
    const result = f.run();
    expect(result.trades[0]!.initialStop).toBe(
      id === "RK-A-intraday-structure30" ? 98.5 : 99.5,
    );
    expect(result.trades[0]!.sales![0]).toMatchObject({
      date: `${f.bars[2]!.date}T09:30:00+08:00`,
      reason: "30交易分钟收盘未达0.5R，时间止损",
    });
    expect(result.trades[0]!.sales![0]!.triggerDate).toBe(
      `${f.bars[1]!.date}T10:00:00+08:00`,
    );
  },
);
it("intraday time equality passes and missing minute structure is not substituted by daily low", () => {
  const f = setup("RK-A-intraday-points30");
  f.minutes.forEach((b) => (b.low = 99.8));
  f.minutes[48 + 5]!.close = 100.25;
  expect(f.run().trades[0]!.exitDate).toBeNull();
  const missing = setup("RK-A-intraday-structure30");
  expect(missing.run().trades).toHaveLength(0);
  expect(missing.run().excluded[0]!.reason).toContain("五分钟结构");
});
