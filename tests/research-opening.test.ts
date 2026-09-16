import { expect, it } from "vitest";
import {
  openingBand,
  openingMinuteStart,
  openingCandle,
  openingDecision,
  openingPlansSchema,
  openingRows,
  type OpeningContext,
  type OpeningId,
} from "../src/lib/research-opening";
import { growthIntradayTemplate } from "../src/lib/research-growth-intraday";
import {
  growthMinuteTimes,
  researchGrowthIntraday,
} from "../src/server/research-growth-intraday";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/research-portfolio";

it("minute capture includes five benchmark warmup sessions without crossing the hard coverage start", () => {
  const calendar = [
    "1999-12-31",
    "2000-01-04",
    "2000-01-05",
    "2000-01-06",
    "2000-01-07",
    "2000-01-10",
    "2000-01-11",
  ];
  expect(openingMinuteStart(calendar, "2000-01-11")).toBe("2000-01-04");
  expect(openingMinuteStart(calendar, "2000-01-04")).toBe("2000-01-04");
});

function context(id: OpeningId = "OP01"): OpeningContext {
  const yesterday = {
    date: "2022-11-18",
    open: 99,
    high: 101,
    low: 98,
    close: 100,
    volume: 4800,
    amount: 480000,
  };
  const rows = growthMinuteTimes.map((time) => ({
    ...yesterday,
    date: `2022-11-21T${time}:00+08:00`,
    open: 101,
    high: 102,
    low: 100,
    close: 101,
    volume: 70,
  }));
  return {
    id,
    symbol: "sh600000",
    date: "2022-11-21",
    previousDate: yesterday.date,
    open: 100,
    yesterday,
    completed: rows.slice(0, 6),
    priorMinutes: Array.from({ length: 5 }, () =>
      rows.map((b) => ({ ...b, volume: 100 })),
    ),
    plans: openingPlansSchema.parse([
      {
        symbol: "sh600000",
        date: "2022-11-21",
        source: "synthetic frozen plan",
        version: "fixture-1",
        effectiveAt: "2022-11-18T14:00:00+08:00",
        availableAt: "2022-11-18T15:00:00+08:00",
        capturedAt: "2022-11-21T15:00:00+08:00",
        position: "trend",
        life: 90,
        observation: 100,
        resistance: 130,
        special: false,
      },
    ]),
  };
}
it.each([
  [106, "large-up"],
  [105, "up"],
  [102, "up"],
  [101, "flat"],
  [99, "flat"],
  [98, "down"],
  [95, "down"],
  [94, "large-down"],
  [101.5, "gray"],
  [98.5, "gray"],
] as const)("gap %s has explicit boundary %s", (open, expected) =>
  expect(openingBand(open, 100)).toBe(expected),
);
it.each(Object.keys(openingRows) as (keyof typeof openingRows)[])(
  "%s has five distinct branch rows and life-line precedence",
  (id) => {
    expect(openingRows[id]).toHaveLength(5);
    for (const open of [106, 103, 100, 97, 94]) {
      const c = context(id);
      c.open = open;
      c.plans[0]!.life = 99;
      c.completed = c.completed.map((b) => ({
        ...b,
        open: 98,
        low: 97,
        close: 98,
      }));
      expect(openingDecision(c).sell).toBe(1);
    }
  },
);
it("flat contracted retest buys only after two confirmed closes and enough 2R space", () => {
  const c = context();
  expect(openingDecision(c).buy).toBe(true);
  expect(
    openingDecision({ ...c, completed: c.completed.slice(0, 5) }).buy,
  ).toBe(false);
  expect(
    openingDecision({
      ...c,
      completed: c.completed.map((b) => ({ ...b, close: 100 })),
    }).buy,
  ).toBe(false);
  c.plans[0]!.resistance = 110;
  expect(openingDecision(c).buy).toBe(false);
});
it("opening price uses daily open, never completed five-minute close; large gaps do not chase", () => {
  const c = context();
  c.open = 106;
  expect(openingDecision(c)).toMatchObject({
    buy: false,
    sell: 0,
    evidence: { band: "large-up" },
  });
  c.completed = c.completed.map((b) => ({ ...b, volume: 150 }));
  expect(openingDecision(c).sell).toBe(0.5);
  c.open = 88;
  c.completed = c.completed
    .slice(0, 1)
    .map((b) => ({ ...b, close: 120, high: 121 }));
  expect(openingDecision(c).sell).toBe(1);
});
it("same-time volume is mandatory; a late, duplicate or special plan stays unavailable", () => {
  const c = context();
  expect(
    openingDecision({ ...c, priorMinutes: c.priorMinutes.slice(0, 4) }).status,
  ).toBe("missing");
  expect(openingDecision({ ...c, plans: [] }).status).toBe("missing");
  expect(
    openingDecision({ ...c, plans: [c.plans[0]!, c.plans[0]!] }).status,
  ).toBe("missing");
  c.plans[0]!.availableAt = "2022-11-21T09:25:00+08:00";
  expect(openingDecision(c).status).toBe("missing");
  c.plans[0]!.availableAt = "2022-11-18T15:00:00+08:00";
  c.plans[0]!.special = true;
  expect(openingDecision(c).status).toBe("missing");
});

