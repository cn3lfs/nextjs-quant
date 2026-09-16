import type { AsOfObservation } from "../../src/lib/as-of";
import { asOfInputDefinitions } from "../../src/lib/as-of-inputs";
import { valueThesisMetrics } from "../../src/lib/research-value-factors";
import { request } from "./growth-factor-fixture";
export const valueRequest = {
  ...request,
  annualPeriods: Array.from({ length: 6 }, (_, i) => `${2023 - i}-12-31`),
};
export const valuePolicy = {
  version: "frozen-model-1",
  frozenAt: "2024-04-30T15:00:00+08:00",
  origin: "rule",
  evidence: "synthetic-before-decision",
  purpose: "historical-asof-research",
  expectedGrowthPct: 10,
  industryGrowthPct: 8,
  aaaYieldPct: 4.4,
  riskFreeRate: 0.025,
  beta: 1,
  equityPremium: 0.06,
  debtCost: 0.04,
  taxRate: 0.25,
  marketEquity: 1000,
  interestDebt: 100,
  cashNonOperating: 100,
  minorityClaims: 0,
  otherClaims: 0,
  guoGrowth: 0.05,
  guoTerminalGrowth: 0.02,
  guoDiscount: 0.08,
  guoYears: 5,
  industry: "general",
  cycle: false,
  cyclePosition: "synthetic-mid-cycle",
  standardProduct: false,
  acquiredBusinessYears: 5,
  exclusiveResearchPricing: true,
  longMaintenanceMode: "disclosed",
  normalYear: "2023-12-31",
  minorityComparable: true,
  projects: [
    {
      id: "synthetic-project",
      saleableValue: 5000,
      remainingCost: 1000,
      taxes: 200,
    },
  ],
  propertyDebt: 100,
};
export const thesisMetrics = {
  moatRetention: 1,
  ownerCashConversion: 1,
  perShareGrowth: 1,
  reinvestmentReturn: 1,
  marketRequiredGrowth: 1,
  conservativeGrowth: 2,
  temporaryStress: 1,
  recoveryProgress: 1,
  permanentDamage: 0,
  governanceDamage: 0,
  downsideLossPct: 1,
  upsidePct: 2,
  valuationDemand: 1,
  alternativeAdvantage: 1,
  investmentPayoffEvidence: 1,
  marketHorizonYears: 0.25,
  businessMixChange: 1,
  oldLabelDependence: 1,
  coverageCount: 1,
  evidenceCompleteness: 1,
  forcedSelling: 1,
  fundingYears: 1,
};
export function valueFixture(id = "FA01"): AsOfObservation[] {
  const rows: AsOfObservation[] = [];
  const add = (
    domain: "finance" | "capital",
    field: string,
    value: unknown,
    effectiveAt = request.observationDate,
  ) =>
    rows.push({
      domain,
      entity: request.symbol,
      field,
      value,
      effectiveAt,
      unit: asOfInputDefinitions[domain][field]!.unit,
      source: "synthetic-only",
      versionId: "first",
      availableAt: ["valueMarket", "valueThesisObservations"].includes(field)
        ? "2024-05-01T07:00:00Z"
        : "2024-04-30T06:00:00Z",
      capturedAt: ["valueMarket", "valueThesisObservations"].includes(field)
        ? "2024-05-01T07:00:00Z"
        : "2024-04-30T06:00:00Z",
      availabilityEvidence: {
        kind: "version-publication",
        reference: "fixed-input-not-real-history",
      },
    });
  for (const [i, date] of valueRequest.annualPeriods.entries()) {
    const revenue = 1000 - i * 100;
    add(
      "finance",
      "annualValueQuality",
      {
        revenue,
        netIncome: 150 - i * 20,
        assets: 1000 - i * 50,
        equity: 800 - i * 40,
        operatingCashFlow: 200 - i * 20,
        capex: 50,
        longDebt: 50 + i * 2,
        liabilities: 200 - i * 10,
        currentAssets: 500 - i * 10,
        currentLiabilities: 100 + i * 10,
        grossProfit: revenue * (0.6 - i * 0.02),
        issuedShares: 0,
        shares: 100,
        interestExpense: 5,
        ebit: 180 - i * 20,
        investedCapital: 900 - i * 50,
        taxRate: 0.2,
        dividendPerShare: 1,
      },
      date,
    );
    add("finance", "annualFcff", 150 - i * 10, date);
    add(
      "finance",
      "annualGuo",
      {
        netIncome: 150 - i * 10,
        revenue: 1000 - i * 100,
        equity: 800 - i * 20,
        minorityEquity: 0,
        shares: 100,
        ocf: 200 - i * 10,
        capex: 70 - i,
        longAssetDisposalCash: 0,
        netAcquisitionCash: 0,
        maintenance: {
          assetImpairment: 1,
          creditImpairment: 1,
          depreciation: 10,
          amortization: 2,
          deferredAmortization: 2,
          disposalLoss: 2,
          scrapLoss: 2,
        },
        financial: {
          cash: 720 - i * 20,
          restrictedCash: 10,
          trading: 10,
          debtInvestments: 10,
          otherEquity: 0,
          investmentProperty: 0,
          dividendsReceivable: 0,
          interestReceivable: 0,
        },
        workingAssets: {
          receivables: 30,
          notes: 0,
          prepayments: 0,
          inventory: 20,
          contractAssets: 0,
          longReceivables: 0,
          otherOperatingReceivables: 0,
        },
        workingLiabilities: {
          payables: 20,
          notes: 0,
          advances: 0,
          contractLiabilities: 0,
          payroll: 0,
          taxes: 0,
          deferredRevenue: 0,
          otherOperatingPayables: 0,
        },
        longAssets: {
          fixed: 100,
          construction: 0,
          intangible: 0,
          development: 5,
          goodwill: 5,
          lease: 0,
          deferredExpenses: 0,
        },
        shortDebt: 40,
        longDebt: 60,
        investmentBook: 20,
        investmentIncome: 2,
        operatingEbit: 180 - i * 10,
        preTaxProfit: 160 - i * 10,
        taxExpense: 10,
        researchCash: 50 - i * 5,
        maintenanceActual: 5,
        maintenanceEvidence: "synthetic-disclosed-maintenance",
        expansionWorkingCash: 30 - i * 3,
        bank: {
          interestFeesReceived: 200,
          investmentCash: 10,
          payroll: 20,
          taxes: 10,
          feesPaid: 5,
          loanAssets: 1000,
          investmentAssets: 500,
        },
      },
      date,
    );
  }
  add("capital", "valueRisk", {
    origin: "rule",
    version: "risk-1",
    flexibleAccounting: false,
    flags: Object.fromEntries(
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
        { hit: false, explanation: null, evidence: "synthetic" },
      ]),
    ),
  });
  const calendar = Array.from({ length: 6 }, (_, i) => `${2019 + i}-05-01`);
  add("capital", "valueMarket", {
    price: 2,
    epsTtm: 2,
    bps: 8,
    salesPerShare: 10,
    evEbitda: 2,
    industry: {
      pe: 15,
      pb: 2,
      ps: 3,
      evEbitda: 10,
      netMargin: 0.1,
      turnover: 0.8,
      multiplier: 2,
      classificationVersion: "frozen-1",
      membershipEvidence: "synthetic",
    },
    history: {
      sampling: "annual-anniversary",
      start: calendar[0],
      end: calendar.at(-1),
      calendar,
      rows: calendar.map((date, i) => ({
        date,
        pe: i === 5 ? 1 : 10 + i,
        pb: i === 5 ? 0.25 : 2 + i / 10,
        ps: 3,
        evEbitda: 10,
      })),
      coverageEvidence: "synthetic-annual-sampling-not-real",
    },
  });
  const branch = id.startsWith("GY06-") ? id.slice(5) : "general";
  add("capital", "valuePolicy", {
    ...valuePolicy,
    industry: branch,
    cycle: branch === "cycle",
  });
  add("capital", "valueGovernance", {
    version: "gov-1",
    windowStart: "2023-11-01",
    windowEnd: "2024-05-01",
    origin: "rule",
    evidence: "synthetic-six-month-window",
    marketRank: 1,
    customerConcentrationPct: 20,
    diversified: true,
    acquisitionDriven: false,
    insiderNetChangePct: 1,
    pledgePct: 5,
    regulatoryLetters: 0,
  });
  add(
    "capital",
    "valueTheses",
    Object.entries(valueThesisMetrics).map(([methodId, metrics]) => ({
      methodId,
      version: `${methodId}-frozen-1`,
      origin: "rule",
      frozenAt: "2024-04-30T15:00:00+08:00",
      recordedAt: "2024-04-30T14:00:00+08:00",
      archiveEvidence: "synthetic-contemporaneous",
      mode: "contemporaneous-frozen",
      modelVersion: null,
      promptHash: null,
      evidenceCutoff: "2024-04-30T14:00:00+08:00",
      claim: `synthetic ${methodId} falsifiable thesis`,
      counterCase: "permanent loss",
      triggerDescription: "precommitted metric comparisons",
      invalidationDescription: "permanent damage",
      start: "2024-05-01",
      maxWaitDays: 30,
      maxHoldingDays: 365,
      entryDiscount: 0.3,
      fairValue: 10,
      maxPositionPct: 20,
      triggers: metrics.map((metric) => ({
        metric,
        op: [
          "permanentDamage",
          "governanceDamage",
          "marketHorizonYears",
        ].includes(metric)
          ? "lte"
          : "gte",
        threshold:
          metric === "permanentDamage" || metric === "governanceDamage" ? 0 : 1,
      })),
      invalidations: [
        { metric: "permanentDamage", op: "gte", threshold: 1 },
        ...(methodId === "VI05"
          ? [{ metric: "governanceDamage", op: "gte", threshold: 1 }]
          : []),
      ],
    })),
  );
  add(
    "capital",
    "valueThesisObservations",
    Object.fromEntries(
      Object.keys(valueThesisMetrics).map((methodId) => [
        methodId,
        {
          thesisVersion: `${methodId}-frozen-1`,
          origin: "rule",
          measurementVersion: "fixed-metrics-1",
          evidence: "synthetic-metric-evidence",
          recordedAt: "2024-05-01T15:00:00+08:00",
          evidenceCutoff: "2024-05-01T15:00:00+08:00",
          modelVersion: null,
          promptHash: null,
          metrics: thesisMetrics,
          price: 5,
          positionPct: 0,
          enteredAt: null,
        },
      ]),
    ),
  );
  return rows;
}
export function setValue(
  rows: AsOfObservation[],
  field: string,
  fn: (value: unknown) => unknown,
  period?: string,
) {
  return rows.map((r) =>
    r.field === field && (!period || r.effectiveAt === period)
      ? { ...r, value: fn(structuredClone(r.value)) }
      : r,
  );
}
