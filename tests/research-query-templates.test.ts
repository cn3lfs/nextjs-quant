import { expect, it } from "vitest";
import {
  evaluateQueryTemplate,
  evaluateQueryFactor,
  queryTemplates,
  queryFieldUnits,
  queryPanelSchema,
  queryRebalance,
  queryTemplateAliases,
} from "../src/lib/research-query-templates";
import { researchStrategies } from "../src/lib/research-strategies";
import { evaluateGrowthFactors } from "../src/server/strategies/canslim/research-growth-factors";
import { request } from "./helpers/growth-factor-fixture";

it("compound screens rank only the filtered cohort, and local MACD aliases remain executable", () => {
  const p = fixture("mx-chinext-pe-low50");
  p.universe = Array.from(
    { length: 52 },
    (_, i) => `sz${i < 50 ? "00" : "30"}${String(i).padStart(4, "0")}`,
  );
  p.rows = p.universe.map((id, i) => ({
    id,
    values: {
      board: {
        ...p.rows[0]!.values.board!,
        value: i < 50 ? "main" : "chinext",
      },
      pe: { ...p.rows[0]!.values.pe!, value: i },
    },
  }));
  expect(
    evaluateQueryTemplate("mx-chinext-pe-low50", p, request).selected,
  ).toEqual(p.universe.slice(50));
  for (const alias of queryTemplateAliases)
    expect(researchStrategies[alias.preset]).toBeDefined();
});
it("a fabricated market identity, missing metric context and a wholly missing family stay unavailable", () => {
  const expired = fixture("cb-years3");
  expired.rows[0]!.values.remainingYears!.value = -1;
  expect(evaluateQueryTemplate("cb-years3", expired, request).status).toBe(
    "missing",
  );
  const p = fixture("gf-industry-top2");
  expect(
    evaluateQueryTemplate(
      "gf-industry-top2",
      { ...p, rankingContext: undefined },
      request,
    ).status,
  ).toBe("missing");
  const stock = fixture("astock-return5");
  expect(
    evaluateQueryTemplate(
      "astock-return5",
      {
        ...stock,
        universe: ["hk00700"],
        rows: [{ ...stock.rows[0], id: "hk00700" }],
      },
      request,
    ).status,
  ).toBe("missing");
  stock.rows[0]!.values = {};
  expect(() => evaluateQueryFactor("QT-astock", request, () => stock)).toThrow(
    "missing",
  );
});

it("selection changes schedule next-open intents; missing and foreign screens cannot liquidate stocks", () => {
  const r = evaluateQueryTemplate(
    "astock-return5",
    fixture("astock-return5"),
    request,
  );
  expect(queryRebalance(r, ["sz000001"])).toMatchObject({
    status: "ready",
    entries: [request.symbol],
    exits: ["sz000001"],
    targetWeight: 1,
  });
  expect(
    queryRebalance(evaluateQueryTemplate("astock-return5", {}, request), [
      "sz000001",
    ]),
  ).toMatchObject({ status: "unavailable", exits: [], retained: ["sz000001"] });
  expect(
    queryRebalance(
      evaluateQueryTemplate("cb-premium10", fixture("cb-premium10"), request),
      ["sz000001"],
    ).status,
  ).toBe("unavailable");
});

