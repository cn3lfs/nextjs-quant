import { z } from "zod";
import { symbolSchema } from "./domain";
import { researchDateSchema } from "./research-usage";
import { createAsOfAdapter, type AsOfDomain, type AsOfResult } from "./as-of";

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

// B6b supplementary fields share the same publication/version contract.
const dates = z
  .array(researchDateSchema)
  .min(1)
  .refine(
    (rows) => rows.every((d, i) => i === 0 || d > rows[i - 1]!),
    "日期必须严格递增且无重复",
  );
const bar = z
  .object({
    date: researchDateSchema,
    open: positive,
    high: positive,
    low: positive,
    close: positive,
    volume: positive,
    amount: number.nonnegative(),
  })
  .strict()
  .refine(
    (b) =>
      b.high >= Math.max(b.open, b.close, b.low) &&
      b.low <= Math.min(b.open, b.close),
  );
export const growthHistorySchema = z
  .object({
    symbol: symbolSchema,
    benchmarkId: z.literal("sh000300"),
    adjustment: z.literal("backward-split-only"),
    comparabilityEvidence: text,
    calendar: dates,
    bars: z.array(bar).min(1),
    benchmarkBars: z.array(bar).min(1),
  })
  .strict()
  .refine(
    (r) =>
      [r.bars, r.benchmarkBars].every(
        (bs) =>
          bs.length === r.calendar.length &&
          bs.every((b, i) => b.date === r.calendar[i]),
      ),
    "行情须逐日完整对齐冻结日历；停牌缺口不补造K线",
  );
export const growthCrossSectionSchema = z
  .object({
    universeId: text,
    start: researchDateSchema,
    end: researchDateSchema,
    calendar: dates,
    adjustment: z.literal("backward-split-only"),
    comparabilityEvidence: text,
    membershipEvidence: text,
    rows: z
      .array(
        z
          .object({
            symbol: symbolSchema,
            startPrice: positive.nullable(),
            endPrice: positive.nullable(),
            suspended: z.boolean(),
            listingDate: researchDateSchema,
          })
          .strict(),
      )
      .min(2),
  })
  .strict()
  .refine(
    (r) =>
      r.calendar[0] === r.start &&
      r.calendar.at(-1) === r.end &&
      new Set(r.rows.map((v) => v.symbol)).size === r.rows.length,
  );
export const growthSectorsSchema = z
  .object({
    start: researchDateSchema,
    end: researchDateSchema,
    calendar: dates,
    classificationVersion: text,
    membershipEvidence: text,
    comparabilityEvidence: text,
    adjustment: z.literal("backward-split-only"),
    rows: z
      .array(
        z
          .object({
            id: text,
            startPrice: positive,
            endPrice: positive,
            members: z
              .array(
                z
                  .object({
                    symbol: symbolSchema,
                    startPrice: positive,
                    endPrice: positive,
                  })
                  .strict(),
              )
              .min(1)
              .refine((r) => new Set(r.map((v) => v.symbol)).size === r.length),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
  .refine(
    (r) =>
      r.calendar[0] === r.start &&
      r.calendar.at(-1) === r.end &&
      new Set(r.rows.map((v) => v.id)).size === r.rows.length,
  );
export const growthSecuritySchema = z
  .object({
    listingDate: researchDateSchema,
    listingTradingDays: count,
    st: z.boolean(),
    delistingRisk: z.boolean(),
    exchange: z.enum(["SH", "SZ", "BJ"]),
    resumedAfterSuspensionDays: count,
    limitUpPrice: positive,
    totalMarketCap: positive,
    speculativeTurnoverPct: ratio,
  })
  .strict();
export const growthEntrySchema = z
  .object({
    pivot: positive,
    plannedPrice: positive,
    stopPrice: positive,
    accountRiskPct: ratio,
    positionPct: ratio,
    sessionsSinceStop: count,
  })
  .strict();
export const growthEarningsSchema = z
  .object({
    // These dates are frozen known schedules, never subsequently realized dates.
    calendar: dates,
    scheduledDate: researchDateSchema,
    lastReportedDate: researchDateSchema,
    actualEps: number,
    consensusEps: number,
    consensusAvailableAt: z.string().datetime({ offset: true }),
    reportAvailableAt: z.string().datetime({ offset: true }),
  })
  .strict();
export const growthEntryEventsSchema = z
  .array(
    z
      .object({
        id: text,
        kind: z.enum([
          "earnings-surprise",
          "analyst-upgrade",
          "institution-visit",
        ]),
        origin: z.enum(["rule", "human"]),
        classificationVersion: text,
        evidence: text,
        date: researchDateSchema,
        withdrawn: z.boolean(),
      })
      .strict(),
  )
  .refine((r) => new Set(r.map((v) => v.id)).size === r.length);

type Definition = { unit: string; schema: z.ZodType<unknown> };
// Input vocabulary, not factor methods. Each field/period is independently
// versioned. A covered sibling field never supplies missing provenance.
export const asOfInputDefinitions: Record<
  AsOfDomain,
  Record<string, Definition>
> = {
  finance: {
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
    securityState: { unit: "state", schema: growthSecuritySchema },
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
