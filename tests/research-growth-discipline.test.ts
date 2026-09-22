import { expect, it } from "vitest";
import {
  evaluateGrowthFactors,
  growthDisciplineRules,
} from "../src/server/strategies/canslim/research-growth-factors";
import { request, growthShapedFixture } from "./helpers/growth-factor-fixture";
import {
  asOfInputDefinitions,
  growthEntrySchema,
} from "../src/lib/as-of-inputs";
import type { AsOfObservation } from "../src/lib/as-of";
const set = (rows: AsOfObservation[], field: string, value: unknown) =>
  rows.map((r) => (r.field === field ? { ...r, value } : r));
function fixture(kind: "flat" | "sepa" = "flat") {
  const rows = growthShapedFixture(kind).filter(
    (r) => !["kellyTraining", "softOverride"].includes(r.field),
  );
  for (const [field, value] of Object.entries({
    kellyTraining: {
      start: "2023-01-01",
      cutoff: "2024-04-30",
      wyckoffTarget: 150,
      trades: Array.from({ length: 30 }, (_, i) => ({
        event: {
          symbol: request.symbol,
          key: String(i),
          observedDate: "2023-02-01",
          partition: "development",
        },
        entryDate: "2023-02-02",
        exitDate: "2023-02-03",
        profit: i < 18 ? 20 : -10,
        remainingQuantity: 0,
      })),
    },
    softOverride: {
      version: "fixed-1",
      frozenAt: "2024-04-30T15:00:00+08:00",
      origin: "rule",
      evidence: "synthetic",
      allowedWeakness: "total-score-65-to-69",
    },
  }))
    rows.push({
      ...rows.find((r) => r.field === "entryPlan")!,
      field,
      value,
      availableAt: "2024-04-30T06:00:00Z",
      capturedAt: "2024-04-30T06:00:00Z",
      unit: asOfInputDefinitions.capital[field]!.unit,
    });
  return rows;
}
const one = (id: string, rows: unknown = fixture()) =>
  evaluateGrowthFactors(request, rows, [id]).results[0]!;