function fixture(id: string) {
  const t = queryTemplates[id]!;
  return {
    asset: t.asset,
    date: request.observationDate,
    sessionClosedAt: request.asOf,
    sessionEvidence: "synthetic session",
    universeId: "synthetic",
    membershipEvidence: "frozen synthetic universe",
    rankingContext: {
      metric: "annual-roe",
      reportPeriod: "2023-12-31",
      direction: "descending",
      industryVersion: "fixture-1",
      availableAt: request.asOf,
      evidence: "synthetic source ranks",
    },
    universe: [request.symbol],
    rows: [
      {
        id: request.symbol,
        values: Object.fromEntries(
          t.conditions.map((c) => [
            c.field,
            {
              value:
                c.op === "eq"
                  ? c.value
                  : c.op === "lt" || c.op === "lte"
                    ? Number(c.value) - 1
                    : Number(c.value) + 1,
              unit: queryFieldUnits[c.field]!,
              version: "fixture-1",
              evidence: "synthetic-only",
              effectiveAt: request.observationDate,
              availableAt: request.asOf,
              capturedAt: request.asOf,
            },
          ]),
        ),
      },
    ],
  };
}
it.each(Object.keys(queryTemplates).filter((id) => id !== "hk-northbound"))(
  "%s fixed expression positive/negative/equality",
  (id) => {
    const p = fixture(id),
      c = queryTemplates[id]!.conditions[0]!;
    expect(evaluateQueryTemplate(id, p, request)).toMatchObject({
      status: "computed",
      selected: [request.symbol],
      realBacktest: false,
    });
    if (c.op === "top" || c.op === "bottom") return;
    const v = p.rows[0]!.values[c.field]!;
    v.value = c.value;
    expect(evaluateQueryTemplate(id, p, request).selected.length).toBe(
      ["gt", "lt"].includes(c.op) ? 0 : 1,
    );
    v.value =
      c.op === "eq"
        ? typeof c.value === "boolean"
          ? !c.value
          : "different"
        : c.op === "lt" || c.op === "lte"
          ? Number(c.value) + 1
          : Number(c.value) - 1;
    expect(evaluateQueryTemplate(id, p, request).selected).toEqual([]);
  },
);
it("full-universe ranks retain ties and stable ordering; no first-page ranking", () => {
  const p = fixture("sector-top5");
  p.universe = Array.from({ length: 7 }, (_, i) => `sector${i}`);
  p.rows = p.universe.map((id, i) => ({
    id,
    values: {
      dailyReturnPct: {
        ...p.rows[0]!.values.dailyReturnPct!,
        value: i < 4 ? 10 - i : i < 6 ? 3 : 1,
      },
    },
  }));
  const result = evaluateQueryTemplate("sector-top5", p, request);
  expect(result.selected).toEqual(p.universe.slice(0, 6));
  expect(
    evaluateQueryTemplate(
      "sector-top5",
      { ...p, rows: [...p.rows].reverse() },
      request,
    ),
  ).toEqual(result);
  expect(
    evaluateQueryTemplate(
      "sector-top5",
      { ...p, rows: p.rows.slice(0, 3) },
      request,
    ).status,
  ).toBe("missing");
});
it("missing fields, late or revised data, wrong units and incomplete pool cannot become false passes", () => {
  for (const change of [
    { unit: "ratio" },
    { availableAt: "2024-05-02T15:00:00+08:00" },
    { effectiveAt: "2024-04-30" },
    { value: "6" },
  ]) {
    const p = fixture("astock-return5");
    Object.assign(p.rows[0]!.values.dailyReturnPct!, change);
    expect(evaluateQueryTemplate("astock-return5", p, request).status).toBe(
      "missing",
    );
  }
  const p = fixture("astock-return5");
  delete p.rows[0]!.values.dailyReturnPct;
  expect(evaluateQueryTemplate("astock-return5", p, request).status).toBe(
    "missing",
  );
  expect(
    queryPanelSchema.safeParse({ ...p, arbitraryQuery: "buy anything" })
      .success,
  ).toBe(false);
  expect(() => evaluateQueryTemplate("buy anything", p, request)).toThrow(
    "禁止自由文本",
  );
});
it("future markets and contradictory northbound HK example are never HS stock candidates", () => {
  expect(
    evaluateQueryTemplate("cb-premium10", fixture("astock-return5"), request)
      .status,
  ).toBe("not-applicable");
  expect(
    evaluateQueryTemplate("hk-northbound", fixture("hk-northbound"), request),
  ).toMatchObject({
    status: "rule-unresolved",
    stockBacktestEligible: false,
    selected: [],
  });
  for (const id of [
    "cb-premium10",
    "fund-equity",
    "fundcompany-top10",
    "fundmanager-top10",
    "futures-long",
    "hk-tech",
    "us-pe20",
    "etf-largest",
    "sector-top5",
  ])
    expect(
      evaluateQueryTemplate(id, fixture(id), request).stockBacktestEligible,
    ).toBe(false);
});
it("method adapter retains each variant and does not OR independent examples into a buy signal", () => {
  const p = fixture("astock-return5");
  const r = evaluateQueryFactor("QT-astock", request, () => p);
  expect(r.details.buyEligible).toBe(false);
  expect(r.details.variants).toHaveLength(10);
  expect(
    r.details.variants.find((v) => v.id === "astock-return5")?.selected,
  ).toEqual([request.symbol]);
  expect(r.details.variants.find((v) => v.id === "astock-cap100")?.status).toBe(
    "missing",
  );
  const result = evaluateGrowthFactors(
    request,
    [
      {
        domain: "capital",
        entity: request.symbol,
        field: "queryPanel",
        effectiveAt: request.observationDate,
        source: "fixture",
        availableAt: request.asOf,
        capturedAt: request.asOf,
        versionId: "v1",
        availabilityEvidence: {
          kind: "version-publication",
          reference: "fixture",
        },
        unit: "frozen-query-cross-section",
        value: p,
      },
    ],
    ["QT-astock"],
  );
  expect(result.results[0]?.details).toEqual(r.details);
  expect(result.realBacktest.available).toBe(false);
});
