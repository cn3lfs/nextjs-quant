import { expect, it } from "vitest";
import type { AsOfObservation } from "../src/lib/as-of";
import {
  growthHistorySchema,
  growthCrossSectionSchema,
  growthSectorsSchema,
  growthEntrySchema,
  growthSecuritySchema,
  growthEarningsSchema,
} from "../src/lib/as-of-inputs";
import {
  evaluateGrowthFactors,
  growthCombinationRules,
  growthFactorMethods,
  rankGrowthFactors,
} from "../src/server/research-growth-factors";
import {
  request,
  completeFixture,
  alignPrices,
} from "./helpers/growth-factor-fixture";
import { runGrowthFactorResearch } from "../src/server/research-run";
import { researchCanslimCupPoint } from "../src/server/research-canslim-cup";
import { researchCanslimFlatPoint } from "../src/server/research-canslim-flat";
import { researchCanslimSaucerPoint } from "../src/server/research-canslim-saucer";

const set = (rows: AsOfObservation[], field: string, value: unknown) =>
  rows.map((r) => (r.field === field ? { ...r, value } : r));
const value = (rows: AsOfObservation[], field: string) =>
  rows.find((r) => r.field === field)!.value;
const one = (id: string, rows = completeFixture(), req = request) =>
  evaluateGrowthFactors(req, rows, [id]).results[0]!;
