import { z } from "zod";
import { chipHistorySchema } from "trading-strategies/research/factors/research-chip-factors";
import { queryPanelSchema } from "trading-strategies/research/query/research-query-templates";
import {
  newsReplaySchema,
  eventMarketSchema,
  newsSectorPanelSchema,
} from "trading-strategies/research/factors/research-news-factors";
import { sentimentPanelSchema } from "trading-strategies/research/factors/research-sentiment-factors";
import { crowdingPanelSchema } from "trading-strategies/research/factors/research-crowding-factors";
import {
  indexValuationSchema,
  indexEtfMappingSchema,
  indexPolicySchema,
} from "trading-strategies/research/factors/research-index-factors";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { createAsOfAdapter, type AsOfResult } from "./as-of";
import { type AsOfDomain } from "trading-strategies/research/contracts/as-of-domain";

const number = z.number().finite();
const positive = number.positive();
const count = number.int().nonnegative();
const ratio = number.min(0).max(100);
const text = z.string().trim().min(1);
const members = z
  .array(symbolSchema)
  .min(1)
  .refine((rows) => new Set(rows).size === rows.length, "证券池重复");
const calendar = z
  .object({
    start: researchDateSchema,
    end: researchDateSchema,
    openDays: z.array(researchDateSchema),
    closedDays: z.array(researchDateSchema),
  })
  .strict()
  .superRefine((r, ctx) => {
    const days = [...r.openDays, ...r.closedDays];
    const expected = (Date.parse(r.end) - Date.parse(r.start)) / 86400000 + 1;
    if (
      expected <= 0 ||
      days.length !== expected ||
      new Set(days).size !== days.length ||
      days.some((d) => d < r.start || d > r.end)
    )
      ctx.addIssue({
        code: "custom",
        message: "日历须完整覆盖区间，每天仅有一个开闭市状态",
      });
  });

import {
  growthHistorySchema,
  growthCrossSectionSchema,
  growthSectorsSchema,
  growthSecuritySchema,
  growthEntrySchema,
  growthEarningsSchema,
  growthEntryEventsSchema,
  growthTrainingSchema,
  growthOverrideSchema,
} from "trading-strategies/research/contracts/growth-inputs";

// Raw statement inputs and frozen research assumptions; never current report text.
import {
  valueQualitySchema,
  valueGuoSchema,
  valueRiskSchema,
  valueMarketSchema,
  valuePolicySchema,
  valueGovernanceSchema,
  valueThesisSchema,
  valueThesisObservationSchema,
} from "trading-strategies/research/contracts/value-inputs";

type Definition = { unit: string; schema: z.ZodType<unknown> };
// Input vocabulary, not factor methods. Each field/period is independently
// versioned. A covered sibling field never supplies missing provenance.

export const asOfInputDefinitions: Record<
  AsOfDomain,
  Record<string, Definition>
