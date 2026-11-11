import { expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  growthIntradayAdditionDecision,
  growthIntradayAdditionSlot,
  growthIntradayOpeningAdditionEligible,
  growthIntradayAuctionQueueDecision,
  growthIntradayEntryDecision,
  growthIntradayGapDecision,
  growthIntradayInitialStop,
  growthIntradayLifeLineLost,
  growthIntradayOpeningSpace,
  growthIntradayReviewDecision,
  growthIntradayScheduledEventReduction,
  growthIntradayStopAdmissible,
  growthIntradayStopDecision,
  growthIntradaySwingCloseDecision,
  growthIntradayTimeDecision,
} from "../src/research/growth/growth-intraday-policy.js";

const bar = (close: number, volume = 100): Bar => ({
  date: "2022-11-21",
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume,
  amount: close * volume,
});

it("admits OP08 additions after six completed bars, after entry day and only before the second fill", () => {
  expect(growthIntradayAdditionSlot("OP08", 5)).toBe(false);
  expect(growthIntradayAdditionSlot("OP08", 6)).toBe(true);
  expect(growthIntradayAdditionSlot("SE-E-intraday50", 0)).toBe(true);
  expect(growthIntradayAdditionSlot("SE-E-intraday50", 6)).toBe(false);
  expect(
    growthIntradayOpeningAdditionEligible(
      "OP08",
      "2022-11-21",
      "2022-11-21",
      1,
    ),
  ).toBe(false);
  expect(
    growthIntradayOpeningAdditionEligible(
      "OP08",
      "2022-11-22",
      "2022-11-21",
      1,
    ),
  ).toBe(true);
  expect(
    growthIntradayOpeningAdditionEligible(
      "OP08",
      "2022-11-23",
      "2022-11-21",
      1,
    ),
  ).toBe(true);
  expect(
    growthIntradayOpeningAdditionEligible(
      "OP08",
      "2022-11-22",
      "2022-11-21",
      2,
    ),
  ).toBe(false);
  expect(
    growthIntradayOpeningAdditionEligible(
      "OP07",
      "2022-11-22",
      "2022-11-21",
      1,
    ),
  ).toBe(false);
});

it("keeps gap equality neutral and uses strictly greater than three percent", () => {
  expect(
    growthIntradayGapDecision("SE-D-gapup3", 100, 103, 100, 90).stop,
  ).toBeNull();
  expect(
    growthIntradayGapDecision("SE-D-gapup3", 100, 103.01, 100, 90).stop,
  ).toBe(100);
  expect(
    growthIntradayGapDecision("CA-D-gapdown3", 100, 97, 100, 92).reduceFraction,
  ).toBeNull();
  expect(
    growthIntradayGapDecision("CA-D-gapdown3", 100, 96.99, 100, 92)
      .reduceFraction,
  ).toBe(0.5);
  expect(
    growthIntradayGapDecision("SE-D-gapup3", 100, 105, 100, 102).stop,
  ).toBe(102);
});

it("distinguishes touch stops, ordinary closes and the swing two-R disaster line", () => {
  const input = {
    id: "RK-C-swing-system" as const,
    completed: { ...bar(99), low: 80 },
    entry: 100,
    initialStop: 90,
    stop: 95,
    afterEntryDay: false,
    closing: false,
  };
  expect(growthIntradayStopDecision(input)).toContain("触碰");
  expect(
    growthIntradayStopDecision({
      ...input,
      completed: { ...bar(94), low: 81 },
    }),
  ).toBeNull();
  expect(
    growthIntradayStopDecision({
      ...input,
      closing: true,
      completed: { ...bar(94), low: 81 },
    }),
  ).toContain("下一交易日");
  expect(
    growthIntradayStopDecision({
      ...input,
      id: "CA-D-gapup3",
      completed: bar(94),
    }),
  ).toBeNull();
  expect(
    growthIntradayStopDecision({
      ...input,
      id: "CA-D-gapup3",
      completed: bar(94),
      afterEntryDay: true,
    }),
  ).toContain("收盘跌破");
  expect(growthIntradayLifeLineLost([bar(94)], 95)).toBe(false);
  expect(growthIntradayLifeLineLost([bar(95), bar(94)], 95)).toBe(false);
  expect(growthIntradayLifeLineLost([bar(94), bar(94)], 95)).toBe(true);
});

it("checks the sixth completed five-minute candle once, with equality at half-R passing", () => {
  const input = {
    completedMinutes: 20,
    close: 100,
    entry: 100,
    initialStop: 90,
  };
  expect(growthIntradayTimeDecision(input)).toEqual({
    completedMinutes: 25,
    checked: false,
    exitReason: null,
  });
  expect(
    growthIntradayTimeDecision({ ...input, completedMinutes: 25 }).exitReason,
  ).toContain("30交易分钟");
  expect(
    growthIntradayTimeDecision({ ...input, completedMinutes: 25, close: 105 })
      .exitReason,
  ).toBeNull();
});