function shaped(kind: "flat" | "cup" | "saucer" | "sepa" = "flat") {
  let rows = completeFixture();
  const h = growthHistorySchema.parse(value(rows, "priceHistory"));
  const tail =
    kind === "flat" ? 70 : kind === "cup" ? 121 : kind === "saucer" ? 161 : 371;
  h.bars = h.bars.map((b, index) => {
    const i = index - (h.bars.length - tail);
    if (i < 0) return b;
    if (kind === "flat")
      return {
        ...b,
        open: 97,
        high: i === 69 ? 103 : 100,
        low: 95,
        close: i === 69 ? 102 : 97,
        volume: i < 49 ? 100 : i < 59 ? 45 : i < 69 ? 35 : 70,
      };
    if (kind === "cup") {
      const j = i - 70,
        high =
          j < 0
            ? 95
            : j < 4
              ? 97 + j
              : j <= 43
                ? 80 + 20 * ((j - 23) / 20) ** 2
                : j < 50
                  ? 98
                  : 103;
      return {
        ...b,
        high,
        low: j > 43 && j < 50 ? 95 : high - 1,
        open: high - 0.5,
        close: high - 0.2,
        volume: j <= 43 ? 100 : j < 50 ? 50 - (j - 44) * 5 : 200,
      };
    }
    if (kind === "saucer") {
      const high =
        i < 130 ? 100 : i < 160 ? 93 + 7 * ((i - 144.5) / 14.5) ** 2 : 103;
      return {
        ...b,
        high,
        low: high - 1,
        open: high - 0.5,
        close: high - 0.2,
        volume: i < 130 ? 100 : i < 160 ? 30 : 200,
      };
    }
    let price = 50 + i * 0.08;
    if (i >= 310 && i < 370) {
      const j = i - 310,
        knots = [
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
      const r = knots.findIndex((p) => p[0]! >= j),
        b = knots[r]!,
        a = knots[Math.max(0, r - 1)]!;
      price =
        b[0] === a[0]
          ? b[1]!
          : a[1]! + ((b[1]! - a[1]!) * (j - a[0]!)) / (b[0]! - a[0]!);
    }
    if (i === 370) price = 116;
    return {
      ...b,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: i >= 370 ? 200 : i >= 365 ? 10 : i >= 318 ? 40 : 100,
    };
  });
  rows = set(rows, "priceHistory", h);
  rows = set(rows, "entryPlan", {
    ...growthEntrySchema.parse(value(rows, "entryPlan")),
    pivot: kind === "sepa" ? 114 : 100,
    plannedPrice: h.bars.at(-1)!.close,
    stopPrice: h.bars.at(-1)!.close * 0.925,
  });
  return alignPrices(rows);
}
it("31 new named methods are wired to the existing offline entry and all remain waiting-data", () => {
  expect(Object.keys(growthCombinationRules)).toHaveLength(31);
  expect(Object.keys(growthFactorMethods)).toHaveLength(65);
  const all = runGrowthFactorResearch(
    request,
    completeFixture(),
    Object.keys(growthCombinationRules),
  );
  expect(
    all.results.filter((r) => r.status !== "computed").map((r) => r.methodId),
  ).toEqual(["CA-S-L1-ipo"]);
  expect(all.counts).toEqual({ rule: 30, human: 0, llm: 0 });
  expect(all.realBacktest).toMatchObject({
    available: false,
    coverage: { start: null, end: null },
  });
});
it.each(Object.keys(growthCombinationRules))(
  "%s refuses absent inputs and consumed publication evidence",
  (id) => {
    expect(one(id, [])).toMatchObject({
      status: "missing",
      points: null,
      passed: null,
    });
    const full = one(id),
      used = full.evidence[0]!;
    expect(
      one(
        id,
        completeFixture().filter(
          (r) =>
            !(
              r.field === used.field &&
              r.effectiveAt === used.effectiveAt &&
              r.domain === used.domain
            ),
        ),
      ),
    ).toMatchObject({ status: "missing", passed: null });
  },
);
it.each([
  [95, 9],
  [90, 7],
  [80, 5],
  [70, 2],
  [65, 0],
])("L1 boundary %s gives %s, binary remains separate", (percentile, points) => {
  const rows = completeFixture(),
    p = growthCrossSectionSchema.parse(value(rows, "crossSection"));
  p.rows.forEach((r, i) => {
    r.startPrice = 100;
    r.endPrice = 100 + i;
  });
  p.rows.at(-1)!.endPrice = 100 + percentile / 5;
  expect(one("CA-S-L1", set(rows, "crossSection", p)).points).toBe(points);
  expect(one("CA-B-L1", set(rows, "crossSection", p)).points).toBe(
    percentile >= 80 ? 9 : 0,
  );
  expect(one("CA-E-rs80", set(rows, "crossSection", p)).passed).toBe(
    percentile >= 80,
  );
});
it("RS rejects mixed windows, incomplete universe, unexplained missing endpoints and suspended targets", () => {
  const rows = completeFixture(),
    p = growthCrossSectionSchema.parse(value(rows, "crossSection"));
  for (const v of [
    { ...p, universeId: "today" },
    { ...p, rows: p.rows.slice(1) },
    { ...p, calendar: p.calendar.slice(1), start: p.calendar[1] },
    {
      ...p,
      rows: p.rows.map((r, i) => (i === 0 ? { ...r, endPrice: null } : r)),
    },
    {
      ...p,
      rows: p.rows.map((r) =>
        r.symbol === request.symbol ? { ...r, suspended: true } : r,
      ),
    },
  ])
    expect(one("CA-S-L1", set(rows, "crossSection", v)).status).toBe("missing");
  p.rows[0]!.suspended = true;
  p.rows[0]!.endPrice = null;
  expect(one("CA-S-L1", set(rows, "crossSection", p)).details).toMatchObject({
    eligibleCount: 20,
    excludedCount: 1,
  });
});
it("IPO uses one shared listing window and records reduced confidence", () => {
  const rows = completeFixture(),
    p = growthCrossSectionSchema.parse(value(rows, "crossSection"));
  p.calendar = p.calendar.slice(-20);
  p.start = p.calendar[0]!;
  p.rows.at(-1)!.listingDate = p.start;
  expect(one("CA-S-L1-ipo", set(rows, "crossSection", p))).toMatchObject({
    points: 9,
    details: { confidence: "reduced" },
  });
  expect(one("CA-S-L1", set(rows, "crossSection", p)).status).toBe("missing");
  p.rows.at(-1)!.listingDate = p.calendar[1]!;
  expect(one("CA-S-L1-ipo", set(rows, "crossSection", p)).status).toBe(
    "missing",
  );
});
it.each([
  [1, 6],
  [2, 5],
  [3, 5],
  [4, 3],
  [10, 3],
  [11, 0],
])("sector member rank %s gives %s", (rank, points) => {
  const rows = completeFixture(),
    p = growthSectorsSchema.parse(value(rows, "sectors"));
  p.rows[0]!.members = Array.from({ length: rank }, (_, i) => ({
    symbol:
      i === rank - 1 ? request.symbol : `sz${String(i + 1).padStart(6, "0")}`,
    startPrice: 100,
    endPrice: i === rank - 1 ? 120 : 130,
  }));
  expect(one("CA-S-L2", set(rows, "sectors", p)).points).toBe(points);
  expect(one("CA-B-L2", set(rows, "sectors", p)).points).toBe(
    rank <= 3 ? 6 : 0,
  );
  p.rows[0]!.endPrice = 98;
  expect(one("CA-S-L2", set(rows, "sectors", p)).points).toBe(
    Math.min(points, 3),
  );
});
it("multiple sectors select the strongest by sector return, not highest available stock score", () => {
  const rows = completeFixture(),
    p = growthSectorsSchema.parse(value(rows, "sectors"));
  p.rows[1]!.members.push({
    symbol: request.symbol,
    startPrice: 100,
    endPrice: 140,
  });
  p.rows[0]!.members[1]!.endPrice = 140;
  expect(one("CA-S-L2", set(rows, "sectors", p))).toMatchObject({
    points: 5,
    details: { sectorId: "strong", rank: 2 },
  });
});
it("SE01 joins real VCP geometry to finance and RS; failing either gate cannot pass", () => {
  const rows = shaped("sepa"),
    positive = one("SE01", rows);
  expect(positive).toMatchObject({
    passed: true,
    details: { strictPass: true, flexiblePass: true, pattern: { score: 11 } },
  });
  expect(one("SE01", set(rows, "quarterlyProfitGrowth", 0)).passed).toBe(false);
  const p = growthCrossSectionSchema.parse(value(rows, "crossSection"));
  p.rows.slice(0, 4).forEach((r) => {
    r.endPrice = r.startPrice! * 2;
  });
  expect(one("SE01", set(rows, "crossSection", p)).passed).toBe(false);
  const h = growthHistorySchema.parse(value(rows, "priceHistory"));
  h.bars.at(-1)!.volume = 1;
  expect(one("SE01", set(rows, "priceHistory", h)).passed).toBe(false);
});
it.each(["CA01", "CA02", "CA03"])(
  "%s uses the existing shape and full 17 factors, rejects finance loss and unsafe sizing",
  (id) => {
    const rows = shaped(
        id === "CA01" ? "cup" : id === "CA02" ? "flat" : "saucer",
      ),
      h = growthHistorySchema.parse(value(rows, "priceHistory"));
    const geometry =
      id === "CA01"
        ? researchCanslimCupPoint("U", h.bars)
        : id === "CA02"
          ? researchCanslimFlatPoint(h.bars)
          : researchCanslimSaucerPoint("U", h.bars);
    expect(geometry.entry).toBe(true);
    expect(one(id, rows)).toMatchObject({ status: "computed", passed: true });
    const plan = growthEntrySchema.parse(value(rows, "entryPlan"));
    plan.positionPct = 25;
    expect(one(id, set(rows, "entryPlan", plan)).passed).toBe(false);
    expect(
      one(
        id,
        rows.filter((r) => r.field !== "annualRoe"),
      ),
    ).toMatchObject({ status: "missing", passed: null });
  },
);
it.each([
  "CA-T-sector",
  "CA-T-smallcap",
  "CA-T-earnings-window",
  "CA-E-ipo60-risk",
  "CA-S-ipo-year-confidence",
])("%s is an actual shape filter or weight experiment", (id) => {
  expect(one(id, shaped()).passed).toBe(true);
  expect(one(id, completeFixture()).passed).toBe(false);
});
it("small cap, IPO 60 and natural year have independent inclusive boundaries", () => {
  let rows = shaped();
  const s = growthSecuritySchema.parse(value(rows, "securityState"));
  s.speculativeTurnoverPct = 10;
  rows = set(set(rows, "securityState", s), "floatMarketCap", 99e8);
  expect(one("CA-T-smallcap", rows)).toMatchObject({
    points: 0.5,
    details: { weight: 0.5 },
  });
  expect(one("CA-T-smallcap", set(rows, "floatMarketCap", 100e8)).points).toBe(
    1,
  );
  s.listingTradingDays = 59;
  expect(one("CA-E-ipo60-risk", set(rows, "securityState", s)).points).toBe(
    0.5,
  );
  s.listingTradingDays = 60;
  expect(one("CA-E-ipo60-risk", set(rows, "securityState", s)).points).toBe(1);
  s.listingDate = "2023-05-02";
  expect(
    one("CA-S-ipo-year-confidence", set(rows, "securityState", s)).passed,
  ).toBe(false);
  s.listingDate = "2023-05-01";
  expect(
    one("CA-S-ipo-year-confidence", set(rows, "securityState", s)).passed,
  ).toBe(true);
});
it("query requires RS, frozen 20/60/120 order and strict market cap > 5 billion CNY", () => {
  const rows = completeFixture(),
    s = growthSecuritySchema.parse(value(rows, "securityState"));
  expect(one("CA-L-query-screen", rows).passed).toBe(true);
  s.totalMarketCap = 50e8;
  expect(one("CA-L-query-screen", set(rows, "securityState", s)).passed).toBe(
    false,
  );
});
it.each(["CA-E-five", "SE-E-five", "CA-E-five-soft"])(
  "%s keeps strict price equality and volume inclusive",
  (id) => {
    const rows = shaped(),
      h = growthHistorySchema.parse(value(rows, "priceHistory"));
    expect(one(id, rows).passed).toBe(true);
    const last = h.bars.at(-1)!;
    last.volume =
      h.bars.slice(-21, -1).reduce((s, b) => s + b.volume / 20, 0) * 1.5;
    expect(one(id, set(rows, "priceHistory", h)).passed).toBe(true);
    last.close = 101;
    const failed = one(id, set(rows, "priceHistory", h));
    expect(failed).toMatchObject({
      passed: false,
      details: { classification: id === "CA-E-five-soft" ? "WATCH" : "PASS" },
    });
  },
);
it("five steps allow market OR catalyst but preserve unknown and human origin", () => {
  const rows = shaped(),
    h = growthHistorySchema.parse(value(rows, "priceHistory"));
  h.benchmarkBars.at(-1)!.close = 1;
  h.benchmarkBars.at(-1)!.low = 1;
  const weak = set(rows, "priceHistory", h);
  expect(one("CA-E-five", weak).passed).toBe(true);
  expect(one("CA-E-five", set(weak, "entryEvents", []))).toMatchObject({
    passed: false,
    details: { classification: "WATCH" },
  });
  expect(
    one(
      "CA-E-five",
      weak.filter((r) => r.field !== "entryEvents"),
    ).status,
  ).toBe("missing");
  const events = value(rows, "entryEvents") as Record<string, unknown>[];
  expect(
    one(
      "CA-E-five",
      set(
        rows,
        "entryEvents",
        events.map((e) => ({ ...e, origin: "human", withdrawn: true })),
      ),
    ),
  ).toMatchObject({ participation: "human" });
});
it("catalysts expire after 20 calendar days and cannot launder LLM origin", () => {
  const rows = completeFixture(),
    events = value(rows, "entryEvents") as Record<string, unknown>[];
  for (const [date, pass] of [
    ["2024-04-11", true],
    ["2024-04-10", false],
  ] as const)
    expect(
      one(
        "CA-E-catalyst",
        set(
          rows,
          "entryEvents",
          events.map((e) => ({ ...e, date })),
        ),
      ).passed,
    ).toBe(pass);
  expect(
    one(
      "CA-E-catalyst",
      set(
        rows,
        "entryEvents",
        events.map((e) => ({ ...e, origin: "llm" })),
      ),
    ).status,
  ).toBe("missing");
});
it("earnings windows count frozen sessions with equality and distinct before/after paths", () => {
  const rows = shaped(),
    e = growthEarningsSchema.parse(value(rows, "earningsWindow")),
    i = e.calendar.indexOf(request.observationDate);
  e.scheduledDate = e.calendar[i + 5]!;
  expect(one("CA-E-earnings5", set(rows, "earningsWindow", e)).passed).toBe(
    false,
  );
  expect(
    one("CA-T-earnings-window", set(rows, "earningsWindow", e)).points,
  ).toBe(0.5);
  e.scheduledDate = e.calendar[i + 6]!;
  expect(one("CA-E-earnings5", set(rows, "earningsWindow", e)).passed).toBe(
    true,
  );
  for (const [after, pass] of [
    [5, false],
    [6, true],
  ] as const) {
    e.lastReportedDate = e.calendar[i - after]!;
    e.reportAvailableAt = `${e.lastReportedDate}T10:00:00+08:00`;
    e.consensusAvailableAt = `${e.calendar[i - after - 1]}T10:00:00+08:00`;
    expect(one("CA-E-reported5", set(rows, "earningsWindow", e)).passed).toBe(
      pass,
    );
  }
  e.consensusAvailableAt = e.reportAvailableAt;
  expect(one("SE-E-earnings13", set(rows, "earningsWindow", e)).status).toBe(
    "missing",
  );
});
it("earnings surprise entry needs 1..3 sessions, ex-ante consensus and intact VCP", () => {
  const rows = shaped("sepa"),
    e = growthEarningsSchema.parse(value(rows, "earningsWindow")),
    i = e.calendar.indexOf(request.observationDate);
  for (const after of [0, 1, 3, 4]) {
    e.lastReportedDate = e.calendar[i - after]!;
    e.reportAvailableAt = `${e.lastReportedDate}T10:00:00+08:00`;
    e.consensusAvailableAt = `${e.calendar[i - after - 1]}T10:00:00+08:00`;
    expect(one("SE-E-earnings13", set(rows, "earningsWindow", e)).passed).toBe(
      after >= 1 && after <= 3,
    );
  }
  e.actualEps = e.consensusEps;
  expect(one("SE-E-earnings13", set(rows, "earningsWindow", e)).passed).toBe(
    false,
  );
});
it("exclusions use historical identity and explicit suspension threshold", () => {
  const rows = completeFixture(),
    s = growthSecuritySchema.parse(value(rows, "securityState"));
  expect(one("SE-E-exclusions", rows).passed).toBe(true);
  for (const change of [
    { st: true },
    { delistingRisk: true },
    { exchange: "BJ" },
    { listingTradingDays: 1 },
    { resumedAfterSuspensionDays: 20 },
  ])
    expect(
      one("SE-E-exclusions", set(rows, "securityState", { ...s, ...change }))
        .passed,
    ).toBe(false);
  expect(
    one(
      "SE-E-exclusions",
      set(rows, "securityState", { ...s, resumedAfterSuspensionDays: 19 }),
    ).passed,
  ).toBe(true);
});
it("full scores expose 114 fixed capacity, grades, weighted factors and missing zero contribution", () => {
  const rows = completeFixture(),
    r = one("CA-S-total-absolute", rows),
    d = r.details;
  expect(d.maxPoints).toBe(114);
  expect(d.computedCapacity).toBe(114);
  expect(d.missingIds).toEqual([]);
  expect(one("CA07", rows).passed).toBe(true);
  const values = d.values as Record<string, number>;
  expect(Object.keys(values)).toHaveLength(17);
  expect(r.points).toBe(Object.values(values).reduce((s, v) => s + v, 0));
  const groups = d.groups as Record<string, number>;
  expect(one("CA-S-weighted-ratio", rows).points).toBeCloseTo(
    groups.C! +
      groups.A! +
      groups.N! +
      (groups.S! / 13) * 15 +
      groups.L! +
      (groups.I! / 8) * 5 +
      (groups.M! / 23) * 10,
  );
  expect(one("CA-S-total-ratio", rows).details.grade).toBe(
    r.points! >= 0.8 * 114 ? 3 : r.points! >= 0.6 * 114 ? 2 : 1,
  );
  const weak = set(
    set(set(rows, "quarterlyEps", 1), "quarterlyEpsGrowth", 0),
    "quarterlyRevenueGrowth",
    0,
  );
  expect(one("CA-S-C-downgrade", weak).details.grade).toBe(
    Math.max(0, (one("CA-S-total-absolute", weak).details.grade as number) - 1),
  );
  const missing = rows.filter((r) => r.field !== "annualRoe"),
    m = one("CA-S-missing", missing);
  expect(m).toMatchObject({
    status: "missing",
    passed: null,
    details: { computedCapacity: 107, missingIds: ["A2"] },
  });
  expect(m.details.displayedZeroContributionTotal).toBe(r.points! - 7);
  expect(
    rankGrowthFactors([request], missing, "CA-S-missing")[0]!.rank,
  ).toBeNull();
});
it("limit-up low-volume exception is named 6-point experiment, never permission to chase", () => {
  const rows = completeFixture(),
    s = growthSecuritySchema.parse(value(rows, "securityState")),
    h = growthHistorySchema.parse(value(rows, "priceHistory"));
  expect(one("CA-S-S1-limitup", rows).points).toBe(0);
  s.limitUpPrice = h.bars.at(-1)!.close;
  expect(one("CA-S-S1-limitup", set(rows, "securityState", s))).toMatchObject({
    points: 6,
    passed: false,
    details: { engineeringReplacementPoints: 6 },
  });
});
it("new raw panels reject invalid units, future contained dates and pre-close requests", () => {
  const rows = completeFixture(),
    h = growthHistorySchema.parse(value(rows, "priceHistory"));
  expect(
    one("CA-E-five", rows, { ...request, asOf: "2024-05-01T14:30:00+08:00" })
      .status,
  ).toBe("missing");
  h.calendar[h.calendar.length - 1] = "2024-05-02";
  h.bars.at(-1)!.date = "2024-05-02";
  h.benchmarkBars.at(-1)!.date = "2024-05-02";
  expect(one("CA-E-five", set(rows, "priceHistory", h)).status).toBe("missing");
  expect(
    one(
      "CA-S-L1",
      rows.map((r) => (r.field === "crossSection" ? { ...r, unit: "%" } : r)),
    ).status,
  ).toBe("missing");
});

it("absolute 93/70/47 and fixed-capacity ratio thresholds remain separate", () => {
  const rows = completeFixture();
  const eps = rows.map((r) =>
    r.field === "quarterlyEps" && r.effectiveAt === "2024-03-31"
      ? { ...r, value: 1.2 }
      : r,
  );
  expect(one("CA-S-total-absolute", eps)).toMatchObject({
    points: 93,
    details: { grade: 3 },
  });
  const sector = growthSectorsSchema.parse(value(eps, "sectors"));
  sector.rows[0]!.members[1]!.endPrice = 130;
  const ninetyTwo = set(eps, "sectors", sector);
  expect(one("CA-S-total-absolute", ninetyTwo)).toMatchObject({
    points: 92,
    details: { grade: 2 },
  });
  expect(one("CA-S-total-ratio", ninetyTwo)).toMatchObject({
    points: 92,
    details: { grade: 3 },
  });
  let seventy = set(
    set(
      set(set(rows, "quarterlyEps", 1), "quarterlyEpsGrowth", 0),
      "quarterlyRevenueGrowth",
      0,
    ),
    "annualEps",
    1,
  );
  seventy = seventy.map((r) =>
    r.field === "quarterlyEpsGrowth"
      ? {
          ...r,
          value:
            r.effectiveAt === "2024-03-31"
              ? 0
              : r.effectiveAt === "2023-12-31"
                ? 10
                : 20,
        }
      : r,
  );
  expect(one("CA07", seventy)).toMatchObject({
    points: 70,
    passed: true,
    details: { grade: 2 },
  });
  expect(one("CA07", set(seventy, "annualCashPerShare", 0))).toMatchObject({
    points: 65,
    passed: false,
  });
  seventy = set(
    set(set(seventy, "annualRoe", 0), "shares", 100),
    "floatMarketCap",
    1e8,
  );
  const holders = value(seventy, "holders") as Record<string, unknown>;
  seventy = set(seventy, "holders", { ...holders, rows: [] });
  const weak = growthSectorsSchema.parse(value(seventy, "sectors"));
  weak.rows[0]!.endPrice = 98;
  const fortySeven = set(seventy, "sectors", weak);
  expect(one("CA-S-total-absolute", fortySeven)).toMatchObject({
    points: 47,
    passed: false,
    details: { grade: 1 },
  });
  expect(
    one("CA-S-total-absolute", set(fortySeven, "annualCashPerShare", 0)),
  ).toMatchObject({ points: 42, details: { grade: 0 } });
});
it("missing all price factors still displays known financial contributions without grading", () => {
  const rows = completeFixture().filter((r) => r.field !== "priceHistory");
  const r = one("CA-S-missing", rows);
  expect(r).toMatchObject({
    status: "missing",
    points: null,
    passed: null,
    details: {
      grade: null,
      candidatePositionCapPct: 0,
      missingIds: ["N2", "S1", "M1", "M2", "M3"],
    },
  });
  expect(r.details.displayedZeroContributionTotal).toBeGreaterThan(0);
  expect(one("CA-S-missing", [])).toMatchObject({
    details: {
      computedCapacity: 0,
      displayedZeroContributionTotal: 0,
      grade: null,
    },
  });
});
it("closing-panel disclosure cannot predate the closing price", () => {
  for (const [id, field] of [
    ["CA-S-L1", "crossSection"],
    ["CA-S-L2", "sectors"],
    ["CA-E-five", "priceHistory"],
  ]) {
    const rows = completeFixture().map((r) =>
      r.field === field
        ? { ...r, availableAt: "2024-05-01T14:59:59+08:00" }
        : r,
    );
    expect(one(id!, rows)).toMatchObject({ status: "missing", passed: null });
  }
});

it("full combinations reject inconsistent stock prices or windows across frozen panels", () => {
  const rows = shaped("sepa"),
    panel = growthCrossSectionSchema.parse(value(rows, "crossSection"));
  panel.rows.at(-1)!.endPrice = panel.rows.at(-1)!.endPrice! + 1;
  expect(one("SE01", set(rows, "crossSection", panel))).toMatchObject({
    status: "missing",
    passed: null,
  });
  const full = completeFixture(),
    sectors = growthSectorsSchema.parse(value(full, "sectors"));
  sectors.rows[0]!.members[0]!.endPrice += 1;
  expect(one("CA07", set(full, "sectors", sectors))).toMatchObject({
    status: "missing",
    passed: null,
  });
  expect(one("CA-S-missing", set(full, "sectors", sectors))).toMatchObject({
    status: "missing",
    details: { missingIds: ["L2"], grade: null },
  });
});
