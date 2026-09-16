import type { Bar } from "../../src/lib/domain";
import {
  buildCanslimAsOfDossier,
  type CanslimAsOfRequest,
} from "../../src/server/canslim-as-of-dossier";
import {
  growthHistorySchema,
  growthCrossSectionSchema,
  growthSectorsSchema,
  asOfInputDefinitions,
} from "../../src/lib/as-of-inputs";
import type { AsOfObservation } from "../../src/lib/as-of";
export const request: CanslimAsOfRequest = {
  symbol: "sh600000",
  asOf: "2024-05-01T15:00:00+08:00",
  observationDate: "2024-05-01",
  financialPeriods: ["2024-03-31", "2023-12-31", "2023-09-30", "2023-03-31"],
  annualPeriods: ["2023-12-31", "2022-12-31", "2021-12-31"],
  institutionPeriods: ["2024-03-31", "2023-12-31", "2023-09-30"],
  universeId: "fixed-hs",
  benchmarkId: "sh000300",
};
export const event = (
  kind = "product",
  extra: Record<string, unknown> = {},
) => ({
  id: kind,
  kind,
  origin: "rule",
  classificationVersion: "synthetic-rule-1",
  evidence: "fixed-announcement",
  effectiveFrom: "2024-04-01",
  expiresAt: "2024-06-01",
  withdrawn: false,
  landingDate: "2024-05-02",
  role: "CEO",
  successfulTrackRecord: true,
  industryId: "bank",
  contractRevenuePct: 10,
  forecastLowerPct: 50,
  forecastBaseProfit: 1,
  ...extra,
});
export function fixture(): AsOfObservation[] {
  const supplementary = supplementalValues(request.observationDate);
  return Object.values(buildCanslimAsOfDossier(request, []).inputs)
    .flat()
    .map((r) => {
      let value: unknown = 30;
      if (r.field === "quarterlyEps")
        value = r.effectiveAt === "2024-03-31" ? 1.5 : 1;
      if (r.field === "quarterlyEpsGrowth")
        value = 30 - request.financialPeriods.indexOf(r.effectiveAt) * 5;
      if (r.field === "quarterlyNetMargin")
        value = r.effectiveAt === "2023-03-31" ? 10 : 15;
      if (r.field === "annualEps")
        value = 1.35 ** (Number(r.effectiveAt.slice(0, 4)) - 2021);
      if (r.field === "annualCashPerShare") value = 3;
      if (r.field === "floatMarketCap") value = 100e8;
      if (["totalShares", "floatShares"].includes(r.field)) value = 1000;
      if (r.field === "plans")
        value = { unlockDates: [], activeBuybackPlan: false };
      if (r.field === "shares")
        value = [144, 120, 100][
          request.institutionPeriods.indexOf(r.effectiveAt)
        ];
      if (r.field === "count") value = 10;
      if (r.field === "floatRatio") value = 20;
      if (r.field === "holders")
        value = {
          classificationVersion: "fixture-1",
          origin: "rule",
          rows: [
            { id: "f", category: "foreign" },
            { id: "p", category: "quality-public" },
          ],
        };
      if (r.field === "events") value = [];
      if (r.field === "growthEvents")
        value = [
          "product",
          "management",
          "policy",
          "contract",
          "incentive",
          "forecast",
        ].map((k) => event(k));
      if (r.field === "industry")
        value = { industryId: "bank", classification: "fixture-1" };
      if (r.field === "members") value = [request.symbol];
      if (r.field === "calendar")
        value = {
          start: "2024-05-01",
          end: "2024-05-01",
          openDays: [],
          closedDays: ["2024-05-01"],
        };
      value = supplementary[r.field] ?? value;
      return {
        domain: r.domain,
        field: r.field,
        entity: r.entity,
        effectiveAt: r.effectiveAt,
        unit: asOfInputDefinitions[r.domain][r.field]!.unit,
        value,
        source: "fixed",
        versionId: "first",
        availableAt: "2024-05-01T07:00:00Z",
        capturedAt: "2024-05-02T00:00:00Z",
        availabilityEvidence: {
          kind: "version-publication",
          reference: "synthetic-only",
        },
      };
    });
}

