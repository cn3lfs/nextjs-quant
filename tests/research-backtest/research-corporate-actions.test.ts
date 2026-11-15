import { expect, it } from "vitest";
import {
  researchCorporateActions,
  researchExecutionAt,
  researchExecutionEvidence,
} from "~/server/research/corporate-actions";
it("derives the same daily execution evidence on demand across a calendar-gap ex-date", () => {
  const bars = ["2026-11-06", "2026-11-09"].map((date, i) => ({
    date,
    open: i ? 8 : 10,
    close: i ? 8 : 10,
    high: i ? 9 : 11,
    low: i ? 7 : 9,
    volume: 1000,
    amount: 10000,
  }));
  const actions = [
    {
      date: "2026-11-08",
      availableAt: "2026-11-08",
      dividend: 0.4,
      bonus: 0.2,
      rightsRatio: 0.1,
      rightsPrice: 4,
      evidence: "fixture",
    },
  ];
  const materialized = researchExecutionEvidence("sz000001", bars, actions);
  expect(typeof materialized).toBe("object");
  for (const [i, bar] of bars.entries())
    expect(researchExecutionAt("sz000001", bar, bars[i - 1], actions)).toEqual(
      (materialized as Record<string, unknown>)[bar.date],
    );
  expect(
    researchExecutionAt("sz000001", bars[1], bars[0], actions),
  ).toMatchObject({ limitUp: 8.46, limitDown: 6.92 });
  expect(
    researchExecutionAt("sz000001", undefined, undefined, actions),
  ).toBeUndefined();
});
it("maps cash/bonus/rights/split GBBQ fields without treating non-float changes as public entitlements", () => {
  const date = "2026-11-12";
  expect(
    researchCorporateActions(
      [
        {
          date,
          category: 1,
          name: "ex-rights",
          dividend: 0.2,
          bonusRatio: 0.3,
          rightsRatio: 0.1,
          rightsPrice: 4,
        },
      ],
      "fixture",
      date,
      date,
    )[0],
  ).toMatchObject({
    date,
    dividend: 0.2,
    bonus: 0.3,
    rightsRatio: 0.1,
    rightsPrice: 4,
    shareFactor: 1,
    sharesSellableAt: date,
  });
  expect(
    researchCorporateActions(
      [{ date, category: 11, name: "split", shrinkRatio: 0.5 }],
      "fixture",
      date,
      date,
    )[0],
  ).toMatchObject({ shareFactor: 0.5, bonus: 0, dividend: 0 });
  expect(
    researchCorporateActions(
      [{ date, category: 12, name: "non-float", shrinkRatio: 0.5 }],
      "fixture",
      date,
      date,
    ),
  ).toEqual([]);
  expect(
    researchCorporateActions(
      [
        {
          date,
          category: 5,
          name: "transfer",
          totalSharesBefore: 100,
          totalSharesAfter: 100,
        },
        {
          date,
          category: 1,
          name: "transfer consideration",
          dividend: 0.1,
          bonusRatio: 0.3,
        },
      ],
      "fixture",
      date,
      date,
    )[0],
  ).toMatchObject({ dividend: 0.1, bonus: 0, rightsRatio: 0 });
  expect(() =>
    researchCorporateActions(
      [{ date, category: 11, name: "broken", shrinkRatio: 0 }],
      "fixture",
      date,
      date,
    ),
  ).toThrow("Invalid GBBQ");
  expect(() =>
    researchCorporateActions(
      [{ date, category: 13, name: "warrant" }],
      "fixture",
      date,
      date,
    ),
  ).toThrow("Unsupported warrant");
});