it("owns initial stop distances and rejects unknown structure and oversized swing risk", () => {
  const input = {
    id: "RK-A-intraday-points30" as const,
    price: 100,
    opening: false,
    priorMinutes: null,
  };
  expect(growthIntradayInitialStop(input)).toBe(99.5);
  expect(growthIntradayInitialStop({ ...input, id: "SW02-last30" })).toBe(95);
  expect(growthIntradayInitialStop({ ...input, id: "SE-D-gapup3" })).toBe(90);
  expect(
    growthIntradayInitialStop({ ...input, id: "RK-A-intraday-structure30" }),
  ).toBeNaN();
  expect(growthIntradayStopAdmissible("RK-C-swing-system", 100, 90, 5)).toBe(
    true,
  );
  expect(growthIntradayStopAdmissible("RK-C-swing-system", 100, 89.99, 5)).toBe(
    false,
  );
  expect(growthIntradayStopAdmissible("RK-C-swing-system", 100, 90)).toBe(
    false,
  );
  expect(growthIntradayOpeningSpace(100, { life: 90, resistance: 120 })).toBe(
    true,
  );
  expect(
    growthIntradayOpeningSpace(100, { life: 90, resistance: 119.99 }),
  ).toBe(false);
});

const swing = {
  entry: 100,
  initialStop: 90,
  close: 110,
  stop: 90,
  heldDays: 2,
  maxR: 0,
  scaled: false,
  pending: false,
  tailReady: false,
  dailyPrefix: [],
};
it("raises at one-R, sells original half at two-R and never duplicates a pending reduction", () => {
  expect(growthIntradaySwingCloseDecision(swing)).toMatchObject({
    stop: 100,
    sale: null,
  });
  expect(
    growthIntradaySwingCloseDecision({ ...swing, close: 120 }),
  ).toMatchObject({
    stop: 110,
    scaled: true,
    sale: { fraction: 0.5, originalQuantity: true },
  });
  expect(
    growthIntradaySwingCloseDecision({ ...swing, close: 120, pending: true }),
  ).toMatchObject({ stop: 100, sale: null, scaled: false });
  expect(
    growthIntradaySwingCloseDecision({ ...swing, close: 120, scaled: true })
      .sale,
  ).toBeNull();
});

it("uses maximum attained R for ten-day exit and a trailing line that never falls", () => {
  expect(
    growthIntradaySwingCloseDecision({ ...swing, close: 104.9, heldDays: 10 })
      .sale,
  ).toMatchObject({ fraction: 1, originalQuantity: false });
  expect(
    growthIntradaySwingCloseDecision({
      ...swing,
      close: 100,
      maxR: 0.5,
      heldDays: 10,
    }).sale,
  ).toBeNull();
  const dailyPrefix = Array.from({ length: 23 }, () => bar(120));
  expect(
    growthIntradaySwingCloseDecision({
      ...swing,
      close: 120,
      scaled: true,
      tailReady: true,
      dailyPrefix,
    }).stop,
  ).toBe(115);
  expect(
    growthIntradaySwingCloseDecision({
      ...swing,
      stop: 118,
      close: 120,
      scaled: true,
      tailReady: true,
      dailyPrefix,
    }).stop,
  ).toBe(118);
  expect(
    growthIntradaySwingCloseDecision({ ...swing, tailReady: true }).warning,
  ).toContain("缺失");
});

it("requires the frozen price range and 1.5 times prior full-day volume for an addition", () => {
  const input = {
    id: "SE-E-intraday50" as const,
    intradayEntry: true,
    range: { min: 100, max: 105 },
    close: 101,
    priorDaily: Array.from({ length: 20 }, () => bar(100, 1000)),
    completedDay: [bar(102, 1500)],
  };
  expect(growthIntradayAdditionDecision(input)).toBe(false);
  expect(growthIntradayAdditionDecision({ ...input, close: 101.01 })).toBe(
    true,
  );
  expect(growthIntradayAdditionDecision({ ...input, close: 105 })).toBe(true);
  expect(growthIntradayAdditionDecision({ ...input, close: 105.01 })).toBe(
    false,
  );
  expect(
    growthIntradayAdditionDecision({
      ...input,
      close: 102,
      completedDay: [bar(102, 1499)],
    }),
  ).toBe(false);
  expect(growthIntradayReviewDecision("CA-D-review1430", 98, 100)).toBeNull();
  expect(
    growthIntradayReviewDecision("CA-D-review1430", 97.99, 100),
  ).toMatchObject({ fraction: 0.5 });
});

it("does not create a first entry at 15:00 or repeat a scheduled-event reduction", () => {
  expect(
    growthIntradayAuctionQueueDecision({ ...bar(90), high: 90, low: 90 }, 90),
  ).toBe(true);
  expect(growthIntradayAuctionQueueDecision(bar(90), 90)).toBe(false);
  expect(
    growthIntradayAuctionQueueDecision({ ...bar(90), high: 90, low: 90 }, null),
  ).toBe(false);
  expect(
    growthIntradayEntryDecision({
      id: "SW02-last30",
      symbol: "sh600000",
      priorDaily: [],
      partialDay: bar(100),
      observedAt: "2022-11-21T15:00:00+08:00",
      completedBars: 48,
      calendar: [],
    }),
  ).toEqual({ usable: false, intent: null });
  const input = {
    available: true,
    allow: false,
    eventId: "announcement",
    reducedEventIds: new Set<string>(),
    pending: false,
  };
  expect(growthIntradayScheduledEventReduction(input)).toMatchObject({
    fraction: 0.5,
  });
  expect(
    growthIntradayScheduledEventReduction({ ...input, pending: true }),
  ).toBeNull();
  expect(
    growthIntradayScheduledEventReduction({
      ...input,
      reducedEventIds: new Set(["announcement"]),
    }),
  ).toBeNull();
});
