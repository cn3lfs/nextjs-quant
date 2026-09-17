import { request } from "./growth-factor-fixture";
import { tmtIndustries } from "../../src/lib/research-crowding-factors";
import type { AsOfObservation } from "../../src/lib/as-of";
import { asOfInputDefinitions } from "../../src/lib/as-of-inputs";
export function crowdingFixturePanel() {
  const calendar = Array.from({ length: 62 }, (_, i) =>
    new Date(Date.parse("2024-03-01") + i * 86400000)
      .toISOString()
      .slice(0, 10),
  );
  return {
    version: "fixture-1",
    windowRecordedAt: "2024-02-29T14:00:00+08:00",
    targetSymbol: request.symbol,
    membershipVersion: "synthetic31",
    evidence: "fixture-only-not-real-calendar",
    windowStart: calendar[0]!,
    windowEnd: calendar.at(-1)!,
    frozenAt: "2024-02-29T15:00:00+08:00",
    targetIndustry: "801080",
    targetMembershipEvidence: "fixture-only",
    marginScope: "SSE-market-proxy",
    calendar,
    rows: calendar.map((date) => ({
      date,
      marginBalance: 100,
      industries: [
        ...tmtIndustries,
        ...Array.from({ length: 27 }, (_, i) => `other${i}`),
      ].map((id) => ({
        id,
        amount: 100,
        floatCap: 100,
        turnover: 1,
        pe: 10,
        pb: 1,
        close: 100,
      })),
    })),
  };
}
export const indexFixtureRequest = { ...request, symbol: "sh510300" };
export const indexFixtureDates = ["2024-04-29", "2024-04-30", "2024-05-01"];
export function indexFixtureRows(): AsOfObservation[] {
  const values: Record<string, unknown> = {
    indexValuation: {
      indexId: "sh000300",
      calculationDate: indexFixtureRequest.observationDate,
      windowStart: indexFixtureDates[0],
      windowEnd: indexFixtureDates[2],
      calendar: indexFixtureDates,
      methodology: "synthetic-fixed-pool-positive-pe-pb",
      membershipVersion: "synthetic-1",
      evidence: "fixture-only",
      samples: indexFixtureDates.map((date, i) => ({
        date,
        pe: 20 - i * 5,
        pb: 3 - i,
      })),
    },
    indexEtfMapping: {
      indexId: "sh000300",
      version: "synthetic-1",
      frozenAt: "2024-04-28T15:00:00+08:00",
      validFrom: "2024-04-29",
      validThrough: "2024-05-02",
      evidence: "fixture-only",
      rows: [
        {
          symbol: indexFixtureRequest.symbol,
          instrument: "domestic-equity-etf",
          listingDate: "2020-01-01",
          trackingIndex: "sh000300",
          weight: 1,
        },
      ],
    },
    indexPolicy: {
      version: "gf-engineering-1",
      frozenAt: "2024-04-28T15:00:00+08:00",
      windowStart: indexFixtureDates[0],
      windowEnd: indexFixtureDates[2],
      entryBelow: 20,
      middleAt: 50,
      exitAt: 80,
      evidence: "fixture-only",
    },
  };
  return Object.entries(values).map(([field, value]) => ({
    domain: "capital",
    entity: indexFixtureRequest.symbol,
    field,
    effectiveAt: indexFixtureRequest.observationDate,
    source: "synthetic",
    availableAt:
      field === "indexValuation"
        ? indexFixtureRequest.asOf
        : "2024-04-28T15:00:00+08:00",
    capturedAt:
      field === "indexValuation"
        ? indexFixtureRequest.asOf
        : "2024-04-28T15:00:00+08:00",
    versionId: "fixture-1",
    availabilityEvidence: {
      kind: "version-publication",
      reference: "fixture-only",
    },
    unit: asOfInputDefinitions.capital[field]!.unit,
    value,
  }));
}
