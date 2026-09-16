import { expect, it } from "vitest";
import {
  researchAccountRisk,
  accountRiskRules,
} from "../src/lib/research-account-risk";
const dates = (n = 50) =>
  Array.from({ length: n }, (_, i) =>
    new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
  );
it.each(Object.keys(accountRiskRules) as (keyof typeof accountRiskRules)[])(
  "%s has an explicit idle/unknown state and a stable snapshot",
  (rule) => {
    const c = researchAccountRisk(rule, dates(), 100);
    c.begin(0);
    c.close(0, 100, false);
    expect(c.snapshot().remainingTradingDays).toBe(
      rule === "equity20" ? null : 0,
    );
    expect(c.snapshot().monthly).toEqual([]);
    expect(c.snapshot().nextEligibleDate).toBeNull();
  },
);
it("daily equality trips one future day, while five-percent emergency is strictly greater", () => {
  const c = researchAccountRisk("day2", dates(2), 100);
  c.begin(0);
  c.close(0, 98, false);
  c.begin(1);
  expect(c.blocked(1)).toBe(true);
  c.close(1, 98, false);
  expect(c.snapshot()).toMatchObject({
    paused: true,
    remainingTradingDays: 0,
    pausedThrough: dates(2)[1],
    nextEligibleDate: null,
  });
  const e = researchAccountRisk("day5-week", dates(2), 100);
  e.begin(0);
  e.close(0, 95, false);
  expect(e.snapshot().paused).toBe(false);
  e.begin(1);
  e.close(1, 90.24, false);
  expect(e.snapshot()).toMatchObject({
    paused: true,
    remainingTradingDays: 5,
    pausedThrough: null,
    nextEligibleDate: null,
  });
});
it("drawdown cooldown consumes supplied trading dates, then resets its peak at recovery", () => {
  const ds = [
    "2021-01-04",
    "2021-01-05",
    "2021-01-08",
    "2021-01-11",
    "2021-01-20",
    "2021-02-01",
    "2021-02-10",
  ];
  const c = researchAccountRisk("drawdown10", ds, 100);
  c.begin(0);
  c.close(0, 90, false);
  for (let i = 1; i <= 5; i++) {
    c.begin(i);
    expect(c.blocked(i)).toBe(true);
    c.close(i, 90, false);
  }
  c.begin(6);
  expect(c.blocked(6)).toBe(false);
  c.close(6, 90, false);
  expect(c.snapshot().paused).toBe(false);
});
it("week/month period locks reset only on the corresponding provided calendar boundary", () => {
  for (const [rule, ds] of [
    ["week6", ["2021-01-07", "2021-01-08", "2021-01-11"]],
    ["month6", ["2021-01-28", "2021-01-29", "2021-02-01"]],
  ] as const) {
    const c = researchAccountRisk(rule, ds, 100);
    c.begin(0);
    c.close(0, 94, false);
    c.begin(1);
    expect(c.blocked(1)).toBe(true);
    c.close(1, 94, false);
    c.begin(2);
    expect(c.blocked(2)).toBe(false);
    c.close(2, 94, false);
  }
});
it("Elder uses within-month peak rather than just opening equity", () => {
  const c = researchAccountRisk("elder6", dates(), 100);
  c.begin(0);
  c.close(0, 110, false);
  c.begin(1);
  c.close(1, 103.4, false);
  expect(c.blocked(1)).toBe(true);
});
it("five losses reduce size until subsequent net R is positive; zero breaks a streak", () => {
  const c = researchAccountRisk("streak5-half", dates(), 100);
  c.begin(0);
  for (let i = 0; i < 5; i++) c.settle(0, -1, 1);
  expect(c.multiplier()).toBe(0.5);
  c.settle(0, -2, 1);
  c.settle(0, 2, 1);
  expect(c.multiplier()).toBe(0.5);
  c.settle(0, 0.01, 1);
  expect(c.multiplier()).toBe(1);
  const z = researchAccountRisk("loss5-week", dates(), 100);
  z.begin(0);
  for (let i = 0; i < 4; i++) z.settle(0, -1, 1);
  z.settle(0, 0, 1);
  z.settle(0, -1, 1);
  expect(z.blocked(0)).toBe(false);
  for (let i = 0; i < 4; i++) z.settle(0, -1, 1);
  expect(z.snapshot().remainingTradingDays).toBe(5);
});
it("weekly -3R includes all net settlements; unavailable R fails closed", () => {
  const c = researchAccountRisk("week3r", dates(), 100);
  c.begin(0);
  c.settle(0, -6, 2);
  expect(c.blocked(0)).toBe(true);
  const d = researchAccountRisk("week3r", dates(), 100);
  d.begin(0);
  d.settle(0, 1, null);
  expect(d.blocked(0)).toBe(true);
});
it.each(["month-win35", "month-rr15"] as const)(
  "%s counts full adjacent months, retains zero/loss samples, then pauses five dates",
  (rule) => {
    const ds = [
      "2021-01-15",
      "2021-02-01",
      "2021-03-01",
      "2021-04-01",
      "2021-04-02",
    ];
    const c = researchAccountRisk(rule, ds, 100);
    for (let i = 0; i < 4; i++) {
      c.begin(i);
      for (const p of [1, -2, -2, 0]) c.settle(i, p, 1);
      c.close(i, 100 - i, false);
    }
    expect(c.snapshot().monthly.map((m) => m.complete)).toEqual([
      false,
      true,
      true,
    ]);
    expect(c.snapshot().monthly[1]).toMatchObject({
      winRate: 0.25,
      payoff: 0.5,
      wins: 1,
      losses: 2,
      zeros: 1,
      profits: [1, -2, -2, 0],
    });
    expect(c.snapshot()).toMatchObject({
      paused: true,
      remainingTradingDays: 4,
      pausedThrough: null,
      nextEligibleDate: null,
    });
  },
);
it("monthly negative3 skips the partial first month and unavailable monthly ratios break the consecutive test", () => {
  const ds = [
    "2021-01-15",
    "2021-02-01",
    "2021-03-01",
    "2021-04-01",
    "2021-05-01",
  ];
  const c = researchAccountRisk("month-negative3", ds, 100);
  for (let i = 0; i < 5; i++) {
    c.begin(i);
    c.close(i, 99 - i, false);
  }
  expect(c.snapshot().paused).toBe(true);
  const d = researchAccountRisk("month-rr15", ds, 100);
  for (let i = 0; i < 5; i++) {
    d.begin(i);
    if (i !== 2) {
      d.settle(i, 1, 1);
      d.settle(i, -2, 1);
    }
    d.close(i, 100, false);
  }
  expect(d.snapshot().paused).toBe(false);
  expect(d.snapshot().monthly[2]!.payoff).toBeNull();
});
it("equity curve uses only 20 completed observations, equality resumes, and stale prices block", () => {
  const c = researchAccountRisk("equity20", dates(), 100);
  for (let i = 0; i < 20; i++) {
    c.begin(i);
    c.close(i, 100, false);
  }
  expect(c.blocked(19)).toBe(false);
  c.begin(20);
  c.close(20, 99, false);
  expect(c.blocked(20)).toBe(true);
  c.begin(21);
  c.close(21, 101, false);
  expect(c.blocked(21)).toBe(false);
  c.begin(22);
  c.close(22, 101, true);
  expect(c.blocked(22)).toBe(true);
});

it("missing entire months cannot create a consecutive monthly failure or a fabricated recovery date", () => {
  const ds = [
    "2021-01-15",
    "2021-02-01",
    "2021-04-01",
    "2021-05-01",
    "2021-06-01",
  ];
  const c = researchAccountRisk("month-win35", ds, 100);
  for (let i = 0; i < ds.length; i++) {
    c.begin(i);
    c.settle(i, -1, 1);
    c.close(i, 100, false);
  }
  expect(c.snapshot().monthly.map((m) => m.complete)).toEqual([
    false,
    false,
    false,
    true,
  ]);
  expect(c.snapshot().paused).toBe(false);
  const week = researchAccountRisk("week6", ["2021-01-04"], 100);
  week.begin(0);
  week.close(0, 94, false);
  expect(week.snapshot()).toMatchObject({
    paused: true,
    remainingTradingDays: null,
    nextEligibleDate: null,
  });
});
