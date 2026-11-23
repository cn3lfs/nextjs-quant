import type { FinancialReportSnapshot } from "tstdx/financial-model";

export function strictPitReports(reports: readonly FinancialReportSnapshot[]) {
  return reports
    .filter(
      (report): report is FinancialReportSnapshot & { availableFrom: string } =>
        typeof report.announcementDate === "string" &&
        report.announcementDate > report.reportDate &&
        typeof report.availableFrom === "string" &&
        report.availableFrom > report.announcementDate,
    )
    .sort((a, b) => a.availableFrom.localeCompare(b.availableFrom));
}

export type PitDuplicateIssue = {
  file?: string;
  message: string;
  code?: string;
  symbol?: string;
  reportDate?: string;
  recordOffsets?: number[];
};

export function pitDuplicateIssues(
  reports: readonly FinancialReportSnapshot[],
  issues: readonly unknown[] = [],
): PitDuplicateIssue[] {
  const periods = new Map<string, FinancialReportSnapshot[]>();
  for (const report of reports) {
    const key = `${report.symbol}/${report.reportDate}`;
    const records = periods.get(key) ?? [];
    records.push(report);
    periods.set(key, records);
  }
  const duplicates: PitDuplicateIssue[] = [];
  for (const records of periods.values()) {
    if (records.length < 2) continue;
    const { sourceFilename, symbol, reportDate } = records[0]!;
    duplicates.push({
      file: sourceFilename,
      symbol,
      reportDate,
      message: `${symbol} ${reportDate} 存在 ${records.length} 条重复财报记录`,
      recordOffsets: records.map((record) => record.recordOffset),
    });
  }
  for (const issue of issues) {
    if (typeof issue !== "object" || issue === null) continue;
    const row = issue as Record<string, unknown>;
    const file = row.file ?? row.filename;
    const message = row.message ?? row.reason;
    const code = typeof row.code === "string" ? row.code : undefined;
    if (
      !/duplicate|重复/i.test(
        `${code ?? ""} ${typeof message === "string" ? message : ""}`,
      )
    )
      continue;
    duplicates.push({
      ...(typeof file === "string" && { file }),
      ...(code && { code }),
      message: typeof message === "string" ? message : code!,
    });
  }
  return duplicates;
}