> = {
  finance: {
    annualValueQuality: { unit: "CNY-statement", schema: valueQualitySchema },
    annualGuo: { unit: "CNY-reconstruction", schema: valueGuoSchema },
    annualFcff: { unit: "CNY-reconciled-FCFF", schema: number },
    quarterlyNetMargin: { unit: "%", schema: number },
    quarterlyEps: { unit: "CNY/share", schema: number },
    quarterlyEpsGrowth: { unit: "%", schema: number },
    quarterlyRevenueGrowth: { unit: "%", schema: number },
    quarterlyProfitGrowth: { unit: "%", schema: number },
    annualEps: { unit: "CNY/share", schema: number },
    annualCashPerShare: { unit: "CNY/share", schema: number },
    annualRoe: { unit: "%", schema: number },
    annualWeightedRoe: { unit: "%", schema: number },
  },
  capital: {
    queryPanel: {
      unit: "frozen-query-cross-section",
      schema: queryPanelSchema,
    },
    chipHistory: { unit: "chip-CNY-percent-panel", schema: chipHistorySchema },
    sentimentPanel: {
      unit: "market-sentiment-metrics",
      schema: sentimentPanelSchema,
    },
    crowdingPanel: {
      unit: "TMT-31-industry-panel",
      schema: crowdingPanelSchema,
    },
    indexValuation: {
      unit: "index-valuation-panel",
      schema: indexValuationSchema,
    },
    indexEtfMapping: {
      unit: "frozen-etf-mapping",
      schema: indexEtfMappingSchema,
    },
    indexPolicy: { unit: "frozen-index-policy", schema: indexPolicySchema },
    valueRisk: { unit: "risk-evidence", schema: valueRiskSchema },
    valueMarket: { unit: "CNY-multiples", schema: valueMarketSchema },
    valuePolicy: { unit: "frozen-policy", schema: valuePolicySchema },
    valueGovernance: {
      unit: "governance-evidence",
      schema: valueGovernanceSchema,
    },
    valueTheses: {
      unit: "frozen-theses",
      schema: z
        .array(valueThesisSchema)
        .refine((r) => new Set(r.map((x) => x.methodId)).size === r.length),
    },
    valueThesisObservations: {
      unit: "thesis-observations",
      schema: z.record(text, valueThesisObservationSchema),
    },
    securityState: { unit: "state", schema: growthSecuritySchema },
    kellyTraining: { unit: "closed-trades", schema: growthTrainingSchema },
    softOverride: { unit: "frozen-policy", schema: growthOverrideSchema },
    entryPlan: { unit: "plan", schema: growthEntrySchema },
    plans: {
      unit: "plan",
      schema: z
        .object({
          unlockDates: z.array(researchDateSchema),
          activeBuybackPlan: z.boolean(),
        })
        .strict(),
    },
    totalShares: { unit: "share", schema: positive },
    floatShares: { unit: "share", schema: positive },
    floatMarketCap: { unit: "CNY", schema: positive },
  },
  institutions: {
    holders: {
      unit: "holder",
      schema: z
        .object({
          classificationVersion: text,
          origin: z.enum(["rule", "human"]),
          rows: z
            .array(
              z
                .object({
                  id: text,
                  category: z.enum([
                    "quality-public",
                    "foreign",
                    "private",
                    "general",
                  ]),
                })
                .strict(),
            )
            .refine(
              (rows) => new Set(rows.map((r) => r.id)).size === rows.length,
            ),
        })
        .strict(),
    },
    count: { unit: "institution", schema: count },
    shares: { unit: "share", schema: number.nonnegative() },
    floatRatio: { unit: "%", schema: ratio },
  },
  catalysts: {
    newsReplay: { unit: "frozen-first-model-result", schema: newsReplaySchema },
    eventMarket: {
      unit: "event-price-breadth-panel",
      schema: eventMarketSchema,
    },
    newsSectorPanel: {
      unit: "frozen-sector-valuation-flow",
      schema: newsSectorPanelSchema,
    },
    earningsWindow: { unit: "schedule", schema: growthEarningsSchema },
    entryEvents: { unit: "event", schema: growthEntryEventsSchema },
    growthEvents: {
      unit: "event",
      schema: z
        .array(
          z
            .object({
              id: text,
              kind: z.enum([
                "product",
                "management",
                "policy",
                "contract",
                "incentive",
                "forecast",
                "rumor",
                "other",
              ]),
              origin: z.enum(["rule", "human"]),
              classificationVersion: text,
              evidence: text,
              effectiveFrom: researchDateSchema,
              expiresAt: researchDateSchema,
              withdrawn: z.boolean(),
              landingDate: researchDateSchema.nullable(),
              role: z.enum(["CEO", "CFO", "other"]).nullable(),
              successfulTrackRecord: z.boolean(),
              industryId: text.nullable(),
              contractRevenuePct: number.nonnegative().nullable(),
              forecastLowerPct: number.nullable(),
              forecastBaseProfit: number.nullable(),
            })
            .strict()
            .refine((r) => r.expiresAt >= r.effectiveFrom),
        )
        .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length),
    },
    // The publication assertion covers the entire versioned event list,
    // including an explicitly evidenced empty list. No news retrieval here.
    events: {
      unit: "event",
      schema: z
        .array(
          z
            .object({
              id: text,
              kind: text,
              title: text,
              eventDate: researchDateSchema,
            })
            .strict(),
        )
        .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length),
    },
  },
  rs: {
    priceHistory: { unit: "OHLCV", schema: growthHistorySchema },
    crossSection: { unit: "price-panel", schema: growthCrossSectionSchema },
    sectors: { unit: "sector-panel", schema: growthSectorsSchema },
    members: { unit: "security", schema: members },
    industry: {
      unit: "classification",
      schema: z
        .object({
          industryId: text,
          classification: text,
        })
        .strict(),
    },
  },
  benchmarkCalendar: {
    calendar: { unit: "day", schema: calendar },
  },
};

export type AsOfInputQuery = {
  domain: AsOfDomain;
  entity: string;
  field: string;
  effectiveAt: string;
  source?: string;
};
export function readAsOfInput(
  adapter: ReturnType<typeof createAsOfAdapter>,
  query: AsOfInputQuery,
): AsOfResult<unknown> {
  const fields = asOfInputDefinitions[query.domain];
  const definition =
    fields && Object.hasOwn(fields, query.field)
      ? fields[query.field]
      : undefined;
  if (!definition)
    return {
      status: "missing",
      value: null,
      code: "unsupported-field",
      reason: `${query.domain}/${query.field} 尚无已验证字段口径，需补齐字段适配与单位`,
    };
  if (
    (query.domain === "finance" || query.domain === "institutions") &&
    (!/^\d{4}-(03-31|06-30|09-30|12-31)$/.test(query.effectiveAt) ||
      (query.field.startsWith("annual") &&
        !query.effectiveAt.endsWith("12-31")))
  )
    return {
      status: "missing",
      value: null,
      code: "invalid-report-period",
      reason:
        "财务/机构输入须明确季度报告期，年度字段须为年末；报告期不充当披露时间",
    };
  const result = adapter.read({ ...query, ...definition });
  if (
    result.status === "available" &&
    query.domain === "benchmarkCalendar" &&
    query.field === "calendar"
  ) {
    const coverage = calendar.parse(result.value);
    const date =
      query.effectiveAt.length === 10
        ? query.effectiveAt
        : new Date(Date.parse(query.effectiveAt) + 8 * 3600000)
            .toISOString()
            .slice(0, 10);
    if (date < coverage.start || date > coverage.end)
      return {
        status: "missing",
        value: null,
        code: "calendar-coverage",
        reason: "基准日历未覆盖请求的生效日期，不用相邻日历补齐",
      };
  }
  return result;
}
