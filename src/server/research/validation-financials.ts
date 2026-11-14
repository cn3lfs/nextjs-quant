import { calculateLocalDataFactors } from "trading-strategy-core/factors";
import type { LocalFactorSource } from "trading-strategy-core/factors";
import { financialVisibleAt } from "tstdx/financial-model";
import type { FinancialReportSnapshot } from "tstdx/financial-model";
import type { LowZoneFact } from "trading-strategies";
import {
  readLocalFinancialHistory,
  readLocalFinancialSeries,
  readFinancialPoolHistory,
} from "../data-sources/tdx/local-financial-files";

/** Reuse local TDX field units and PIT financial math; never turn missing
 * market-cap history, announcement dates, or market temperature into proxies. */
export async function captureLowZoneFinancials(
  root: string,
  symbol: string,
  dates: readonly string[],
  pool?: Awaited<ReturnType<typeof readFinancialPoolHistory>>,
) {
  const [history, series] = await Promise.all([
    pool
      ? Promise.resolve({
          reports: pool.reports.get(symbol) ?? [],
          issues: pool.issues,
        })
      : readLocalFinancialHistory(root, symbol, {
          asOf: dates.at(-1)!,
          strict: true,
          limit: 160,
        }),
    readLocalFinancialSeries(root, symbol),
  ]);
  const facts = lowZoneFinancialFacts(history.reports, series, dates);
  return {
    facts,
    reports: history.reports.map((r) => ({
      ...r,
      fields: r.fields.filter((f) => ["FN96", "FN271"].includes(f.code)),
    })),
    // PE/PB consume GP16 only. Keep every GP16 row (including duplicates and
    // unknown dates) and the whole-source hash, not unrelated financial groups.
    series: {
      ...series,
      records: series.records.filter((r) => r.group === 16),
    },
    seriesCoverage: {
      originalRecords: series.records.length,
      retainedGroup: 16,
    },
    seriesHash: series.sourceSha256,
    issues: history.issues,
    gaps: [
      "Downloaded financial revisions are not certified first releases",
      "Historical full market-temperature series unavailable; index trend is not substituted",
    ],
  };
}

export function lowZoneFinancialFacts(
  history: readonly FinancialReportSnapshot[],
  series: LocalFactorSource,
  dates: readonly string[],
): LowZoneFact[] {
  // Factors require exactly the same day's records. Preserve duplicates and
  // missing dates while avoiding a full GP-file scan for every valuation day.
  const byDate = new Map<number, typeof series.records>();
  for (const record of series.records) {
    if (record.date === null) continue;
    const rows = byDate.get(record.date) ?? [];
    rows.push(record);
    byDate.set(record.date, rows);
  }
  return dates.map((date) => {
    const reports = history
      .filter((r) => financialVisibleAt(r, date))
      .sort((a, b) => b.reportDate.localeCompare(a.reportDate));
    const values = calculateLocalDataFactors({
      ids: ["pe-ttm", "pb"],
      asOf: date,
      stock: {
        ...series,
        records: byDate.get(Number(date.replaceAll("-", ""))) ?? [],
      },
      reports,
    });
    return {
      date,
      availableAt: date,
      pe: values.find((r) => r.id === "pe-ttm")?.value ?? null,
      pb: values.find((r) => r.id === "pb")?.value ?? null,
      temperature: null,
      confidence: "approximate",
      source: `Current TDX revision, PIT announcements enforced; series SHA256 ${series.sourceSha256}; no first-vintage certification`,
    };
  });
}