it("invalid previous daily candle is missing evidence, including exit-only baseline entry", () => {
  for (const id of ["OP01", "OP04", "OP08"] as const) {
    const c = context(id);
    c.yesterday.volume = 0;
    expect(openingDecision(c).status).toBe("missing");
    c.yesterday.volume = 100;
    c.yesterday.low = c.yesterday.high + 1;
    expect(openingDecision(c).status).toBe("missing");
  }
});
it("yesterday upper shadow raises observation; downtrend does not buy a pretty bullish candle", () => {
  const c = context();
  c.yesterday = { ...c.yesterday, open: 98, close: 100, high: 110, low: 97 };
  expect(openingCandle(c.yesterday).kind).toBe("upper");
  expect(openingDecision(c).buy).toBe(false);
  c.id = "OP05";
  c.plans[0]!.position = "decline";
  expect(openingDecision(c)).toMatchObject({ buy: false, sell: 0.5 });
});
it("OP06 prior close and OP07 frozen opening range use later completed bars", () => {
  const c = context("OP06");
  c.completed = c.completed.map((b) => ({ ...b, volume: 150 }));
  expect(openingDecision(c).buy).toBe(true);
  c.id = "OP07";
  expect(openingDecision(c).buy).toBe(false);
  const b = c.completed[0]!;
  c.completed = [
    ...c.completed,
    { ...b, date: "2022-11-21T10:05:00+08:00", close: 103, high: 104 },
    { ...b, date: "2022-11-21T10:10:00+08:00", close: 103, high: 104 },
  ];
  expect(openingDecision(c)).toMatchObject({
    buy: true,
    evidence: { range: { high: 102, low: 100 } },
  });
});
it("OP02 and OP03 require matching frozen positions; OP04 sells weakness but holds strong engulf", () => {
  for (const [id, position] of [
    ["OP02", "bottom"],
    ["OP03", "platform"],
  ] as const) {
    const c = context(id);
    expect(openingDecision(c).buy).toBe(false);
    c.plans[0]!.position = position;
    expect(openingDecision(c).buy).toBe(true);
  }
  const c = context("OP04");
  c.plans[0]!.position = "exhaustion";
  c.open = 103;
  expect(openingDecision(c).sell).toBe(0.5);
  c.completed = c.completed.map((b) => ({
    ...b,
    close: 104,
    high: 105,
    volume: 150,
  }));
  expect(openingDecision(c).sell).toBe(0);
});

