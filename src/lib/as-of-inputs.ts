import { z } from "zod";
import {
  newsReplaySchema,
  eventMarketSchema,
  newsSectorPanelSchema,
} from "./research-news-factors";
import { sentimentPanelSchema } from "./research-sentiment-factors";
import { crowdingPanelSchema } from "./research-crowding-factors";
import {
  indexValuationSchema,
  indexEtfMappingSchema,
  indexPolicySchema,
} from "./research-index-factors";
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

export const growthTrainingSchema = z
  .object({
    start: researchDateSchema,
    cutoff: researchDateSchema,
    trades: z.array(
      z
        .object({
          event: z
            .object({
              symbol: symbolSchema,
              key: text,
              observedDate: researchDateSchema,
              partition: text,
            })
            .strict(),
          entryDate: researchDateSchema,
          exitDate: researchDateSchema.nullable(),
          profit: number.nullable(),
          remainingQuantity: count,
        })
        .strict(),
    ),
    wyckoffTarget: positive,
  })
  .strict();
export const growthOverrideSchema = z
  .object({
    version: text,
    frozenAt: z.string().datetime({ offset: true }),
    origin: z.enum(["rule", "human"]),
    evidence: text,
    // Only the total-score threshold may be relaxed. No risk or market veto is overridable.
    allowedWeakness: z.literal("total-score-65-to-69"),
  })
  .strict();

// Raw statement inputs and frozen research assumptions; never current report text.
export const valueQualitySchema = z
  .object({
    revenue: positive,
    netIncome: number,
    assets: positive,
    equity: positive,
    operatingCashFlow: number,
    capex: number.nonnegative(),
    longDebt: number.nonnegative(),
    liabilities: number.nonnegative(),
    currentAssets: number.nonnegative(),
    currentLiabilities: positive,
    grossProfit: number,
    issuedShares: count,
    shares: positive,
    interestExpense: positive,
    ebit: number,
    investedCapital: positive,
    taxRate: number.min(0).max(1),
    dividendPerShare: number.nonnegative(),
  })
  .strict();
const amounts = (...keys: string[]) =>
  z
    .object(Object.fromEntries(keys.map((k) => [k, number.nonnegative()])))
    .strict();
