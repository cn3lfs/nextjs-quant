import { readTdxLocalBlocks } from "tstdx/local";
import { chartSymbolHref } from "~/lib/chart/chart-symbol";
import { poolMembersHref } from "~/lib/market/market-pool";
import {
  beijingCalendarDate,
  sectorValuationCategories,
  type SectorValuationCategory,
} from "~/lib/financial/sector-valuation";
import { sqlite } from "../db";
import { ClsReviewStore } from "../db/cls-review-store";
import { settings } from "../infra/settings";
import { readBars } from "../market/bar-store/read-bars";
import { marketPoolCatalog } from "../market/market-pool-files";
import { securityDirectory } from "../market/securities";

type Close = { date: string; close: number };
type WindowReturn = Close & { returnPct: number };
export type ForwardReturnResult = {
  status: "ok" | "no-data";
  baseDate: string;
  baseTradeDate: string | null;
  baseClose: number | null;
  t5: WindowReturn | null;
  t10: WindowReturn | null;
  t20: WindowReturn | null;
  latest: (WindowReturn & { tradingDays: number }) | null;
  elapsedTradingDays: number;
};

/**
 * Input is ordered by trading date. When a market trading calendar is provided,
 * T0 and T+5/T+10/T+20 align strictly to market trading days; suspended or missing
 * sessions stay null instead of shifting the target window forward.
 */
export function computeForwardReturnWindows(
  bars: readonly Close[],
  baseDate: string,
  calendarDates?: readonly string[],
): ForwardReturnResult {
  const byDate = new Map<string, Close>();
  for (const bar of bars) {
    if (
      bar.date >= baseDate &&
      Number.isFinite(bar.close) &&
      bar.close > 0 &&
      !byDate.has(bar.date)
    )
      byDate.set(bar.date, bar);
  }
  const calendar =
    calendarDates && calendarDates.length > 0
      ? [...new Set(calendarDates.filter((d) => d >= baseDate))].sort()
      : [...byDate.keys()].sort();
  const baseTradeDate = calendar[0] ?? null;
  const base = baseTradeDate ? byDate.get(baseTradeDate) : undefined;
  function windowAt(index: number): WindowReturn | null {
    const targetDate = calendar[index];
    const bar = targetDate ? byDate.get(targetDate) : undefined;
    if (!base || !bar) return null;
    const returnPct = (bar.close / base.close - 1) * 100;
    return Number.isFinite(returnPct)
      ? { date: bar.date, close: bar.close, returnPct }
      : null;
  }
  const elapsedTradingDays = Math.max(0, calendar.length - 1);
  const last = elapsedTradingDays ? windowAt(elapsedTradingDays) : null;
  return {
    status: base ? "ok" : "no-data",
    baseDate,
    baseTradeDate,
    baseClose: base?.close ?? null,
    t5: windowAt(5),
    t10: windowAt(10),
    t20: windowAt(20),
    latest: last && { ...last, tradingDays: elapsedTradingDays },
    elapsedTradingDays,
  };
}

