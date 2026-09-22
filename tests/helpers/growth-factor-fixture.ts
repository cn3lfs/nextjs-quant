import type { Bar } from "../../src/lib/domain";
import {
  buildCanslimAsOfDossier,
  type CanslimAsOfRequest,
} from "../../src/server/strategies/canslim/canslim-as-of-dossier";
import {
  growthHistorySchema,
  growthCrossSectionSchema,
  growthSectorsSchema,
  growthEntrySchema,
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

const set = (rows: AsOfObservation[], field: string, value: unknown) =>
  rows.map((r) => (r.field === field ? { ...r, value } : r));
const value = (rows: AsOfObservation[], field: string) =>
  rows.find((r) => r.field === field)!.value;
export function growthShapedFixture(
  kind: "flat" | "cup" | "saucer" | "sepa" = "flat",
) {
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
