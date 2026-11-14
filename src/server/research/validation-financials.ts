import { calculateLocalDataFactors } from "trading-strategy-core/factors";
import { financialVisibleAt } from "tstdx/financial-model";
import type { LowZoneFact } from "trading-strategies";
import {
  readLocalFinancialHistory,
  readLocalFinancialSeries,
} from "../data-sources/tdx/local-financial-files";

/** Reuse local TDX field units and PIT financial math; never turn missing
 * market-cap history, announcement dates, or market temperature into proxies. */
export async function captureLowZoneFinancials(
  root: string,
  symbol: string,
  dates: readonly string[],
) {
  const [history, series] = await Promise.all([
    readLocalFinancialHistory(root, symbol, {
      asOf: dates.at(-1)!,
      strict: true,
      limit: 160,
    }),
    readLocalFinancialSeries(root, symbol),
  ]);
  const facts: LowZoneFact[] = dates.map((date) => {
    const reports = history.reports
      .filter((r) => financialVisibleAt(r, date))
      .sort((a, b) => b.reportDate.localeCompare(a.reportDate));
    const values = calculateLocalDataFactors({
      ids: ["pe-ttm", "pb"],
      asOf: date,
      stock: series,
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
  return {
    facts,
    reports: history.reports.map((r) => ({
      ...r,
      fields: r.fields.filter((f) => ["FN96", "FN271"].includes(f.code)),
    })),
    series,
    seriesHash: series.sourceSha256,
    issues: history.issues,
    gaps: [
      "Downloaded financial revisions are not certified first releases",
      "Historical full market-temperature series unavailable; index trend is not substituted",
    ],
  };
}
