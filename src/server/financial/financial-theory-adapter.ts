import {
  calculateLocalDataFactors,
  type LocalFactorSource,
} from "trading-strategy-core/factors";
import {
  sourceFinancialValue,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import { evaluateFinancialTheory } from "trading-strategies/research/financial-theory";

/** No online fallback: GP16 must contain exactly one valid same-day observation. */
export function localFinancialTheory(
  reports: readonly FinancialReportSnapshot[],
  asOf: string,
  strict: boolean,
  stock?: LocalFactorSource,
) {
  const annual = reports
    .filter(
      (r) =>
        r.reportDate.endsWith("-12-31") &&
        r.reportDate <= asOf &&
        (!r.announcementDate || r.announcementDate <= asOf) &&
        (!strict ||
          (!!r.announcementDate &&
            r.announcementDate > r.reportDate &&
            !!r.availableFrom &&
            r.availableFrom <= asOf)),
    )
    .sort((a, b) => b.reportDate.localeCompare(a.reportDate))[0];
  const debtCodes = [41, 52, 55, 56];
  const debtValues = debtCodes.map((code) =>
    sourceFinancialValue(annual, code),
  );
  const cap = calculateLocalDataFactors({
    ids: ["GP16-0"],
    asOf,
    stock,
    reports,
  })[0];
  return evaluateFinancialTheory(reports, {
    asOf,
    strict,
    marketCapitalization: {
      value: cap?.value ?? null,
      unit: "元",
      source: stock?.sourceSha256 ?? "",
      asOf,
      reason:
        cap?.reason ??
        (cap?.value !== undefined && cap.value !== null && stock?.sourceSha256
          ? "同日GP16总市值；使用原始记录并按字段单位换算为元"
          : "同日GP16总市值缺失或来源身份缺失"),
    },
    interestBearingDebt: {
      value: debtValues.every((v) => v !== null && v >= 0)
        ? debtValues.reduce<number>((sum, v) => sum + v!, 0)
        : null,
      unit: "元",
      source: annual?.sourceSha256 ?? "",
      asOf: annual?.reportDate ?? "",
      reason:
        "本地四项债务口径 FN41+FN52+FN55+FN56；缺项或未认证源零不推定为零，不包括无法分离的其他融资项目",
    },
  });
}
