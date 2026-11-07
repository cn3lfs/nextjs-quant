import { createHash } from "node:crypto";
import {
  financialMetrics,
  financialVersions,
  type FinancialReportSnapshot,
} from "trading-strategy-core/financial";
import {
  financialQualityFromAnnual,
  type FinancialAnnualInput,
} from "../strategies/value/financial-quality";
import { financialGrowthFromFacts } from "../strategies/value/financial-growth";
import { readLocalFinancialHistory } from "../data-sources/tdx/local-financial-files";

const annualFields = {
  revenue: 74,
  operatingCost: 75,
  netProfit: 95,
  parentProfit: 96,
  minorityProfit: 97,
  assets: 40,
  equity: 72,
  currentAssets: 21,
  currentLiabilities: 54,
  operatingCashFlow: 107,
} as const;
export function localFinancialAnnualInput(
  reports: readonly FinancialReportSnapshot[],
): FinancialAnnualInput {
  return {
    annual: reports
      .filter((report) => report.reportDate.endsWith("-12-31"))
      .sort((a, b) => a.reportDate.localeCompare(b.reportDate))
      .map((report) => ({
        period: report.reportDate.replaceAll("-", ""),
        amountUnit: "yuan",
        amounts: Object.fromEntries(
          Object.entries(annualFields).map(([name, id]) => {
            const field = report.fields.find(
                (field) => field.code === `FN${id}`,
              ),
              applicable =
                report.financialCompany === false ||
                ![
                  "operatingCost",
                  "currentAssets",
                  "currentLiabilities",
                ].includes(name),
              valid =
                applicable && field?.status === "value" && field.unit === "元";
            const reason = valid
              ? []
              : [
                  !applicable
                    ? "金融企业或行业未核验，不使用通用毛利率/流动性口径"
                    : (field?.reason ?? "本地年度字段缺失或单位未确认"),
                ];
            const evidenceId = `tdx-financial-${report.sourceSha256}-${report.recordOffset}-FN${id}`;
            return [
              name,
              {
                value: valid ? field!.value : null,
                currency: null,
                points: [
                  {
                    field: `FN${id}`,
                    raw: field?.raw ?? null,
                    rawUnit: field?.rawUnit ?? null,
                    value: valid ? field!.value : null,
                    currency: null,
                    reasons: reason,
                    evidenceId,
                  },
                ],
                reasons: reason,
              },
            ];
          }),
        ) as FinancialAnnualInput["annual"][number]["amounts"],
      })),
    rejected: [],
  };
}
const digest = (content: unknown) =>
  createHash("sha256").update(JSON.stringify(content)).digest("hex");
export async function buildLocalFinancialArchive(
  root: string,
  symbol: string,
  reportDate?: string,
  signal?: AbortSignal,
) {
  const history = await readLocalFinancialHistory(root, symbol, {
    limit: 40,
    reportDate,
    signal,
  });
  if (!history.reports.length)
    throw new Error("没有可归档的本地财报，不能创建空档案");
  const quality = financialQualityFromAnnual(
    symbol,
    localFinancialAnnualInput(history.reports),
  );
  const content = {
    version: "local-financial-archive-v1" as const,
    symbol,
    reportDate: reportDate ?? null,
    versions: financialVersions,
    reports: history.reports,
    issues: history.issues,
    quality,
    metrics: history.reports.map((report) => ({
      reportDate: report.reportDate,
      metrics: financialMetrics(history.reports, report.reportDate),
    })),
    warning: history.warning,
  };
  const hash = digest(content),
    id = `local-financial-${hash}`;
  return {
    id,
    hash,
    createdAt: Date.now(),
    ...content,
    growth: financialGrowthFromFacts(quality, id),
  };
}
export type LocalFinancialArchive = Awaited<
  ReturnType<typeof buildLocalFinancialArchive>
>;
export function verifyLocalFinancialArchive(archive: LocalFinancialArchive) {
  const { id, hash, createdAt: _createdAt, growth, ...content } = archive;
  if (
    digest(content) !== hash ||
    id !== `local-financial-${hash}` ||
    JSON.stringify(
      financialQualityFromAnnual(
        archive.symbol,
        localFinancialAnnualInput(archive.reports),
      ),
    ) !== JSON.stringify(archive.quality) ||
    JSON.stringify(financialGrowthFromFacts(archive.quality, id)) !==
      JSON.stringify(growth)
  )
    throw new Error("本地财务档案内容或计算版本校验失败");
  return archive;
}