export function openingFixture(id: OpeningId = "OP08") {
  const c = context(id);
  const daily = Array.from({ length: 10 }, (_, i) => ({
    ...c.yesterday,
    date: `2022-11-${11 + i}`,
    open: 99,
    close: 100,
  }));
  const calendar = daily.map((b) => b.date);
  const minutes = daily.flatMap((b) =>
    growthMinuteTimes.map((time) => ({
      ...b,
      date: `${b.date}T${time}:00+08:00`,
      open: 101,
      close: 101,
      high: 102,
      low: 100,
      volume: 100,
    })),
  );
  const plans = daily.slice(1).map((b, i) => ({
    ...c.plans[0]!,
    date: b.date,
    effectiveAt: `${daily[i]!.date}T14:00:00+08:00`,
    availableAt: `${daily[i]!.date}T15:00:00+08:00`,
  }));
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: calendar[5],
    end: calendar[9],
    validationStart: calendar[9],
    holdingDays: 60,
    initialCapital: 1000000,
    risk: { fraction: 0.02, maxWeight: 0.4 },
    management: { ...growthIntradayTemplate(id), openingPlans: plans },
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      slippageBps: 0,
      sellTaxBps: 0,
    },
  });
  const event: ResearchEvent = {
    symbol: c.symbol,
    observedDate: calendar[5]!,
    endpointDate: calendar[5]!,
    key: "confirmed baseline fixture",
    strategyVersion: "fixture",
    partition: "development",
    evidence: "synthetic confirmed signal",
  };
  const rule = {
    evidence: "fixture",
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
  const run = () => {
    const d = new Map([[c.symbol, daily]]);
    return researchGrowthIntraday(
      spec,
      [event],
      calendar,
      d,
      new Map([[c.symbol, minutes]]),
      () => rule,
      researchPortfolio(spec, [], calendar, d, () => rule),
    );
  };
  return { spec, event, daily, minutes, calendar, run };
}
it("OP08 executes at 10:00 after confirmation and exits new lots only after T+1", () => {
  const f = openingFixture();
  const result = f.run();
  expect(result.trades[0]!.entries![0]!.date).toBe(
    `${f.calendar[6]}T10:00:00+08:00`,
  );
  for (const b of f.minutes)
    if (b.date.startsWith(f.calendar[6]!) && b.date.slice(11, 16) >= "11:00")
      Object.assign(b, { open: 89, close: 89, high: 90, low: 88 });
  const stopped = f.run().trades[0]!;
  expect(stopped.sales!.length).toBeGreaterThan(0);
  expect(
    stopped.sales!.every((s) => s.date.slice(0, 10) > f.calendar[6]!),
  ).toBe(true);
  expect(stopped.sales![0]!.date).toBe(`${f.calendar[7]}T09:30:00+08:00`);
});

it("OP08 mixed old/new lots sell independently on two days using the existing FIFO book", () => {
  const f = openingFixture();
  for (const b of f.minutes)
    if (b.date.startsWith(f.calendar[7]!) && b.date.slice(11, 16) >= "11:00")
      Object.assign(b, { open: 89, close: 89, high: 90, low: 88 });
  const t = f.run().trades[0]!;
  expect(t.entries!.map((e) => e.date.slice(0, 10))).toEqual([
    f.calendar[6],
    f.calendar[7],
  ]);
  expect(t.sales!.map((s) => s.date.slice(0, 10))).toEqual([
    f.calendar[7],
    f.calendar[8],
  ]);
  expect(t.sales!.map((s) => s.quantity)).toEqual(
    t.entries!.map((e) => e.quantity),
  );
  expect(t.book!.remainingQuantity).toBe(0);
});

it("AR time and size components actually change minute entry and risk sizing", () => {
  const f = openingFixture();
  f.spec.management = growthIntradayTemplate("AR01-time-window");
  const best = f.run().trades[0]!;
  expect(best.entries![0]!.date).toBe(`${f.calendar[6]}T14:00:00+08:00`);
  f.spec.management = growthIntradayTemplate("AR01-morning");
  expect(f.run().trades[0]!.entries![0]!.date).toBe(
    `${f.calendar[6]}T10:00:00+08:00`,
  );
  f.spec.management = growthIntradayTemplate("AR07-late-size");
  f.event.observedDate = f.calendar[6]!;
  f.event.intradayAt = `${f.calendar[6]}T14:30:00+08:00`;
  const late = f.run().trades[0]!;
  expect(late.entries![0]!.date).toBe(`${f.calendar[6]}T14:30:00+08:00`);
  expect(late.quantity).toBeLessThan(best.quantity * 0.3);
});
