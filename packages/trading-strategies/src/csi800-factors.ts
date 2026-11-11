import { csi800SignalBars } from "./csi800-signal.js";
import {
  calculateFactor,
  type FactorSpec,
} from "trading-strategy-core/factors";
import {
  financialMetrics,
  financialVisibleAt,
  sourceFinancialValue,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import type { Bar } from "trading-strategy-core/bars";
import type { Csi800Stock } from "./csi800-model.js";

export type ClassicFamily =
  | "momentum"
  | "trend"
  | "reversal"
  | "low-risk"
  | "liquidity"
  | "quality"
  | "value"
  | "growth"
  | "investment"
  | "balance-sheet";
export type ClassicFactor = {
  id: string;
  family: ClassicFamily;
  direction: 1 | -1;
  spec?: FactorSpec;
  formula: string;
};
export const csi800ClassicFactors: readonly ClassicFactor[] = [
  {
    id: "momentum-120-20",
    family: "momentum",
    direction: 1,
    spec: { id: "skip-momentum", parameters: { period: 120, skip: 20 } },
    formula: "existing skip-momentum 120/20",
  },
  {
    id: "momentum-250-20",
    family: "momentum",
    direction: 1,
    spec: { id: "skip-momentum", parameters: { period: 250, skip: 20 } },
    formula: "existing skip-momentum 250/20",
  },
  {
    id: "high-distance-250",
    family: "momentum",
    direction: 1,
    spec: { id: "high-distance", parameters: { period: 250 } },
    formula: "existing high-distance 250",
  },
  {
    id: "bias-60",
    family: "trend",
    direction: 1,
    spec: { id: "bias", parameters: { period: 60 } },
    formula: "existing bias 60",
  },
  {
    id: "bias-120",
    family: "trend",
    direction: 1,
    spec: { id: "bias", parameters: { period: 120 } },
    formula: "existing bias 120",
  },
  {
    id: "up-frequency-60",
    family: "trend",
    direction: 1,
    spec: { id: "up-frequency", parameters: { period: 60 } },
    formula: "existing up-frequency 60",
  },
  {
    id: "reversal-5",
    family: "reversal",
    direction: 1,
    spec: { id: "short-reversal", parameters: { period: 5 } },
    formula: "existing short-reversal 5",
  },
  {
    id: "reversal-20",
    family: "reversal",
    direction: 1,
    spec: { id: "short-reversal", parameters: { period: 20 } },
    formula: "existing short-reversal 20",
  },
  {
    id: "volatility-20",
    family: "low-risk",
    direction: -1,
    spec: { id: "return-volatility", parameters: { period: 20 } },
    formula: "existing return-volatility 20",
  },
  {
    id: "volatility-60",
    family: "low-risk",
    direction: -1,
    spec: { id: "return-volatility", parameters: { period: 60 } },
    formula: "existing return-volatility 60",
  },
  {
    id: "downside-60",
    family: "low-risk",
    direction: -1,
    spec: { id: "downside-deviation", parameters: { period: 60 } },
    formula: "existing downside-deviation 60",
  },
  {
    id: "drawdown-120",
    family: "low-risk",
    direction: -1,
    spec: { id: "window-drawdown", parameters: { period: 120 } },
    formula: "existing window-drawdown 120",
  },
  {
    id: "amihud-20",
    family: "liquidity",
    direction: -1,
    spec: { id: "amihud-illiquidity", parameters: { period: 20 } },
    formula: "existing amihud-illiquidity 20",
  },
  ...(
    [
      "roe-ttm",
      "roa-ttm",
      "gross-profit-assets",
      "cash-assets",
      "cash-quality",
      "net-margin-ttm",
    ] as const
  ).map((id): ClassicFactor => ({
    id,
    family: "quality",
    direction: 1,
    formula: {
      "roe-ttm": "FN96 TTM / FN271",
      "roa-ttm": "FN96 TTM / FN40",
      "gross-profit-assets":
        "latest visible annual (FN74-FN75)/FN40, nonfinancial",
      "cash-assets": "FN107 TTM / FN40, nonfinancial",
      "cash-quality": "(FN107 TTM-FN95 TTM)/FN40, nonfinancial",
      "net-margin-ttm": "FN95 TTM / FN74 TTM, nonfinancial",
    }[id],
  })),
  ...(
    [
      "earnings-yield",
      "book-to-price",
      "sales-to-price",
      "cashflow-yield",
    ] as const
  ).map((id): ClassicFactor => ({
    id,
    family: "value",
    direction: 1,
    formula: `existing local-data ${id}: same-day GP16 and visible reports`,
  })),
  {
    id: "revenue-growth",
    family: "growth",
    direction: 1,
    formula: "existing 74-yoy",
  },
  {
    id: "profit-growth",
    family: "growth",
    direction: 1,
    formula: "existing 96-yoy",
  },
  {
    id: "profit-cagr3",
    family: "growth",
    direction: 1,
    formula: "existing 96-cagr3",
  },
  {
    id: "asset-growth",
    family: "investment",
    direction: -1,
    formula: "FN40 / previous-year same-quarter FN40 - 1",
  },
  {
    id: "debt-ratio",
    family: "balance-sheet",
    direction: -1,
    formula: "existing debt-ratio; nonfinancial",
  },
  {
    id: "goodwill-ratio",
    family: "balance-sheet",
    direction: -1,
    formula: "existing goodwill-ratio; nonfinancial",
  },
];

/** Average ties, centered on zero. Constant columns carry no ranking power. */
export function classicRanks(values: readonly (number | null)[]) {
  const sorted = values
    .flatMap((value, index) =>
      value !== null && Number.isFinite(value) ? [{ value, index }] : [],
    )
    .sort((a, b) => a.value - b.value);
  const ranks: (number | null)[] = values.map(() => null);
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j]!.value === sorted[i]!.value) j++;
    const rank =
      sorted.length > 1 ? (i + j - 1) / 2 / (sorted.length - 1) - 0.5 : 0;
    for (let k = i; k < j; k++) ranks[sorted[k]!.index] = rank;
    i = j;
  }
  return ranks;
}

