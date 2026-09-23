import { expect, it } from "vitest";
import {
  indicatorCombinationDecision,
  indicatorCombinationIds,
  indicatorCombinationProfiles,
  researchIndicatorCombinationSeries,
} from "../../../src/lib/research/technical/research-indicator-combinations";
import { researchTechnicalSeries } from "../../../src/lib/research/technical/research-technical";
const facts = {
  ratio: 1.5,
  strength: 65,
  dif: 2,
  dea: 1,
  k: 75,
  close: 110,
  ma5: 105,
  ma10: 103,
  ma20: 101,
  ma60: 100,
};
it.each(indicatorCombinationIds)(
  "%s combines actual child signals with volume, direction and exit precedence",
  (id) => {
    const members = [
      {
        id: indicatorCombinationProfiles[id].legacy[0],
        entry: true,
        exit: false,
        reason: null,
      },
    ];
    expect(indicatorCombinationDecision(id, members, facts)).toMatchObject({
      entry: true,
      exit: false,
    });
    expect(
      indicatorCombinationDecision(id, members, { ...facts, ratio: 1.499 }),
    ).toMatchObject({ entry: false });
    expect(
      indicatorCombinationDecision(
        id,
        [
          ...members,
          { id: "bearish-child", entry: false, exit: true, reason: null },
        ],
        facts,
      ),
    ).toMatchObject({ entry: false, exit: true });
    expect(
      indicatorCombinationDecision(
        id,
        [{ ...members[0]!, reason: "missing" }],
        facts,
      ).reason,
    ).not.toBeNull();
  },
);
it("keeps KDJ 80 inclusive, RSI [40,60] excluded, MACD RSI50 strict and MA equality rejected", () => {
  const m = [{ id: "fixture", entry: true, exit: false, reason: null }];
  expect(
    indicatorCombinationDecision("sw-kdj-combined", m, { ...facts, k: 80 })
      .entry,
  ).toBe(true);
  expect(
    indicatorCombinationDecision("sw-kdj-combined", m, { ...facts, k: 80.01 })
      .entry,
  ).toBe(false);
  for (const strength of [40, 50, 60])
    expect(
      indicatorCombinationDecision("sw-rsi-combined", m, { ...facts, strength })
        .entry,
    ).toBe(false);
  expect(
    indicatorCombinationDecision("sw-macd-combined", m, {
      ...facts,
      strength: 50,
    }).entry,
  ).toBe(false);
  expect(
    indicatorCombinationDecision("sw-ma-combined", m, { ...facts, ma5: 103 })
      .entry,
  ).toBe(false);
});
it.each(indicatorCombinationIds)(
  "%s preserves every named child in executable evidence",
  (id) => {
    const bars = Array.from({ length: 80 }, (_, i) => ({
      date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
      open: 100 + i / 2,
      close: 101 + i / 2,
      high: 102 + i / 2,
      low: 99 + i / 2,
      volume: 100,
      amount: 10000,
    }));
    const result = researchTechnicalSeries(id, bars);
    expect(result).toHaveLength(bars.length);
    const last = result.at(-1)!;
    expect("members" in last && last.members.map((m) => m.id)).toEqual([
      ...indicatorCombinationProfiles[id].legacy,
      ...indicatorCombinationProfiles[id].methods,
    ]);
  },
);