export function supplementalValues(at: string): Record<string, unknown> {
  const day = (offset: number) =>
    new Date(Date.parse(at) + offset * 86400000).toISOString().slice(0, 10);
  const calendar = Array.from({ length: 371 }, (_, i) => day(i - 370));
  const bars: Bar[] = calendar.map((date, i) => ({
    date,
    open: 50 + i / 10,
    high: 50 + i / 10,
    low: 50 + i / 10,
    close: 50 + i / 10,
    volume: 100,
    amount: 10000,
  }));
  const symbols = Array.from({ length: 21 }, (_, i) =>
    i === 20 ? "sh600000" : `sz${String(i + 1).padStart(6, "0")}`,
  );
  const panelCalendar = calendar.slice(-61);
  const sectorCalendar = calendar.slice(-21);
  return {
    priceHistory: {
      symbol: "sh600000",
      benchmarkId: "sh000300",
      adjustment: "backward-split-only",
      comparabilityEvidence: "fixed-action-coverage",
      calendar,
      bars,
      benchmarkBars: structuredClone(bars),
    },
    crossSection: {
      universeId: "fixed-hs",
      start: panelCalendar[0],
      end: at,
      calendar: panelCalendar,
      adjustment: "backward-split-only",
      comparabilityEvidence: "fixed-actions",
      membershipEvidence: "fixed-universe",
      rows: symbols.map((symbol, i) => ({
        symbol,
        startPrice: 100,
        endPrice: 100 + i,
        suspended: false,
        listingDate: "2020-01-01",
      })),
    },
    sectors: {
      start: sectorCalendar[0],
      end: at,
      calendar: sectorCalendar,
      classificationVersion: "fixed-v1",
      membershipEvidence: "fixed-full",
      comparabilityEvidence: "fixed-actions",
      adjustment: "backward-split-only",
      rows: [
        {
          id: "strong",
          startPrice: 100,
          endPrice: 120,
          members: [
            { symbol: "sh600000", startPrice: 100, endPrice: 120 },
            { symbol: "sz000001", startPrice: 100, endPrice: 100 },
          ],
        },
        {
          id: "weak",
          startPrice: 100,
          endPrice: 99,
          members: [{ symbol: "sz000002", startPrice: 100, endPrice: 100 }],
        },
      ],
    },
    securityState: {
      listingDate: "2020-01-01",
      listingTradingDays: 1000,
      st: false,
      delistingRisk: false,
      exchange: "SH",
      resumedAfterSuspensionDays: 0,
      limitUpPrice: 130,
      totalMarketCap: 100e8,
      speculativeTurnoverPct: 2,
    },
    entryPlan: {
      pivot: 100,
      plannedPrice: 102,
      stopPrice: 94,
      accountRiskPct: 1.5,
      positionPct: 18,
      sessionsSinceStop: 5,
    },
    earningsWindow: {
      calendar: Array.from({ length: 61 }, (_, i) => day(i - 30)),
      scheduledDate: day(10),
      lastReportedDate: day(-10),
      actualEps: 1.2,
      consensusEps: 1,
      consensusAvailableAt: `${day(-11)}T10:00:00+08:00`,
      reportAvailableAt: `${day(-10)}T10:00:00+08:00`,
    },
    entryEvents: [
      {
        id: "upgrade",
        kind: "analyst-upgrade",
        origin: "rule",
        classificationVersion: "fixed-v1",
        evidence: "fixed-original",
        date: day(-1),
        withdrawn: false,
      },
    ],
  };
}
export function completeFixture() {
  const rows = fixture();
  const panel = supplementalValues(request.observationDate).crossSection as {
    rows: { symbol: string }[];
  };
  return alignPrices(
    rows.map((r) =>
      r.field === "members"
        ? { ...r, value: panel.rows.map((p) => p.symbol) }
        : r,
    ),
  );
}

export function alignPrices(rows: AsOfObservation[]) {
  const get = (field: string) => rows.find((r) => r.field === field)!.value;
  const h = growthHistorySchema.parse(get("priceHistory"));
  const panel = growthCrossSectionSchema.parse(get("crossSection"));
  const end = h.bars.at(-1)!.close,
    start = h.bars.at(-61)!.close;
  panel.rows.forEach((r, i) => {
    r.startPrice = r.symbol === request.symbol ? start : 100;
    r.endPrice =
      r.symbol === request.symbol ? end : 100 * (end / start - 0.2 + i * 0.01);
  });
  const sectors = growthSectorsSchema.parse(get("sectors"));
  for (const sector of sectors.rows)
    for (const member of sector.members)
      if (member.symbol === request.symbol) {
        member.startPrice = h.bars.at(-21)!.close;
        member.endPrice = end;
      }
  return rows.map((r) =>
    r.field === "crossSection"
      ? { ...r, value: panel }
      : r.field === "sectors"
        ? { ...r, value: sectors }
        : r,
  );
}
