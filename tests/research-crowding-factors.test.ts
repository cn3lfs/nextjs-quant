import { crowdingFixturePanel } from "./helpers/market-factor-fixture";
import { expect, it } from "vitest";
import { evaluateGrowthFactors } from "../src/server/research-growth-factors";
import {
  crowdingFactorRules,
  tmtIndustries,
  crowdingPanelSchema,
} from "../src/lib/research-crowding-factors";
import type { AsOfObservation } from "../src/lib/as-of";
import { request } from "./helpers/growth-factor-fixture";

const req = { ...request, observationDate: "2024-05-01" };
function one(id: string, p = crowdingFixturePanel()) {
  const rows: AsOfObservation[] = [
    {
      domain: "capital",
      entity: req.symbol,
      field: "crowdingPanel",
      effectiveAt: req.observationDate,
      source: "synthetic",
      availableAt: req.asOf,
      capturedAt: req.asOf,
      versionId: "fixture-1",
      availabilityEvidence: {
        kind: "version-publication",
        reference: "fixture-only",
      },
      unit: "TMT-31-industry-panel",
      value: p,
    },
  ];
  return evaluateGrowthFactors(req, rows, [id]).results[0]!;
}
it.each(
  Object.keys(crowdingFactorRules).filter((id) => !id.startsWith("TM04-")),
)("%s uses inclusive ties and market proxy", (id) => {
  expect(one(id)).toMatchObject({
    status: "computed",
    details: {
      score: 92,
      band: "extreme",
      action: "exit",
      marginScope: "SSE-market-proxy",
      industries: tmtIndustries,
    },
  });
});
it("five dimensions use source weights and named independent contrasts", () => {
  const r = one("TM04");
  expect(r.details.dimensions).toEqual({
    A: 100,
    B: 100,
    C: 60,
    D: 100,
    E: 100,
    total: 92,
  });
  expect(r.details.variants).toHaveLength(5);
});
it("strict panel validation rejects missing industry, non-TMT targets, duplicates and unknown leverage", () => {
  for (const change of [
    { targetIndustry: "bank" },
    { marginScope: "TMT" },
    { calendar: crowdingFixturePanel().calendar.slice(1) },
    { rows: crowdingFixturePanel().rows.slice(1) },
  ])
    expect(one("TM01", { ...crowdingFixturePanel(), ...change }).status).toBe(
      "missing",
    );
  const p = crowdingFixturePanel();
  p.rows[0]!.industries[0]!.id = "other0";
  expect(crowdingPanelSchema.safeParse(p).success).toBe(false);
  const q = crowdingFixturePanel();
  q.rows[0]!.marginBalance = 0;
  expect(one("TM01", q).status).toBe("missing");
});
it("falling current observations reduce crowding and restore only after prior crowded state", () => {
  const p = crowdingFixturePanel();
  for (const row of p.rows
    .at(-1)!
    .industries.filter((x) =>
      (tmtIndustries as readonly string[]).includes(x.id),
    )) {
    row.amount = 1;
    row.turnover = 0.01;
    row.pe = 1;
    row.pb = 0.01;
    row.close = 50;
  }
  p.rows.at(-1)!.marginBalance = 50;
  expect(one("TM03", p)).toMatchObject({
    passed: true,
    details: { action: "enter", previousScore: 92 },
  });
  const q = structuredClone(p);
  q.rows[q.rows.length - 2]!.industries = structuredClone(
    p.rows.at(-1)!.industries,
  );
  q.rows[q.rows.length - 2]!.marginBalance = 50;
  expect(one("TM03", q).passed).toBe(false);
});
