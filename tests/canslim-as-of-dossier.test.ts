import {
  crowdingFixturePanel,
  indexFixtureRows,
} from "./helpers/market-factor-fixture";
import { newsRows } from "./helpers/news-factor-fixture";
import { valueFixture } from "./helpers/value-factor-fixture";
import { supplementalValues } from "./helpers/growth-factor-fixture";
import { asOfInputDefinitions } from "../src/lib/as-of-inputs";
import { expect, it, vi } from "vitest";
import {
  buildCanslimAsOfDossier,
  gatherCanslimAsOfDossier,
} from "../src/server/canslim-dossier";
import { asOfDomains, type AsOfObservation } from "../src/lib/as-of";
import type { CanslimAsOfRequest } from "../src/server/canslim-as-of-dossier";

const request: CanslimAsOfRequest = {
  symbol: "sh600000",
  asOf: "2024-05-01T15:00:00+08:00",
  observationDate: "2024-05-01",
  financialPeriods: ["2024-03-31"],
  annualPeriods: ["2023-12-31"],
  institutionPeriods: ["2024-03-31"],
  universeId: "hs-a-fixed",
  benchmarkId: "sh000300",
};
function fixture(): AsOfObservation[] {
  const empty = buildCanslimAsOfDossier(request, []);
  const supplementary: Record<string, unknown> = {
    ...Object.fromEntries(
      [...indexFixtureRows(), ...newsRows()].map((r) => [r.field, r.value]),
    ),
    crowdingPanel: crowdingFixturePanel(),
    sentimentPanel: {
      version: "synthetic",
      evidence: "fixture-only",
      origin: "rule",
      classifiedAt: request.asOf,
      observationDate: request.observationDate,
      scope: "A-share-market",
      fearGreedIdentity: "unofficial-domestic-proxy",
      valuationWindowYears: 10,
      metrics: {},
    },
    ...supplementalValues(request.observationDate),
    ...Object.fromEntries(
      valueFixture()
        .filter((r) => r.domain === "capital" || r.effectiveAt === "2023-12-31")
        .map((r) => [r.field, r.value]),
    ),
    kellyTraining: {
      start: "2023-01-01",
      cutoff: "2024-04-30",
      trades: [],
      wyckoffTarget: 150,
    },
    softOverride: {
      version: "fixed",
      frozenAt: "2024-04-30T15:00:00+08:00",
      origin: "rule",
      evidence: "synthetic",
      allowedWeakness: "total-score-65-to-69",
    },
  };
  return Object.values(empty.inputs)
    .flat()
    .map((q) => {
      let unit = "%",
        value: unknown = 12;
      if (
        (q.field.includes("Eps") && !q.field.includes("Growth")) ||
        q.field === "annualCashPerShare"
      ) {
        unit = "CNY/share";
        value = 1.2;
      }
      if (["totalShares", "floatShares", "shares"].includes(q.field)) {
        unit = "share";
        value = 10000;
      }
      if (q.field === "floatMarketCap") {
        unit = "CNY";
        value = 1e9;
      }
      if (q.field === "count") {
        unit = "institution";
        value = 20;
      }
      if (q.field === "events") {
        unit = "event";
        value = [
          {
            id: "a",
            title: "固定公告",
            kind: "product",
            eventDate: "2024-04-30",
          },
        ];
      }
      if (q.field === "growthEvents") {
        unit = "event";
        value = [];
      }
      if (q.field === "plans") {
        unit = "plan";
        value = { unlockDates: [], activeBuybackPlan: false };
      }
      if (q.field === "holders") {
        unit = "holder";
        value = {
          classificationVersion: "fixture-v1",
          origin: "rule",
          rows: [],
        };
      }
      if (q.field === "members") {
        unit = "security";
        value = [request.symbol, "sz000001"];
      }
      if (q.field === "industry") {
        unit = "classification";
        value = { classification: "fixed-v1", industryId: "bank" };
      }
      if (q.field === "calendar") {
        unit = "day";
        value = {
          start: "2024-05-01",
          end: "2024-05-02",
          openDays: [],
          closedDays: ["2024-05-01", "2024-05-02"],
        };
      }
      if (q.field in supplementary) {
        value = supplementary[q.field];
        unit = asOfInputDefinitions[q.domain][q.field]!.unit;
      }
      return {
        domain: q.domain,
        entity: q.entity,
        field: q.field,
        effectiveAt: q.effectiveAt,
        source: "fixed-source",
        availableAt: "2024-04-30T18:00:00+08:00",
        capturedAt: "2024-06-01T00:00:00Z",
        versionId: "original",
        availabilityEvidence: {
          kind: "version-publication",
          reference: `fixed-${q.field}`,
        },
        unit,
        value,
      };
    });
}
it("provides all six historical input domains through the canslim-dossier entry without computing factors", () => {
  const d = buildCanslimAsOfDossier(request, fixture());
  expect(Object.keys(d.inputs)).toEqual([...asOfDomains]);
  expect(d.dataGaps).toEqual([]);
  expect(d.inputs.finance).toHaveLength(12);
  expect(
    d.inputs.rs
      .filter((r) => ["members", "industry"].includes(r.field))
      .map((r) => r.entity),
  ).toEqual([request.universeId, request.symbol]);
  expect(d.inputs.benchmarkCalendar[0]!.entity).toBe(request.benchmarkId);
  expect(d).not.toHaveProperty("scorecard");
  expect(
    d.inputs.finance.find((r) => r.field === "quarterlyEps"),
  ).toMatchObject({
    value: 1.2,
    effectiveAt: "2024-03-31",
    provenance: {
      availableAt: "2024-04-30T18:00:00+08:00",
      capturedAt: "2024-06-01T00:00:00Z",
    },
  });
});
it("returns per-field missing reasons for absent coverage, not zero or current substitutions", () => {
  const d = buildCanslimAsOfDossier(request, []);
  for (const domain of asOfDomains) {
    expect(d.inputs[domain].length).toBeGreaterThan(0);
    for (const row of d.inputs[domain])
      expect(row).toMatchObject({
        status: "missing",
        value: null,
        code: "no-coverage",
      });
  }
  expect(d.dataGaps).toHaveLength(48);
});
it("keeps the complete past dossier and hash unchanged after later revisions in every domain", () => {
  const original = fixture();
  const revised = original.map((r) => ({
    ...r,
    value: null,
    versionId: "revision-2",
    availableAt: "2024-07-01T00:00:00Z",
    capturedAt: "2024-07-02T00:00:00Z",
  }));
  expect(
    buildCanslimAsOfDossier(request, [...revised, ...original].reverse()),
  ).toEqual(buildCanslimAsOfDossier(request, original));
  const later = buildCanslimAsOfDossier(
    { ...request, asOf: "2024-07-03T00:00:00Z" },
    [...original, ...revised],
  );
  expect(later.dataGaps.every((r) => r.code === "invalid-value")).toBe(true);
});
it("rejects finance with numeric values but no verified publication times, like the documented gpcw gap", () => {
  const raw = fixture().map((r) =>
    r.domain === "finance" ? { ...r, availableAt: undefined } : r,
  );
  const d = buildCanslimAsOfDossier(request, raw);
  expect(d.dataGaps).toHaveLength(12);
  expect(
    d.dataGaps.every(
      (r) => r.domain === "finance" && r.code === "missing-available-at",
    ),
  ).toBe(true);
});
it("does not carry today's universe or classification back to an earlier effective date", () => {
  const rows = fixture().map((r) =>
    r.domain === "rs" ? { ...r, effectiveAt: "2024-06-01" } : r,
  );
  const d = buildCanslimAsOfDossier(request, rows);
  expect(d.dataGaps.map((r) => r.field)).toEqual([
    "priceHistory",
    "crossSection",
    "sectors",
    "members",
    "industry",
  ]);
});
it("rejects incomplete calendars and contradictory open/closed days", () => {
  for (const value of [
    {
      start: "2024-05-01",
      end: "2024-05-03",
      openDays: ["2024-05-01"],
      closedDays: [],
    },
    {
      start: "2024-05-01",
      end: "2024-05-02",
      openDays: ["2024-05-01"],
      closedDays: ["2024-05-01"],
    },
  ]) {
    const d = buildCanslimAsOfDossier(
      request,
      fixture().map((r) =>
        r.domain === "benchmarkCalendar" ? { ...r, value } : r,
      ),
    );
    expect(d.dataGaps).toMatchObject([
      { domain: "benchmarkCalendar", code: "invalid-value" },
    ]);
  }
});
it("keeps genuinely evidenced empty catalysts distinct from absent coverage", () => {
  const d = buildCanslimAsOfDossier(
    request,
    fixture().map((r) => (r.domain === "catalysts" ? { ...r, value: [] } : r)),
  );
  expect(d.inputs.catalysts.find((r) => r.field === "events")).toMatchObject({
    status: "available",
    value: [],
  });
});
it("does not claim calendar coverage outside its explicit range", () => {
  const rows = fixture().map((r) =>
    r.domain === "benchmarkCalendar"
      ? {
          ...r,
          value: {
            start: "2024-05-02",
            end: "2024-05-02",
            openDays: [],
            closedDays: ["2024-05-02"],
          },
        }
      : r,
  );
  expect(buildCanslimAsOfDossier(request, rows).dataGaps).toMatchObject([
    { code: "calendar-coverage" },
  ]);
});
it("gathers only the supplied historical loader, passes cutoffs, and honors cancellation", async () => {
  const load = vi.fn(async () => fixture());
  const controller = new AbortController();
  const d = await gatherCanslimAsOfDossier(request, load, controller.signal);
  expect(load).toHaveBeenCalledExactlyOnceWith(request, controller.signal);
  expect(d.dataGaps).toEqual([]);
  controller.abort();
  await expect(
    gatherCanslimAsOfDossier(request, load, controller.signal),
  ).rejects.toThrow();
  expect(load).toHaveBeenCalledTimes(1);
});
it("keeps the requested cutoff even when the loader mutates its argument", async () => {
  const result = await gatherCanslimAsOfDossier(request, async (r) => {
    r.asOf = "2025-01-01T00:00:00Z";
    return fixture().map((row) => ({
      ...row,
      availableAt: "2024-07-01T00:00:00Z",
      capturedAt: "2024-07-02T00:00:00Z",
    }));
  });
  expect(result.request.asOf).toBe(request.asOf);
  expect(result.dataGaps).toHaveLength(48);
});
