import { z } from "zod";
import { researchDateSchema } from "./date.js";
const number = z.number().finite();
const positive = number.positive();
const count = number.int().nonnegative();
const ratio = number.min(0).max(100);
const text = z.string().trim().min(1);
const dates = z
  .array(researchDateSchema)
  .min(1)
  .refine(
    (rows) => rows.every((d, i) => i === 0 || d > rows[i - 1]!),
    "日期必须严格递增且无重复",
  );
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