it.each(Object.keys(growthDisciplineRules))(
  "%s is registered, executable, and refuses absent publication data",
  (id) => {
    expect(one(id, [])).toMatchObject({ status: "missing", passed: null });
    const r = one(id, fixture(id.startsWith("SE-") ? "sepa" : "flat"));
    expect(r.status, JSON.stringify(r.dataGaps)).toBe("computed");
    expect(r.requiredInputs.length).toBeGreaterThan(1);
    expect(
      one(
        id,
        fixture().map((r) => ({ ...r, availableAt: null })),
      ),
    ).toMatchObject({ status: "missing", passed: null });
  },
);
it.each([
  "CA-E-exclusions",
  "CA-E-checklist70",
  "CA-E-soft-overrides",
  "CA-K-kelly25",
  "CA-K-quality",
])("%s respects hard stop and ST veto", (id) => {
  const rows = fixture();
  expect(one(id, rows).passed).toBe(true);
  const plan = growthEntrySchema.parse(
    rows.find((r) => r.field === "entryPlan")!.value,
  );
  expect(
    one(id, set(rows, "entryPlan", { ...plan, stopPrice: plan.plannedPrice }))
      .passed,
  ).toBe(false);
  expect(
    one(
      id,
      set(rows, "securityState", {
        ...(rows.find((r) => r.field === "securityState")!.value as object),
        st: true,
      }),
    ).passed,
  ).toBe(false);
});
it.each([
  "CA-K-kelly25",
  "SE-K-kelly",
  "SE-K-quality",
  "CA-K-quality",
  "WY-K-quality",
  "SE-K-script-quality",
])(
  "%s inherits B2 closed-development admission even for source probability",
  (id) => {
    const rows = fixture(id.startsWith("SE-") ? "sepa" : "flat");
    const training = rows.find((r) => r.field === "kellyTraining")!.value as {
      trades: object[];
    };
    for (const trades of [
      training.trades.slice(0, 29),
      [...training.trades, training.trades[0]],
      training.trades.map((t) => ({ ...t, remainingQuantity: 1 })),
      training.trades.map((t) => ({ ...t, exitDate: "2024-04-30" })),
    ]) {
      const r = one(id, set(rows, "kellyTraining", { ...training, trades }));
      expect(r.status).toBe("missing");
      expect(r.passed).toBeNull();
    }
    const r = one(id, rows);
    expect(r.details.empiricalWinRate).toBe(0.6);
    expect(r.details.probabilityProvenance).toBe(
      id.includes("quality")
        ? "source-quality-assumption"
        : "development-closed",
    );
  },
);
it("half Kelly is bounded by risk and cap, with a separately named pivot target", () => {
  const ca = one("CA-K-kelly25");
  expect(ca.details.weight).toBeCloseTo(0.2);
  expect(ca.details.payoff).toBeCloseTo(20 / 7.5);
  const se = one("SE-K-kelly", fixture("sepa"));
  expect(se.details.pivotTargetVariant).toMatchObject({
    name: "pivot-plus30pct",
  });
  expect(se.details.target).toBeCloseTo(116 * 1.3);
});
it("SEPA all-five checklist treats surprise as required, unlike the four-core parent", () => {
  const rows = fixture("sepa");
  expect(one("SE-E-checklist", rows).passed).toBe(true);
  const e = rows.find((r) => r.field === "earningsWindow")!.value as object;
  const no = set(rows, "earningsWindow", {
    ...e,
    actualEps: 1,
    consensusEps: 1,
  });
  expect(one("SE-E-checklist", no).passed).toBe(false);
  expect(one("SE-K-quality", no).passed).toBe(true);
});
it("soft overrides must be frozen, remain separate from missing evidence, and cannot expand permissions", () => {
  const rows = fixture(),
    policy = rows.find((r) => r.field === "softOverride")!.value as object;
  expect(
    one(
      "CA-E-soft-overrides",
      set(rows, "softOverride", { ...policy, frozenAt: request.asOf }),
    ).status,
  ).toBe("missing");
  expect(
    one(
      "CA-E-soft-overrides",
      set(rows, "softOverride", { ...policy, allowedWeakness: "risk" }),
    ).status,
  ).toBe("missing");
  expect(
    one(
      "CA-E-soft-overrides",
      rows.filter((r) => r.field !== "annualEps"),
    ).status,
  ).toBe("missing");
});
it("only precommitted total-score weakness 65..69 can pass the soft version", () => {
  let rows = fixture();
  rows = rows.map((r) =>
    r.field === "quarterlyEps" && r.effectiveAt === "2024-03-31"
      ? { ...r, value: 0 }
      : r,
  );
  rows = rows.map((r) =>
    r.field === "quarterlyEpsGrowth"
      ? {
          ...r,
          value:
            r.effectiveAt === "2024-03-31"
              ? -10
              : r.effectiveAt === "2023-12-31"
                ? 0
                : 10,
        }
      : r,
  );
  for (const field of [
    "quarterlyRevenueGrowth",
    "quarterlyProfitGrowth",
    "annualRoe",
    "annualCashPerShare",
  ])
    rows = set(rows, field, 0);
  const total = one("CA-S-total-absolute", rows);
  expect(total.points).toBe(66);
  expect(one("CA-E-checklist70", rows).passed).toBe(false);
  expect(one("CA-E-soft-overrides", rows).passed).toBe(true);
  expect(
    one(
      "CA-E-soft-overrides",
      rows.filter((r) => r.field !== "annualCashPerShare"),
    ).status,
  ).toBe("missing");
});
it("SEPA script strong quality requires twice volume separately from the entry mapping", () => {
  const rows = fixture("sepa");
  const base = one("SE-K-quality", rows);
  expect(base.details.assumptionParameterP).toBe(0.55);
  const history = rows.find((r) => r.field === "priceHistory")!.value as {
    bars: { volume: number }[];
  };
  const avg = history.bars
    .slice(-21, -1)
    .reduce((s, b) => s + b.volume / 20, 0);
  const lower = structuredClone(history);
  lower.bars.at(-1)!.volume = avg * 1.75;
  expect(
    one("SE-K-quality", set(rows, "priceHistory", lower)).details
      .assumptionParameterP,
  ).toBe(0.55);
  expect(
    one("SE-K-script-quality", set(rows, "priceHistory", lower)).details
      .assumptionParameterP,
  ).toBe(0.4);
  lower.bars.at(-1)!.volume = avg * 2;
  expect(
    one("SE-K-script-quality", set(rows, "priceHistory", lower)).details
      .assumptionParameterP,
  ).toBe(0.55);
});
it("WY single confirmed JAC/SOS uses structural evidence, not a supplied quality tag", () => {
  const rows = fixture();
  const history = structuredClone(
    rows.find((r) => r.field === "priceHistory")!.value,
  ) as {
    bars: {
      date: string;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
      amount: number;
    }[];
  };
  const anchors = [
    [0, 80],
    [40, 95],
    [50, 100],
    [60, 104],
    [65, 96],
    [70, 104],
    [75, 96],
    [80, 104],
    [85, 96],
    [89, 102],
  ];
  history.bars = history.bars.map((b, index) => {
    const i = index - (history.bars.length - 92);
    if (i < 0) return b;
    if (i >= 90)
      return {
        ...b,
        open: i === 90 ? 102 : 105.2,
        low: i === 90 ? 102 : 104.5,
        high: i === 90 ? 106 : 105.8,
        close: i === 90 ? 105.5 : 105.6,
        volume: i === 90 ? 150 : 100,
      };
    const at = anchors.findIndex((a) => a[0]! >= i),
      a = anchors[Math.max(0, at - 1)]!,
      c = anchors[at]!;
    const close =
      a[1]! + ((c[1]! - a[1]!) * (i - a[0]!)) / Math.max(1, c[0]! - a[0]!);
    return {
      ...b,
      open: close - 0.1,
      low: close - 0.5,
      high: close + 0.5,
      close,
      volume: 100,
    };
  });
  const plan = growthEntrySchema.parse(
    rows.find((r) => r.field === "entryPlan")!.value,
  );
  const actual = set(set(rows, "priceHistory", history), "entryPlan", {
    ...plan,
    plannedPrice: 105.6,
    stopPrice: 100,
  });
  const result = one("WY-K-quality", actual);
  expect(result.passed).toBe(true);
  expect(result.details.assumptionParameterP).toBe(0.48);
  expect(result.details.sameStructure).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ state: "confirmed", kind: "jac" }),
    ]),
  );
  const flat = structuredClone(history);
  flat.bars.at(-1)!.low = 100;
  flat.bars.at(-1)!.close = 102;
  expect(one("WY-K-quality", set(actual, "priceHistory", flat)).passed).toBe(
    false,
  );
});
it("Kelly invalid stop/target rejects without emitting Infinity or a fabricated payoff", () => {
  const rows = fixture(),
    plan = growthEntrySchema.parse(
      rows.find((r) => r.field === "entryPlan")!.value,
    );
  const r = one(
    "CA-K-kelly25",
    set(rows, "entryPlan", { ...plan, stopPrice: plan.plannedPrice }),
  );
  expect(r).toMatchObject({
    status: "computed",
    passed: false,
    details: { payoff: null, halfKellyWeight: null, weight: 0 },
  });
  expect(JSON.stringify(r)).not.toContain("Infinity");
});
