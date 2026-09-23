import { expect, it } from "vitest";
import {
  evaluateChanSectorRotation,
  evaluateChanSectorCurrentMembership,
  chanSectorAdmission,
} from "../../../../src/lib/research/methods/chan/research-chan-sector";
const calendar = Array.from(
  { length: 20 },
  (_, i) => `2020-01-${String(i + 1).padStart(2, "0")}`,
);
function input() {
  return {
    source: "historical-sectors",
    universeAvailableAt: "2019-12-31T15:00:00+08:00",
    universe: ["a", "b"],
    calendar,
    sectors: [
      {
        id: "a",
        membership: [
          {
            source: "historical",
            effectiveAt: calendar[0]!,
            availableAt: "2019-12-31T15:00:00+08:00",
            capturedAt: "2020-01-20T15:00:00+08:00",
            members: ["sh600000"],
          },
        ],
      },
      {
        id: "b",
        membership: [
          {
            source: "historical",
            effectiveAt: calendar[0]!,
            availableAt: "2019-12-31T15:00:00+08:00",
            capturedAt: "2020-01-20T15:00:00+08:00",
            members: ["sz000001"],
          },
        ],
      },
    ],
    prices: ["sh600000", "sz000001"].flatMap((symbol, s) =>
      calendar.map((date, i) => ({
        symbol,
        date,
        close: s ? 30 - i : 10 + i,
        source: "fixture",
        availableAt: `${date}T15:00:00+08:00`,
        capturedAt: "2020-01-20T15:00:00+08:00",
      })),
    ),
  };
}
const asOf = "2020-01-20T15:05:00+08:00";
it("CH11 ranks real sector breadth and combines with third buy; weak sector exits", () => {
  expect(
    evaluateChanSectorRotation(input(), asOf).rows.map((r) => [
      r.sector,
      r.breadth,
      r.eligible,
    ]),
  ).toEqual([
    ["a", 1, true],
    ["b", 0, false],
  ]);
  expect(chanSectorAdmission(input(), asOf, "sh600000", true).entry).toBe(true);
  expect(chanSectorAdmission(input(), asOf, "sh600000", false).entry).toBe(
    false,
  );
  expect(chanSectorAdmission(input(), asOf, "sz000001", true)).toMatchObject({
    entry: false,
    exit: true,
  });
});
it("CH11 refuses current membership, missing availableAt, incomplete prices and duplicate membership", () => {
  expect(evaluateChanSectorRotation(undefined, asOf).status).toBe("missing");
  const current = input();
  current.sectors[0]!.membership[0]!.availableAt = "2026-01-01T15:00:00+08:00";
  expect(evaluateChanSectorRotation(current, asOf).status).toBe("missing");
  const missing = input();
  Reflect.deleteProperty(missing.sectors[0]!.membership[0]!, "availableAt");
  expect(evaluateChanSectorRotation(missing, asOf).status).toBe("missing");
  const prices = input();
  prices.prices.pop();
  expect(evaluateChanSectorRotation(prices, asOf).status).toBe("missing");
  const duplicate = input();
  duplicate.sectors[0]!.membership[0]!.members.push("sh600000");
  expect(evaluateChanSectorRotation(duplicate, asOf).status).toBe("missing");
});
it("CH11 strict MA equality does not qualify and missing data never creates an exit", () => {
  const x = input();
  x.prices.forEach((p) => (p.close = 10));
  expect(
    evaluateChanSectorRotation(x, asOf).rows.every((r) => !r.eligible),
  ).toBe(true);
  expect(chanSectorAdmission(undefined, asOf, "sh600000", true)).toMatchObject({
    status: "missing",
    entry: false,
    exit: false,
  });
});
it("CH11 current-membership-v1 is a separate biased comparison", () => {
  const x = input();
  x.sectors[0]!.membership[0]!.availableAt = "2026-01-01T15:00:00+08:00";
  const result = evaluateChanSectorCurrentMembership(x, asOf);
  expect(result).toMatchObject({
    status: "available",
    methodVersion: "current-membership-v1",
    comparisonGroup: "current-membership-v1",
    bias: "membership-and-survivorship",
  });
  expect(result.boundary).toContain("成分偏差与存活偏差");
  expect(
    chanSectorAdmission(x, asOf, "sh600000", true, "current-membership-v1")
      .entry,
  ).toBe(true);
});
