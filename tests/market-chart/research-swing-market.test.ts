import { expect, it } from "vitest";
import type { Bar } from "../../src/lib/domain";
import {
  swingMarketIds,
  swingBreadthRatio,
  swingMarketDecision,
  researchSwingMarketSeries,
  type SwingMarketEvidence,
} from "../../src/lib/research/methods/swing/research-swing-market";
import { researchTechnicalSeries } from "../../src/lib/research/technical/research-technical";

it.each(["sw-market-holiday", "sw-market-event"] as const)(
  "%s uses known trading-day distances rather than weekday guesses",
  (id) => {
    for (const distance of [1, 2])
      expect(
        swingMarketDecision(id, { distance, calendarComplete: true }),
      ).toMatchObject({ allow: false, exit: false, state: "blocked" });
    for (const distance of [0, 3, null])
      expect(
        swingMarketDecision(id, { distance, calendarComplete: true }).allow,
      ).toBe(true);
    expect(
      swingMarketDecision(id, { distance: 3, calendarComplete: false }).state,
    ).toBe("unknown");
  },
);
it("accounts for historical pool totals, zero denominators and strict breadth thresholds", () => {
  const e = {
    advancing: 150,
    declining: 100,
    unchanged: 20,
    suspended: 5,
    total: 275,
    complete: true,
    universeDate: "2024-01-01",
    universeSource: "frozen-members",
  };
  expect(swingBreadthRatio(e, e.universeDate)).toBe(1.5);
  expect(swingBreadthRatio({ ...e, total: 276 }, e.universeDate)).toBeNull();
  expect(
    swingBreadthRatio({ ...e, declining: 0, total: 175 }, e.universeDate),
  ).toBeNull();
  expect(swingBreadthRatio(e, "2024-01-02")).toBeNull();
  for (const ratio of [0.7, 1.5])
    expect(swingMarketDecision("sw-market-breadth", { ratio }).state).toBe(
      "neutral",
    );
  expect(swingMarketDecision("sw-market-breadth", { ratio: 1.51 }).allow).toBe(
    true,
  );
  expect(swingMarketDecision("sw-market-breadth", { ratio: 0.69 }).exit).toBe(
    true,
  );
});
it("requires three consecutive complete neutral days, inclusive at both bounds", () => {
  expect(
    swingMarketDecision("sw-market-neutral3", { ratios: [0.8, 1, 1.2] }).state,
  ).toBe("blocked");
  expect(
    swingMarketDecision("sw-market-neutral3", { ratios: [0.79, 1, 1.2] }).allow,
  ).toBe(true);
  expect(
    swingMarketDecision("sw-market-neutral3", { ratios: [null, 1, 1.2] }).state,
  ).toBe("unknown");
});
it("MACD keeps zero neutral and volatility uses the disclosed inclusive twofold boundary", () => {
  expect(swingMarketDecision("sw-market-macd", { histogram: 0 }).state).toBe(
    "neutral",
  );
  expect(swingMarketDecision("sw-market-macd", { histogram: 1 }).allow).toBe(
    true,
  );
  expect(swingMarketDecision("sw-market-macd", { histogram: -1 }).exit).toBe(
    true,
  );
  expect(
    swingMarketDecision("sw-market-volatility", {
      volatility20: 0.02,
      volatility60: 0.01,
    }).exit,
  ).toBe(true);
  expect(
    swingMarketDecision("sw-market-volatility", {
      volatility20: 0.019,
      volatility60: 0.01,
    }).allow,
  ).toBe(true);
  expect(
    swingMarketDecision("sw-market-volatility", {
      volatility20: 0,
      volatility60: 0,
    }).state,
  ).toBe("unknown");
});
it("volume and Bollinger filters preserve price equality, previous-only volumes and squeeze direction", () => {
  const f = { close: 103, previousClose: 100, volume: 1500, priorVolume: 1000 };
  expect(swingMarketDecision("sw-market-volume", f).allow).toBe(true);
  expect(
    swingMarketDecision("sw-market-volume", { ...f, close: 102 }).state,
  ).toBe("neutral");
  expect(
    swingMarketDecision("sw-market-volume", { ...f, volume: 1499 }).allow,
  ).toBe(false);
  expect(
    swingMarketDecision("sw-market-volume", { ...f, close: 97 }).exit,
  ).toBe(true);
  const b = {
    close: 111,
    upper: 110,
    lower: 90,
    priorWidths: [0.12, 0.11, 0.1],
  };
  expect(swingMarketDecision("sw-market-boll", b).allow).toBe(true);
  expect(
    swingMarketDecision("sw-market-boll", { ...b, close: 110 }).state,
  ).toBe("neutral");
  expect(swingMarketDecision("sw-market-boll", { ...b, close: 89 }).exit).toBe(
    true,
  );
  expect(
    swingMarketDecision("sw-market-boll", {
      ...b,
      priorWidths: [0.1, 0.1, 0.1],
    }).allow,
  ).toBe(false);
});
const bars = (): Bar[] =>
  Array.from({ length: 80 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: i === 79 ? 101 : 100,
    close: i === 79 ? 102 : 100,
    high: i === 79 ? 103 : 101,
    low: 99,
    volume: 1000,
    amount: 100000,
  }));
const proof = (input: Bar[]): SwingMarketEvidence[] =>
  input.map((b, i) => ({
    date: b.date,
    availableDate: b.date,
    source: "fixture",
    index: { ...b, open: 100 + i, close: 101 + i, high: 102 + i, low: 99 + i },
    breadth: {
      advancing: 160,
      declining: 100,
      unchanged: 0,
      suspended: 0,
      total: 260,
      complete: true,
      universeDate: b.date,
      universeSource: "frozen",
    },
    holiday: { distance: 3, complete: true, calendarSource: "exchange" },
    event: { distance: null, complete: true, calendarSource: "known-notices" },
  }));
it.each(swingMarketIds)(
  "%s is wired to execution and refuses unavailable/future/duplicate market evidence",
  (id) => {
    const input = bars(),
      rows = proof(input);
    expect(researchTechnicalSeries(id, input)).toEqual(
      researchSwingMarketSeries(id, input),
    );
    for (const evidence of [
      [],
      [...rows, ...rows],
      rows.map((e) => ({ ...e, availableDate: "2099-01-01" })),
    ])
      expect(
        researchSwingMarketSeries(id, input, evidence).at(-1),
      ).toMatchObject({
        entry: false,
        reason: expect.stringContaining("待数据"),
      });
  },
);
it("uses market evidence on an actual baseline cross and does not use stock direction as the index", () => {
  const input = bars(),
    rows = proof(input);
  expect(
    researchSwingMarketSeries("sw-market-breadth", input, rows).at(-1)!.entry,
  ).toBe(true);
  rows.at(-1)!.breadth!.advancing = 69;
  rows.at(-1)!.breadth!.total = 169;
  expect(
    researchSwingMarketSeries("sw-market-breadth", input, rows).at(-1),
  ).toMatchObject({ entry: false, exit: true });
  expect(
    researchSwingMarketSeries("sw-market-macd", input, rows).at(-1)!.entry,
  ).toBe(true);
  delete rows.at(-1)!.index;
  expect(
    researchSwingMarketSeries("sw-market-macd", input, rows).at(-1)!.entry,
  ).toBe(false);
});
