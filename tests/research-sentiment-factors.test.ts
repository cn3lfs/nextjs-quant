import { expect, it } from "vitest";
import { evaluateGrowthFactors } from "../src/server/strategies/canslim/research-growth-factors";
import {
  sentimentFactorRules,
  sentimentMetrics,
} from "../src/lib/research-sentiment-factors";
import type { AsOfObservation } from "../src/lib/as-of";
import { request } from "./helpers/growth-factor-fixture";
const metrics = {
  amountTrillion: 1,
  turnoverPct: 1,
  amountTrend: "flat",
  marginPeakPct: 85,
  marginBuyPct: 7,
  marginChangeYi: 0,
  maintenancePct: 220,
  marginRecord: false,
  allAPePercentile: 40,
  shPe: 13,
  growthPePercentile: 50,
  leaderTurnoverPct: 5,
  defensiveReturnPct: 0,
  breadthPct: 60,
  strengthPct: 60,
  newHighs: 100,
  newLows: 20,
  limitUps: 50,
  limitDowns: 10,
  fiveDaysAbove3Trillion: false,
  accountsWan: 150,
  accountTrend: "flat",
  peakAccountsWan: 720,
  fearGreed: 15,
  fearGreedChange5: -25,
  newsTone: "cautious",
  bullFrequency: "few",
  officialTone: "encourage",
  officialFrontRisk: false,
  stockSearchYoy: -50,
  entrySearchYoy: -50,
  bullNewsYoy: 300,
  bullSearchYoy: -50,
  financeHits: 0,
  bestHotPosition: null,
  heatSharePct: 0,
  negativeHotMajority: false,
  economy: "steady",
  money: "loose",
  geopolitics: "low",
  belief: "some-believe",
};
function fixture(changes: Record<string, unknown> = {}): AsOfObservation[] {
  return [
    {
      domain: "capital",
      entity: request.symbol,
      field: "sentimentPanel",
      effectiveAt: request.observationDate,
      source: "synthetic",
      availableAt: request.asOf,
      capturedAt: request.asOf,
      versionId: "fixture-1",
      availabilityEvidence: {
        kind: "version-publication",
        reference: "fixture-only",
      },
      unit: "market-sentiment-metrics",
      value: {
        version: "synthetic-1",
        evidence: "fixture-only",
        origin: "human",
        classifiedAt: request.asOf,
        observationDate: request.observationDate,
        scope: "A-share-market",
        fearGreedIdentity: "unofficial-domestic-proxy",
        valuationWindowYears: 10,
        metrics: { ...metrics, ...changes },
      },
    },
  ];
}
const one = (id: string, changes: Record<string, unknown> = {}) =>
  evaluateGrowthFactors(request, fixture(changes), [id]).results[0]!;
it.each(Object.keys(sentimentFactorRules))(
  "%s is independently callable and preserves unavailable",
  (id) => {
    expect(one(id).status).toBe("computed");
    expect(evaluateGrowthFactors(request, [], [id]).results[0]!.status).toBe(
      "missing",
    );
  },
);
it("nine dimensions are separately named, full combination preserves every missing metric", () => {
  expect(
    Object.keys(sentimentFactorRules).filter((x) =>
      x.startsWith("MS-dimension-"),
    ),
  ).toHaveLength(9);
  const full = one("MS-full-nine");
  expect(full.details).toMatchObject({
    completeDimensions: 9,
    volatilityDirection: -1,
  });
  expect(full.details.total).toBeCloseTo((full.details.heat as number) * 10);
  for (const k of Object.keys(sentimentMetrics).filter((k) => k !== "belief")) {
    const rows = fixture();
    delete (rows[0]!.value as { metrics: Record<string, unknown> }).metrics[k];
    expect(
      evaluateGrowthFactors(request, rows, ["MS-full-nine"]).results[0]!.status,
      k,
    ).toBe("missing");
  }
});
it("fear threshold equality and nonofficial identity are preserved", () => {
  expect(one("MS01", { fearGreed: 19 }).passed).toBe(true);
  expect(one("MS01", { fearGreed: 20 }).passed).toBe(false);
  expect(one("MS01", { fearGreed: 75 }).details.action).toBe("reduce");
  expect(one("MS01", { fearGreed: 85 }).details.action).toBe("exit");
});
it("named subindicators require only their own raw evidence and preserve source equalities", () => {
  const rows = fixture();
  (rows[0]!.value as { metrics: unknown }).metrics = { amountTrillion: 1.5 };
  expect(
    evaluateGrowthFactors(request, rows, ["MS-component-amount"]).results[0]!,
  ).toMatchObject({
    status: "computed",
    details: { heat: 6, buyEligible: false },
  });
  expect(
    evaluateGrowthFactors(request, rows, ["MS-full-nine"]).results[0]!.status,
  ).toBe("missing");
  expect(
    one("MS-component-maintenance", { maintenancePct: 199 }).details.action,
  ).toBe("reduce");
  expect(
    one("MS-component-emotionSpeed", { fearGreedChange5: -25 }).details
      .volatilityDirection,
  ).toBe(-1);
});
it("breadth alone cannot pass without trend strength; strict double lows exits", () => {
  expect(one("MS02").passed).toBe(true);
  expect(one("MS02", { strengthPct: 49 }).passed).toBe(false);
  expect(one("MS02", { newLows: 200 }).details.action).toBe("hold");
  expect(one("MS02", { newLows: 201 }).details.action).toBe("exit");
});
it("maintenance cap does not turn fragile leverage into admission", () => {
  expect(one("MS05").passed).toBe(true);
  expect(one("MS05", { maintenancePct: 199 }).passed).toBe(false);
  expect(one("MS05", { maintenancePct: 200 }).passed).toBe(true);
});
it("three states and official caution retain separate actions", () => {
  expect(one("MS04", { belief: "none-believe" }).details.positionScale).toBe(
    0.25,
  );
  expect(one("MS04", { belief: "all-believe" }).details.action).toBe("reduce");
  expect(one("MS06").passed).toBe(true);
  expect(one("MS06", { officialTone: "risk" }).details.action).toBe("reduce");
});
it("negative social topics are not market euphoria; zero denominator and late human classification unavailable", () => {
  expect(
    one("MS-dimension-search", {
      financeHits: 20,
      bestHotPosition: 1,
      heatSharePct: 20,
      negativeHotMajority: true,
    }).details.heat,
  ).toBeLessThan(
    one("MS-dimension-search", {
      financeHits: 20,
      bestHotPosition: 1,
      heatSharePct: 20,
    }).details.heat as number,
  );
  expect(one("MS-full-nine", { limitDowns: 0 }).status).toBe("missing");
  expect(
    evaluateGrowthFactors(
      request,
      fixture().map((r) => ({ ...r, capturedAt: "2026-09-17T00:00:00Z" })),
      ["MS04"],
    ).results[0]!.status,
  ).toBe("missing");
});
