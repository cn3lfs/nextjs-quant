import type { FinancialMetric } from "./local-financial";

export function displayFinancialNumber(value: number | null, unit: string) {
  if (value === null || !Number.isFinite(value)) return "—";
  if (unit === "日期" || unit === "时间" || unit === "枚举")
    return String(value);
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 4 }).format(
    value,
  );
}

type RatioDisplay = "percent" | "multiple" | "turnover";
const metricRatios: Readonly<Record<string, RatioDisplay>> = {
  "debt-ratio": "percent",
  "net-margin": "percent",
  "parent-roe": "percent",
  "goodwill-ratio": "percent",
  "receivables-ratio": "percent",
  "inventory-ratio": "percent",
  "gross-margin": "percent",
  "cash-to-profit": "multiple",
  "current-ratio": "multiple",
};
const annualRatios: Readonly<Record<string, RatioDisplay>> = {
  netMargin: "percent",
  roe: "percent",
  reportedProfitRoa: "percent",
  grossMargin: "percent",
  cashReturnOnOpeningAssets: "percent",
  currentRatio: "multiple",
  cashToProfit: "multiple",
  equityMultiplier: "multiple",
  assetTurnover: "turnover",
};

/** Input is a fraction, never an already-scaled percentage. */
export function displayFinancialRatio(
  value: number | null,
  kind: RatioDisplay = "percent",
) {
  if (value === null || !Number.isFinite(value)) return "—";
  const scaled = kind === "percent" ? value * 100 : value;
  if (!Number.isFinite(scaled)) return "—";
  const suffix = kind === "percent" ? "%" : kind === "multiple" ? "倍" : "次";
  return `${scaled.toFixed(2)}${suffix}`;
}

/** Display conversion only: calculations, filter thresholds and exports keep their source units. */
export function displayFinancialMetric(
  metric: Pick<FinancialMetric, "id" | "value" | "unit">,
  currencyUnit = "元",
) {
  const { id, value, unit } = metric;
  if (value === null || !Number.isFinite(value)) return "—";
  if (unit === "比例" && metricRatios[id])
    return displayFinancialRatio(value, metricRatios[id]);
  if (unit === "%") return `${value.toFixed(2)}%`;
  const scale =
    unit === "元"
      ? currencyUnit === "亿元"
        ? 1e8
        : currencyUnit === "万元"
          ? 1e4
          : 1
      : 1;
  return `${displayFinancialNumber(value / scale, unit)} ${unit === "元" ? currencyUnit : unit}`;
}

export function displayAnnualFinancialRatio(key: string, value: number | null) {
  const kind = annualRatios[key];
  return kind
    ? displayFinancialRatio(value, kind)
    : displayFinancialMetric({ id: key, value, unit: "比例" });
}