export const valueGuoSchema = z
  .object({
    netIncome: number,
    revenue: positive,
    equity: positive,
    minorityEquity: number.nonnegative(),
    shares: positive,
    ocf: number,
    capex: number.nonnegative(),
    longAssetDisposalCash: number.nonnegative(),
    netAcquisitionCash: number,
    maintenance: amounts(
      "assetImpairment",
      "creditImpairment",
      "depreciation",
      "amortization",
      "deferredAmortization",
      "disposalLoss",
      "scrapLoss",
    ),
    financial: amounts(
      "cash",
      "restrictedCash",
      "trading",
      "debtInvestments",
      "otherEquity",
      "investmentProperty",
      "dividendsReceivable",
      "interestReceivable",
    ),
    workingAssets: amounts(
      "receivables",
      "notes",
      "prepayments",
      "inventory",
      "contractAssets",
      "longReceivables",
      "otherOperatingReceivables",
    ),
    workingLiabilities: amounts(
      "payables",
      "notes",
      "advances",
      "contractLiabilities",
      "payroll",
      "taxes",
      "deferredRevenue",
      "otherOperatingPayables",
    ),
    longAssets: amounts(
      "fixed",
      "construction",
      "intangible",
      "development",
      "goodwill",
      "lease",
      "deferredExpenses",
    ),
    shortDebt: number.nonnegative(),
    longDebt: number.nonnegative(),
    investmentBook: number.nonnegative(),
    investmentIncome: number,
    operatingEbit: number,
    preTaxProfit: number,
    taxExpense: number,
    researchCash: number.nonnegative(),
    maintenanceActual: number.nonnegative().nullable(),
    maintenanceEvidence: text.nullable(),
    expansionWorkingCash: number.nonnegative(),
    bank: z
      .object({
        interestFeesReceived: number,
        investmentCash: number,
        payroll: number.nonnegative(),
        taxes: number.nonnegative(),
        feesPaid: number.nonnegative(),
        loanAssets: number.nonnegative(),
        investmentAssets: number.nonnegative(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (r) =>
      r.minorityEquity <= r.equity &&
      r.financial.restrictedCash! <= r.financial.cash!,
    "权益/受限现金冲突",
  );
export const valueRiskSchema = z
  .object({
    origin: z.enum(["rule", "human"]),
    version: text,
    flags: z
      .object(
        Object.fromEntries(
          [
            "accountingChange",
            "receivablesInventory",
            "revenueCashDivergence",
            "writeOff",
            "interimRevision",
            "relatedParty",
            "staffAuditorChange",
            "insiderSelling",
            "restructuring",
          ].map((k) => [
            k,
            z
              .object({
                hit: z.boolean(),
                explanation: text.nullable(),
                evidence: text,
              })
              .strict(),
          ]),
        ),
      )
      .strict(),
    flexibleAccounting: z.boolean(),
  })
  .strict();
export const valueMarketSchema = z
  .object({
    price: positive,
    epsTtm: number,
    bps: positive,
    salesPerShare: positive,
    evEbitda: positive,
    industry: z
      .object({
        pe: positive,
        pb: positive,
        ps: positive,
        evEbitda: positive,
        netMargin: number,
        turnover: positive,
        multiplier: positive,
        classificationVersion: text,
        membershipEvidence: text,
      })
      .strict(),
    history: z
      .object({
        sampling: z.literal("annual-anniversary"),
        start: researchDateSchema,
        end: researchDateSchema,
        calendar: dates,
        rows: z
          .array(
            z
              .object({
                date: researchDateSchema,
                pe: positive,
                pb: positive,
                ps: positive,
                evEbitda: positive,
              })
              .strict(),
          )
          .min(2),
        coverageEvidence: text,
      })
      .strict()
      .refine(
        (r) =>
          r.start === r.calendar[0] &&
          r.end === r.calendar.at(-1) &&
          r.rows.length === r.calendar.length &&
          r.rows.every((v, i) => v.date === r.calendar[i]),
      ),
  })
  .strict();
export const valuePolicySchema = z
  .object({
    version: text,
    frozenAt: z.string().datetime({ offset: true }),
    origin: z.enum(["rule", "human"]),
    evidence: text,
    purpose: z.literal("historical-asof-research"),
    expectedGrowthPct: number,
    industryGrowthPct: number,
    aaaYieldPct: positive,
    riskFreeRate: number.nonnegative(),
    beta: number.nonnegative(),
    equityPremium: number.nonnegative(),
    debtCost: number.nonnegative(),
    taxRate: number.min(0).max(1),
    marketEquity: positive,
    interestDebt: number.nonnegative(),
    cashNonOperating: number.nonnegative(),
    minorityClaims: number.nonnegative(),
    otherClaims: number.nonnegative(),
    guoGrowth: number.gt(-1),
    guoTerminalGrowth: number.gt(-1).max(0.04),
    guoDiscount: z.literal(0.08),
    guoYears: z.number().int().min(3).max(5),
    industry: z.enum([
      "general",
      "bank",
      "research",
      "long-asset",
      "cycle",
      "growth",
      "property",
    ]),
    cycle: z.boolean(),
    cyclePosition: text,
    standardProduct: z.boolean(),
    acquiredBusinessYears: count,
    exclusiveResearchPricing: z.boolean(),
    longMaintenanceMode: z.enum(["disclosed", "historical-low"]),
    normalYear: researchDateSchema,
    minorityComparable: z.boolean(),
    projects: z.array(
      z
        .object({
          id: text,
          saleableValue: number.nonnegative(),
          remainingCost: number.nonnegative(),
          taxes: number.nonnegative(),
        })
        .strict(),
    ),
    propertyDebt: number.nonnegative(),
  })
  .strict();
export const valueGovernanceSchema = z
  .object({
    version: text,
    windowStart: researchDateSchema,
    windowEnd: researchDateSchema,
    origin: z.enum(["rule", "human"]),
    evidence: text,
    marketRank: count,
    customerConcentrationPct: ratio,
    diversified: z.boolean(),
    acquisitionDriven: z.boolean(),
    insiderNetChangePct: number,
    pledgePct: ratio,
    regulatoryLetters: count,
  })
  .strict();
const thesisMetric = z.enum([
  "moatRetention",
  "ownerCashConversion",
  "perShareGrowth",
  "reinvestmentReturn",
  "marketRequiredGrowth",
  "conservativeGrowth",
  "temporaryStress",
  "recoveryProgress",
  "permanentDamage",
  "governanceDamage",
  "downsideLossPct",
  "upsidePct",
  "valuationDemand",
  "alternativeAdvantage",
  "investmentPayoffEvidence",
  "marketHorizonYears",
  "businessMixChange",
  "oldLabelDependence",
  "coverageCount",
  "evidenceCompleteness",
  "forcedSelling",
  "fundingYears",
]);
export const valueThesisSchema = z
  .object({
    methodId: text,
    version: text,
    origin: z.enum(["rule", "human", "llm"]),
    frozenAt: z.string().datetime({ offset: true }),
    recordedAt: z.string().datetime({ offset: true }),
    archiveEvidence: text,
    mode: z.literal("contemporaneous-frozen"),
    modelVersion: text.nullable(),
    promptHash: text.nullable(),
    evidenceCutoff: z.string().datetime({ offset: true }),
    claim: text,
    counterCase: text,
    triggerDescription: text,
    invalidationDescription: text,
    start: researchDateSchema,
    maxWaitDays: count.positive(),
    maxHoldingDays: count.positive(),
    entryDiscount: number.min(0).lt(1),
    fairValue: positive,
    maxPositionPct: ratio,
    triggers: z
      .array(
        z
          .object({
            metric: thesisMetric,
            op: z.enum(["gte", "lte"]),
            threshold: number,
          })
          .strict(),
      )
      .min(1),
    invalidations: z
      .array(
        z
          .object({
            metric: thesisMetric,
            op: z.enum(["gte", "lte"]),
            threshold: number,
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export const valueThesisObservationSchema = z
  .object({
    thesisVersion: text,
    origin: z.enum(["rule", "human", "llm"]),
    measurementVersion: text,
    evidence: text,
    recordedAt: z.string().datetime({ offset: true }),
    evidenceCutoff: z.string().datetime({ offset: true }),
    modelVersion: text.nullable(),
    promptHash: text.nullable(),
    metrics: z.record(thesisMetric, number),
    price: positive,
    positionPct: ratio,
    enteredAt: researchDateSchema.nullable(),
  })
  .strict();

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