export function classicTechnicalSeries(stock: Csi800Stock) {
  const bars = csi800SignalBars(stock);
  return {
    bars,
    series: csi800ClassicFactors
      .filter((f) => f.spec)
      .map((f) => ({
        id: f.id,
        values: calculateFactor(bars, f.spec!).values,
      })),
  };
}

function ttm(reports: readonly FinancialReportSnapshot[], id: number) {
  const r = reports[0];
  if (!r) return null;
  const current = sourceFinancialValue(r, id);
  if (r.reportDate.endsWith("12-31")) return current;
  const year = +r.reportDate.slice(0, 4),
    suffix = r.reportDate.slice(4);
  const annual = sourceFinancialValue(
    reports.find((p) => p.reportDate === `${year - 1}-12-31`),
    id,
  );
  const previous = sourceFinancialValue(
    reports.find((p) => p.reportDate === `${year - 1}${suffix}`),
    id,
  );
  return current === null || annual === null || previous === null
    ? null
    : current + annual - previous;
}
const divide = (a: number | null, b: number | null) =>
  a !== null && b !== null && b > 0 && Number.isFinite(a / b) ? a / b : null;
/** Every constituent of a TTM/Yoy calculation must already be visible. */
export function classicFinancialFeatures(
  history: readonly FinancialReportSnapshot[],
  asOf: string,
) {
  const reports = history
    .filter((r) => financialVisibleAt(r, asOf))
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate));
  const r = reports[0];
  if (!r || (Date.parse(asOf) - Date.parse(r.reportDate)) / 86400000 > 550)
    return null;
  const metrics = new Map(
    financialMetrics(reports).map((m) => [m.id, m.value]),
  );
  const net = metrics.get("96-ttm") ?? null,
    revenue = metrics.get("74-ttm") ?? null,
    cash = metrics.get("107-ttm") ?? null;
  const assets = sourceFinancialValue(r, 40),
    equity = sourceFinancialValue(r, 271),
    merged = ttm(reports, 95);
  const annual = reports.find((p) => p.reportDate.endsWith("12-31"));
  const av = (id: number) => sourceFinancialValue(annual, id);
  const gp = av(74)! - av(75)!;
  const previous = sourceFinancialValue(
    reports.find(
      (p) =>
        p.reportDate ===
        `${+r.reportDate.slice(0, 4) - 1}${r.reportDate.slice(4)}`,
    ),
    40,
  );
  const nonfinancial = r.financialCompany === false;
  return {
    reportDate: r.reportDate,
    announcementDate: r.announcementDate,
    availableFrom: r.availableFrom,
    financialCompany: r.financialCompany,
    equity,
    values: {
      "roe-ttm": divide(net, equity),
      "roa-ttm": divide(net, assets),
      "gross-profit-assets":
        nonfinancial && av(74) !== null && av(75) !== null
          ? divide(gp, av(40))
          : null,
      "cash-assets": nonfinancial ? divide(cash, assets) : null,
      "cash-quality":
        nonfinancial && cash !== null && merged !== null
          ? divide(cash - merged, assets)
          : null,
      "net-margin-ttm": nonfinancial ? divide(merged, revenue) : null,
      "revenue-growth": metrics.get("74-yoy") ?? null,
      "profit-growth": metrics.get("96-yoy") ?? null,
      "profit-cagr3": metrics.get("96-cagr3") ?? null,
      "asset-growth":
        assets !== null && previous !== null
          ? divide(assets - previous, previous)
          : null,
      "debt-ratio": nonfinancial ? (metrics.get("debt-ratio") ?? null) : null,
      "goodwill-ratio": nonfinancial
        ? (metrics.get("goodwill-ratio") ?? null)
        : null,
    } as Record<string, number | null>,
    valuationNumerators: {
      "earnings-yield": net,
      "book-to-price": equity,
      "sales-to-price": revenue,
      "cashflow-yield": nonfinancial ? cash : null,
    } as Record<string, number | null>,
  };
}

export const csi800ClassicRecipes = [
  { id: "momentum", families: ["momentum"] },
  { id: "quality", families: ["quality"] },
  { id: "value", families: ["value"] },
  { id: "quality-value", families: ["quality", "value"] },
  { id: "value-momentum", families: ["value", "momentum"] },
  { id: "quality-value-momentum", families: ["quality", "value", "momentum"] },
  {
    id: "classic-five",
    families: ["quality", "value", "investment", "momentum", "low-risk"],
  },
  { id: "technical", families: ["momentum", "trend", "reversal", "low-risk"] },
  {
    id: "financial",
    families: ["quality", "value", "growth", "investment", "balance-sheet"],
  },
  {
    id: "combined",
    families: [
      "momentum",
      "trend",
      "reversal",
      "low-risk",
      "quality",
      "value",
      "growth",
      "investment",
      "balance-sheet",
    ],
  },
  {
    id: "combined-defensive",
    families: [
      "momentum",
      "trend",
      "reversal",
      "low-risk",
      "quality",
      "value",
      "growth",
      "investment",
      "balance-sheet",
    ],
  },
] as const;
