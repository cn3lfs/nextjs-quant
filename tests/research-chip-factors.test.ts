import { expect, it } from "vitest";
import { evaluateGrowthFactors } from "../src/server/research-growth-factors";
import {
  chipFactorRules,
  chipHistorySchema,
  evaluateChipFactor,
} from "../src/lib/research-chip-factors";
import { request } from "./helpers/growth-factor-fixture";

function panel() {
  const calendar = Array.from({ length: 21 }, (_, i) =>
    new Date(Date.UTC(2024, 3, i + 11)).toISOString().slice(0, 10),
  );
  return {
    symbol: request.symbol,
    source: "synthetic-only",
    modelVersion: "fixed-1",
    comparabilityEvidence: "synthetic same-model/no-action",
    calendar,
    rows: calendar.map((date, i) => ({
      date,
      availableAt: `${date}T15:00:00+08:00`,
      capturedAt: `${date}T15:00:00+08:00`,
      chipAvgCost: 10 + i / 10,
      chipConcentration70: 50 - i,
      chipConcentration90: 70 - i,
      chipProfitRate: 40 + i,
    })),
  };
}
function one(id: string, p = panel(), extra: Record<string, unknown> = {}) {
  return evaluateGrowthFactors(
    request,
    [
      {
        domain: "capital",
        entity: request.symbol,
        field: "chipHistory",
        effectiveAt: request.observationDate,
        source: "synthetic",
        availableAt: request.asOf,
        capturedAt: request.asOf,
        versionId: "fixture-1",
        availabilityEvidence: {
          kind: "version-publication",
          reference: "fixture-only",
        },
        unit: "chip-CNY-percent-panel",
        value: p,
        ...extra,
      },
    ],
    [id],
  );
}
it.each(Object.keys(chipFactorRules))(
  "%s positive, reversed and equality boundaries",
  (id) => {
    expect(one(id).results[0]).toMatchObject({
      status: "computed",
      passed: true,
    });
    const p = panel();
    const first = p.rows[0]!,
      last = p.rows.at(-1)!;
    Object.assign(last, {
      chipAvgCost: first.chipAvgCost,
      chipConcentration70: first.chipConcentration70,
      chipConcentration90: first.chipConcentration90,
      chipProfitRate: first.chipProfitRate,
    });
    expect(one(id, p).results[0]).toMatchObject({
      status: "computed",
      passed: false,
    });
    Object.assign(last, {
      chipAvgCost: 9,
      chipConcentration70: 60,
      chipConcentration90: 80,
      chipProfitRate: 30,
    });
    expect(one(id, p).results[0]?.passed).toBe(false);
  },
);
it("concentration requires both bands; percent changes and relative cost are distinct", () => {
  const p = panel();
  p.rows.at(-1)!.chipConcentration90 = 71;
  expect(one("WP01-concentration", p).results[0]?.passed).toBe(false);
  expect(one("WP01-profit").results[0]?.details).toMatchObject({
    changes: { profitPoints: 20 },
  });
  expect(
    (one("WP01-cost").results[0]?.details.changes as { costPct: number })
      .costPct,
  ).toBeCloseTo(20);
});
it("missing/late evidence, mismatched identity, incomplete history and invalid units remain missing", () => {
  for (const extra of [
    { availableAt: null },
    { availableAt: "2024-05-02T15:00:00+08:00" },
    { unit: "ratio" },
  ])
    expect(one("WP01-cost", panel(), extra).results[0]?.status).toBe("missing");
  for (const mutate of [
    (p: ReturnType<typeof panel>) => {
      p.symbol = "sz000001";
    },
    (p: ReturnType<typeof panel>) => {
      p.rows.pop();
    },
    (p: ReturnType<typeof panel>) => {
      p.rows[0]!.chipProfitRate = 101;
    },
    (p: ReturnType<typeof panel>) => {
      p.rows[0]!.availableAt = "2024-05-02T15:00:00+08:00";
      p.rows[0]!.capturedAt = "2024-05-02T15:00:00+08:00";
    },
    (p: ReturnType<typeof panel>) => {
      p.rows[0]!.availableAt = `${p.rows[0]!.date}T14:59:00+08:00`;
    },
  ]) {
    const p = panel();
    mutate(p);
    expect(one("WP01-cost", p).results[0]?.status).toBe("missing");
  }
});
it("model provenance and same baseline policy are retained without claiming live results", () => {
  const result = one("WP01-cost");
  expect(result.realBacktest.available).toBe(false);
  expect(result.results[0]?.details).toMatchObject({
    modelVersion: "fixed-1",
    combination: {
      baseline: "dual-breakout",
      entry: "next-legal-open",
      exit: "baseline-unchanged",
    },
  });
  expect(
    chipHistorySchema.safeParse({ ...panel(), arbitraryQuery: "buy" }).success,
  ).toBe(false);
  expect(() => evaluateChipFactor("unknown", request, () => panel())).toThrow(
    "未知筹码方法",
  );
});