export function extractSectionSummary(sectionText: string) {
  const lines = sectionText
    .replace(/^\s*```[^\n]*\n[\s\S]*?^\s*```[^\n]*$/gm, "")
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^(?:>\s*|[-*+]\s+|\d+[.)]\s+)+/, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\*\*|__|`/g, "")
        .trim(),
    )
    .filter(
      (line) =>
        line &&
        !/^(?:#{1,6}\s|\||[-*_=]{3,}$|(?:情绪方向|方向|信心|置信度|来源)[：:])/.test(
          line,
        ),
    );
  const viewpoint = /^(?:核心逻辑|核心观点|板块观点|观点|结论)[：:]\s*(.+)$/;
  const preferred = lines
    .map((line) => viewpoint.exec(line)?.[1])
    .filter(Boolean);
  const summary = (
    preferred.length ? preferred : lines.filter((line) => !/[：:]$/.test(line))
  )
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(summary);
  return chars.length > 240 ? chars.slice(0, 239).join("") + "…" : summary;
}

type SectorEntry = {
  category: SectorValuationCategory;
  name: string;
  sectorSymbol?: string | null;
  selectionName?: string;
};

function normalizeSectorName(name: string) {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/(?:行业|概念)?板块$|(?:行业|概念)$/, "");
}

export function resolveSectionTarget(
  sectionName: string,
  catalog: readonly SectorEntry[],
) {
  const name = sectionName.trim();
  const query = normalizeSectorName(name);
  let matches = catalog.filter(
    (row) => row.name === name || row.selectionName === name,
  );
  if (!matches.length && query) {
    matches = catalog.filter((row) => normalizeSectorName(row.name) === query);
  }
  const match = matches.length === 1 ? matches[0] : null;
  // Keep links aligned with readMarketPoolLocation search/pool params.
  if (!match) {
    const search = encodeURIComponent(name);
    return {
      href: `/scan?tab=pool&search=${search}`,
      sectorSymbol: null,
      category: null,
      matchedName: null,
    };
  }
  const pool = match.selectionName ?? match.name;
  return {
    href: match.sectorSymbol
      ? chartSymbolHref(match.sectorSymbol)
      : `${poolMembersHref(match.category, pool)}&category=${match.category}&name=${encodeURIComponent(pool)}`,
    sectorSymbol: match.sectorSymbol ?? null,
    category: match.category,
    matchedName: match.name,
  };
}

async function sectorCatalog(root: string, blocksRoot: string) {
  const [local, pools] = await Promise.all([
    root ? readTdxLocalBlocks(root).catch(() => null) : null,
    Promise.all(
      sectorValuationCategories.map(async (category) => {
        const pool = await marketPoolCatalog(blocksRoot, category, root).catch(
          () => null,
        );
        return { category, names: pool?.names ?? [] };
      }),
    ),
  ]);
  const entries: SectorEntry[] = [];
  for (const { category, names } of pools) {
    const poolNames = new Set(names);
    for (const block of local?.blocks ?? []) {
      if (
        block.category !== category ||
        (!block.code && !poolNames.has(block.selectionName))
      )
        continue;
      entries.push({
        category,
        name: block.name,
        selectionName: block.selectionName,
        sectorSymbol: block.code ? `sh${block.code}` : null,
      });
      poolNames.delete(block.selectionName);
      // The same sector may also have a plain-name external pool.
      poolNames.delete(block.name);
    }
    for (const name of poolNames) entries.push({ category, name });
  }
  return entries;
}

export async function clsReportForwardReturns(reportId: string) {
  const archive = new ClsReviewStore(sqlite()).report(reportId);
  if (!archive) return null;
  const { report, importedAt } = archive;
  const baseDate = report.reportDate ?? beijingCalendarDate(importedAt);
  const baseDateSource: "reportDate" | "importedAt" = report.reportDate
    ? "reportDate"
    : "importedAt";
  const { tdxRoot, industryBlocksRoot } = settings();
  const [directory, catalog] = await Promise.all([
    securityDirectory().catch(() => null),
    sectorCatalog(tdxRoot, industryBlocksRoot),
  ]);
  const sections = report.sections.map((section) => ({
    section,
    target: resolveSectionTarget(section.name, catalog),
    symbols: [...new Set(section.mentionedSymbols)],
  }));
  const allSymbols = new Set<string>();
  for (const { symbols, target } of sections) {
    for (const symbol of symbols) allSymbols.add(symbol);
    if (target.sectorSymbol) allSymbols.add(target.sectorSymbol);
  }
  const returns = new Map<string, ForwardReturnResult>();
  const symbols = [...allSymbols];
  const now = Date.now();
  const benchmark = await readBars({
    instrument: { market: "cn-equity", symbol: "sh000001" },
    root: tdxRoot,
    period: "day",
    from: baseDate,
    adjustment: "none",
    source: "local",
    now,
  }).catch(() => null);
  const benchmarkForming = new Set(benchmark?.barStore.formingDates);
  const marketCalendar = benchmark?.bars
    .filter((bar) => !benchmarkForming.has(bar.date))
    .map((bar) => bar.date);
  // Bound simultaneous full-file reads without dropping older reports' T0 or any stock.
  const batchSize = 4;
  for (let start = 0; start < symbols.length; start += batchSize) {
    await Promise.all(
      symbols.slice(start, start + batchSize).map(async (symbol) => {
        const series =
          symbol === "sh000001"
            ? benchmark
            : await readBars({
                instrument: { market: "cn-equity", symbol },
                root: tdxRoot,
                period: "day",
                from: baseDate,
                adjustment: "none",
                source: "local",
                now,
              }).catch(() => null);
        const forming = new Set(series?.barStore.formingDates);
        returns.set(
          symbol,
          computeForwardReturnWindows(
            series?.bars.filter((bar) => !forming.has(bar.date)) ?? [],
            baseDate,
            marketCalendar && marketCalendar.length > 0
              ? marketCalendar
              : undefined,
          ),
        );
      }),
    );
  }
  return {
    reportId,
    title: report.title,
    baseDate,
    baseDateSource,
    sections: sections.map(({ section, symbols, target }) => {
      const sector = target.sectorSymbol
        ? returns.get(target.sectorSymbol)
        : null;
      return {
        id: section.id,
        name: section.name,
        direction: section.direction,
        confidence: section.confidence,
        summary: extractSectionSummary(section.text),
        sectorHref: target.href,
        sectorSymbol: target.sectorSymbol,
        sectorReturns: sector?.status === "ok" ? sector : null,
        stocks: symbols.map((symbol) => ({
          symbol,
          name: directory?.entries[symbol]?.name ?? symbol,
          href: chartSymbolHref(symbol),
          returns: returns.get(symbol)!,
        })),
      };
    }),
  };
}
