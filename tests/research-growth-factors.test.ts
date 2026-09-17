import { expect, it } from "vitest";
import {
  evaluateGrowthFactors,
  growthFactorMethods,
  rankGrowthFactors,
} from "../src/server/research-growth-factors";
import { runGrowthFactorResearch } from "../src/server/research-run";
import type { AsOfObservation } from "../src/lib/as-of";

import { request, event, fixture } from "./helpers/growth-factor-fixture";
function set(
  rows: AsOfObservation[],
  field: string,
  value: unknown,
  period?: string,
) {
  return rows.map((r) =>
    r.field === field && (!period || r.effectiveAt === period)
      ? { ...r, value }
      : r,
  );
}
const one = (id: string, rows = fixture(), req = request) =>
  evaluateGrowthFactors(req, rows, [id]).results[0]!;

it("34 named waiting-data methods execute through research entry, with missing rather than fabricated scores", () => {
  expect(
    Object.keys(growthFactorMethods).filter((id) =>
      ["finance", "capital", "institution", "catalyst"].includes(
        growthFactorMethods[id]!.family,
      ),
    ),
  ).toHaveLength(34);
  const all = runGrowthFactorResearch(
    request,
    fixture(),
    Object.keys(growthFactorMethods).filter((id) =>
      ["finance", "capital", "institution", "catalyst"].includes(
        growthFactorMethods[id]!.family,
      ),
    ),
  );
  expect(all.results).toHaveLength(34);
  expect(all.results.filter((r) => r.status !== "computed")).toEqual([]);
  expect(all.realBacktest).toMatchObject({
    available: false,
    coverage: { start: null, end: null },
  });
  expect(all.counts).toEqual({ rule: 34, human: 0, llm: 0 });
  expect(runGrowthFactorResearch(request, []).counts).toEqual({
    rule: 0,
    human: 0,
    llm: 0,
  });
  expect(
    runGrowthFactorResearch(request, []).results.every(
      (r) => r.points === null && r.dataGaps.length > 0,
    ),
  ).toBe(true);
  expect(() => one("not-registered")).toThrow("未知");
});
it.each([
  ["CA-S-C1", 1.5, 8],
  ["CA-S-C1", 1.25, 6],
  ["CA-S-C1", 1.2, 3],
  ["CA-S-C1", 1.199, 0],
  ["CA-B-C1", 1.25, 8],
  ["CA-B-C1", 1.249, 0],
])("%s EPS equality %s gives %s", (id, eps, expected) =>
  expect(
    one(id, set(fixture(), "quarterlyEps", eps, "2024-03-31")).points,
  ).toBe(expected),
);
it("turnarounds require actual loss-to-profit, zero bases remain unavailable", () => {
  const rows = set(fixture(), "quarterlyEps", -1, "2023-03-31");
  expect(one("CA-S-C1-turnaround", rows).points).toBe(8);
  expect(one("CA-S-C1", rows).points).toBeNull();
  expect(
    one("CA-S-C1-turnaround", set(rows, "quarterlyEps", -2, "2024-03-31"))
      .points,
  ).toBe(0);
  expect(
    one("CA-S-C1", set(rows, "quarterlyEps", 0, "2023-03-31")).points,
  ).toBeNull();
  const annual = set(fixture(), "annualEps", -1, "2021-12-31");
  expect(one("CA-S-A1-turnaround", annual).points).toBe(8);
  expect(one("CA-S-A1", annual).points).toBeNull();
});
it.each([
  [30, 25, 20, 7],
  [30, 25, 26, 5],
  [19, 15, 10, 3],
  [60, 80, 70, 3],
  [30, 34, 20, 3],
  [30, 35, 20, 0],
  [10, 30, 20, 0],
])("acceleration %s/%s/%s -> %s", (x, y, z, p) => {
  let rows = fixture();
  for (const [date, v] of [
    ["2024-03-31", x],
    ["2023-12-31", y],
    ["2023-09-30", z],
  ] as const)
    rows = set(rows, "quarterlyEpsGrowth", v, date);
  expect(one("CA-S-C2", rows).points).toBe(p);
  expect(one("CA-B-C2", rows).points).toBe(x > y ? 7 : 0);
});
it.each([
  [30, 5],
  [20, 4],
  [10, 2],
  [9.99, 0],
  [-10, 0],
])("revenue %s tier %s and binary stay independent", (g, p) => {
  const rows = set(fixture(), "quarterlyRevenueGrowth", g);
  expect(one("CA-S-C3", rows).points).toBe(p);
  expect(one("CA-B-C3", rows).points).toBe(g >= 20 ? 5 : 0);
  expect(one("CA-S-C3", set(rows, "quarterlyProfitGrowth", -1)).points).toBe(
    Math.max(0, p - (g > 0 ? 1 : 0)),
  );
});
it.each([
  [1.35, 8],
  [1.25, 6],
  [1.15, 3],
  [1.14, 0],
])("annual CAGR boundary %s -> %s", (ratio, p) => {
  const rows = set(fixture(), "annualEps", ratio ** 2, "2023-12-31");
  expect(one("CA-S-A1", rows).points).toBe(p);
  expect(one("CA-B-A1", rows).points).toBe(ratio >= 1.25 ? 8 : 0);
  const loss = set(rows, "annualEps", -1, "2022-12-31");
  expect(one("CA-S-A1", loss).points).toBeNull();
  expect(one("CA-S-A1-loss-exclusion", loss)).toMatchObject({
    points: p,
    details: { years: 2, excludedPeriods: ["2022-12-31"] },
  });
});
it.each([
  [25, 7],
  [17, 5],
  [12, 2],
  [11.9, 0],
  [51, 7],
])("annual ROE %s -> %s", (roe, p) => {
  const rows = set(fixture(), "annualRoe", roe);
  expect(one("CA-S-A2", rows)).toMatchObject({
    points: p,
    details: { lowEquityRisk: roe > 50 },
  });
  expect(one("CA-B-A2", rows).points).toBe(roe >= 17 ? 7 : 0);
});
it.each([
  [1.2, 5],
  [1, 4],
  [0.7, 2],
  [0.69, 0],
  [-1, 0],
])("cash coverage %s -> %s", (cash, p) => {
  const rows = set(set(fixture(), "annualEps", 1), "annualCashPerShare", cash);
  expect(one("CA-S-A3", rows).points).toBe(p);
  expect(one("CA-B-A3", rows).points).toBe(cash >= 1 ? 5 : 0);
  expect(one("CA-S-A3", set(rows, "annualEps", 0)).points).toBe(0);
});
it("SEPA strict and tolerant are paired, with exact floors and mandatory margin improvement", () => {
  expect(one("SE02").details).toMatchObject({
    strictPass: true,
    flexiblePass: true,
  });
  let rows = set(
    set(fixture(), "quarterlyNetMargin", 12, "2024-03-31"),
    "annualRoe",
    13.6,
  );
  expect(one("SE02", rows)).toMatchObject({
    points: 2,
    details: { strictPass: false, flexiblePass: true },
  });
  expect(one("SE02", set(rows, "annualRoe", 13.599)).points).toBe(0);
  rows = set(rows, "quarterlyNetMargin", 12, "2023-03-31");
  expect(one("SE02", rows).details.flexiblePass).toBe(false);
});
it.each([
  [100, 5],
  [300, 5],
  [50, 4],
  [500, 4],
  [30, 2],
  [1000, 2],
  [29, 0],
  [1001, 0],
])("float cap %s -> %s with independent event adjustments", (cap, p) => {
  const rows = set(fixture(), "floatMarketCap", cap * 1e8);
  expect(one("CA-S-S2", rows).points).toBe(p);
  expect(one("CA-B-S2", rows).points).toBe(cap >= 50 && cap <= 500 ? 5 : 0);
  const plans = set(rows, "plans", {
    unlockDates: ["2024-08-01"],
    activeBuybackPlan: true,
  });
  expect(one("CA-S-S2-unlock", plans).points).toBe(Math.max(0, p - 1));
  expect(one("CA-S-S2-buyback", plans).points).toBe(Math.min(5, p + 1));
  expect(one("CA-S-S2", plans).points).toBe(p);
});
it("three calendar months clamp month ends and exclude the following day", () => {
  const req = {
    ...request,
    observationDate: "2024-01-31",
    asOf: "2024-05-01T15:00:00+08:00",
  };
  const rows = set(
    fixture().map((r) =>
      r.domain === "capital" ? { ...r, effectiveAt: req.observationDate } : r,
    ),
    "plans",
    { unlockDates: ["2024-04-30"], activeBuybackPlan: false },
  );
  expect(one("CA-S-S2-unlock", rows, req)).toMatchObject({
    points: 4,
    details: { windowEnd: "2024-04-30" },
  });
  expect(
    one(
      "CA-S-S2-unlock",
      set(rows, "plans", {
        unlockDates: ["2024-05-01"],
        activeBuybackPlan: false,
      }),
      req,
    ).points,
  ).toBe(5);
});
it("institution shares, counts, ratios and binary/tier periods are distinct", () => {
  expect(one("CA-S-I1").points).toBe(5);
  expect(one("CA-B-I1").points).toBe(5);
  let rows = set(
    set(fixture(), "shares", 110, "2023-12-31"),
    "shares",
    121,
    "2024-03-31",
  );
  expect(one("CA-S-I1", rows).points).toBe(4);
  rows = set(
    set(rows, "count", 11, "2024-03-31"),
    "floatRatio",
    19,
    "2024-03-31",
  );
  expect(one("CA-S-I1", rows).points).toBe(2);
  expect(one("CA-S-I1-turnover", rows).points).toBe(2);
  expect(
    one("CA-S-I1", set(rows, "shares", 0, "2023-12-31")).points,
  ).toBeNull();
  expect(
    one("CA-S-I1", fixture(), {
      ...request,
      institutionPeriods: ["2024-03-31", "2023-09-30"],
    }).points,
  ).toBeNull();
  expect(
    one("CA-B-I1", fixture(), {
      ...request,
      institutionPeriods: request.institutionPeriods.slice(0, 2),
    }).points,
  ).toBe(5);
});
it.each([
  [[], 0, 0],
  [["general"], 1, 0],
  [["private"], 1, 0],
  [["quality-public"], 2, 3],
  [["foreign"], 2, 3],
  [["quality-public", "foreign"], 3, 3],
])("holder categories %s", (categories, s, b) => {
  const rows = set(fixture(), "holders", {
    classificationVersion: "frozen-1",
    origin: "rule",
    rows: categories.map((category, id) => ({ id: String(id), category })),
  });
  expect(one("CA-S-I2", rows).points).toBe(s);
  expect(one("CA-B-I2", rows).points).toBe(b);
});
it.each([
  "product",
  "management",
  "policy",
  "contract",
  "incentive",
  "forecast",
])(
  "named catalyst %s positive, revoked, expired and specific negative",
  (kind) => {
    const id = `CA-S-N1-${kind === "forecast" ? "forecast50" : kind}`;
    const rows = set(fixture(), "growthEvents", [event(kind)]);
    expect(one(id, rows).points).toBe(4);
    expect(
      one(id, set(rows, "growthEvents", [event(kind, { withdrawn: true })]))
        .points,
    ).toBe(0);
    expect(
      one(
        id,
        set(rows, "growthEvents", [event(kind, { expiresAt: "2024-04-30" })]),
      ).points,
    ).toBe(0);
    const negatives: Record<string, Record<string, unknown>> = {
      product: { landingDate: null },
      management: { role: "other" },
      policy: { industryId: "other" },
      contract: { contractRevenuePct: 9.99 },
      incentive: { effectiveFrom: "2024-05-02" },
      forecast: { forecastLowerPct: 49.99 },
    };
    expect(
      one(id, set(rows, "growthEvents", [event(kind, negatives[kind])])).points,
    ).toBe(0);
  },
);
it("N1 rumor conflicts remain separate, no double counting, human participation cannot become rule-only", () => {
  let rows = set(fixture(), "growthEvents", [event("rumor")]);
  expect(one("CA-S-N1", rows).points).toBe(0);
  expect(one("CA-S-N1-rumor2", rows).points).toBe(2);
  expect(one("CA-B-N1", rows).points).toBe(0);
  rows = set(rows, "growthEvents", [event("product", { origin: "human" })]);
  expect(one("CA-S-N1", rows)).toMatchObject({
    points: 4,
    participation: "human",
  });
  expect(one("CA-B-N1", rows).points).toBe(6);
  expect(
    one("CA-S-N1", set(rows, "growthEvents", [event(), event()])).points,
  ).toBeNull();
  expect(
    one(
      "CA-S-N1",
      set(rows, "growthEvents", [event("product", { origin: "llm" })]),
    ).points,
  ).toBeNull();
});
it("future revisions do not change research hashes; missing publication, wrong units and archive cutoffs refuse", () => {
  const rows = fixture(),
    future = rows.map((r) => ({
      ...r,
      versionId: "revision",
      availableAt: "2024-06-01T00:00:00Z",
      capturedAt: "2024-06-02T00:00:00Z",
      value: null,
    }));
  expect(
    evaluateGrowthFactors(request, [...future, ...rows].reverse()),
  ).toEqual(evaluateGrowthFactors(request, rows));
  expect(
    one(
      "CA-S-C1",
      rows.map((r) =>
        r.field === "quarterlyEps" ? { ...r, availableAt: "" } : r,
      ),
    ).points,
  ).toBeNull();
  expect(
    one(
      "CA-S-C1",
      rows.map((r) => (r.field === "quarterlyEps" ? { ...r, unit: "CNY" } : r)),
    ).points,
  ).toBeNull();
  expect(
    one("CA-S-C1", rows, { ...request, capturedBy: request.asOf }).points,
  ).toBeNull();
  expect(
    one("CA-S-C2", rows, {
      ...request,
      financialPeriods: ["2024-03-31", "2023-09-30"],
    }).points,
  ).toBeNull();
});
it("every named method rejects loss of its consumed required provenance", () => {
  for (const id of Object.keys(growthFactorMethods).filter((id) =>
    ["finance", "capital", "institution", "catalyst"].includes(
      growthFactorMethods[id]!.family,
    ),
  )) {
    const used = one(id).evidence[0]!;
    const rows = fixture().filter(
      (r) =>
        !(
          r.domain === used.domain &&
          r.field === used.field &&
          r.effectiveAt === used.effectiveAt
        ),
    );
    expect(one(id, rows).status, id).toBe("missing");
  }
});
it("reports every required missing field and reuses the adapter for a prior period outside the dossier request", () => {
  const missing = one("SE02", []);
  expect(missing.dataGaps).toHaveLength(7);
  expect(missing.requiredInputs).toHaveLength(7);
  expect(
    one("CA-S-C1", fixture(), { ...request, financialPeriods: ["2024-03-31"] })
      .points,
  ).toBe(8);
  expect(() =>
    one("CA-S-C1", fixture(), { ...request, observationDate: "2024-05-02" }),
  ).toThrow("观察日期");
  expect(
    one(
      "CA-S-I2",
      set(fixture(), "holders", {
        origin: "human",
        classificationVersion: "frozen-human-1",
        rows: [],
      }),
    ).participation,
  ).toBe("human");
});
it("ranks ties deterministically and leaves missing unranked, separating human experiments", () => {
  const r2 = { ...request, symbol: "sz000001" },
    r3 = { ...request, symbol: "sz000002" };
  const rows = [
    ...fixture(),
    ...fixture().map((r) => ({
      ...r,
      entity: r.entity === request.symbol ? r2.symbol : r.entity,
    })),
  ];
  const ranked = rankGrowthFactors([r3, r2, request], rows, "CA-S-C1");
  expect(ranked.map((r) => [r.symbol, r.rank])).toEqual([
    [request.symbol, 1],
    [r2.symbol, 1],
    [r3.symbol, null],
  ]);
  expect(rankGrowthFactors([request, r2, r3], rows, "CA-S-C1")).toEqual(ranked);
  expect(() => rankGrowthFactors([request, request], rows, "CA-S-C1")).toThrow(
    "重复",
  );
  expect(() =>
    rankGrowthFactors(
      [request, { ...r2, asOf: "2024-06-01T00:00:00Z" }],
      rows,
      "CA-S-C1",
    ),
  ).toThrow("相同时点");
});
