import { z } from "zod";
import { costMethods, type CostMethod } from "~/lib/portfolio/trade-review";
import type { replayTradeReview } from "./trade-review-service";
import { groupNavDiagnostics } from "~/lib/portfolio/nav-diagnostics";

type Snapshot = ReturnType<typeof replayTradeReview>;
export const navPageKinds = [
  "segments",
  "days",
  "warnings",
  "twrReasons",
  "feeSources",
] as const;
export type NavPageKind = (typeof navPageKinds)[number];
export const navDetailPageSize = 20;
export const navPageSchema = z.object({
  account: z.string().trim().min(1),
  kind: z.enum(navPageKinds),
  method: z.enum(costMethods).default("movingAverage"),
  pageIndex: z.number().int().min(0).max(1000000).default(0),
});

/** Full lists behind each paged review detail. */
function sources(s: Snapshot, method: CostMethod) {
  return {
    segments: () =>
      s.nav.segments.map(({ drawdowns: _drawdowns, ...segment }) => segment),
    days: () => s.nav.days,
    warnings: () => s.nav.warnings,
    twrReasons: () => s.nav.twr.reasons,
    // Fee evidence of each fill under the cost method: its first source, as
    // before, but indexed once instead of scanning all rounds per fill.
    feeSources: () => {
      const selected = s.trades[method];
      const all = [
        ...[...selected.closedRounds, ...selected.openPositions].flatMap(
          (round) => round.feeSources,
        ),
        ...s.reverseRepo.feeSources,
      ];
      const first = new Map<number, (typeof all)[number]>();
      for (const source of all)
        if (!first.has(source.fillIndex)) first.set(source.fillIndex, source);
      return s.replayInput.trades.fills.map((fill, index) => ({
        index,
        security: fill.symbol ?? fill.code,
        date: fill.tradeDate,
        sources: first.has(index) ? [first.get(index)!] : [],
      }));
    },
  };
}
type Sources = ReturnType<typeof sources>;
export type NavDetailRow<K extends NavPageKind> = ReturnType<
  Sources[K]
>[number];

/**
 * One page of a long review detail list. The snapshot response carries only
 * the first page and a count of each (the full lists were ~6 MB for a
 * 2,000-fill account); disclosures read further pages on demand.
 */
export function navDetailPage<K extends NavPageKind>(
  s: Snapshot,
  kind: K,
  method: CostMethod,
  pageIndex: number,
) {
  const rows = sources(s, method)[kind]() as NavDetailRow<K>[];
  const last = Math.max(0, Math.ceil(rows.length / navDetailPageSize) - 1);
  const index = Math.min(pageIndex, last);
  return {
    kind,
    pageIndex: index,
    pageSize: navDetailPageSize,
    total: rows.length,
    rows: rows.slice(
      index * navDetailPageSize,
      (index + 1) * navDetailPageSize,
    ),
  };
}

/** The review's nav block for the snapshot response: curve points and first pages. */
export function navSummary(s: Snapshot, method: CostMethod) {
  const {
    replay: _replay,
    segments: _segments,
    warnings: _warnings,
    days,
    twr,
    ...rest
  } = s.nav;
  return {
    ...rest,
    // Grouped over all reasons; the raw daily reasons are paged (twrReasons).
    twr: {
      value: twr.value,
      reason: twr.reason,
      groups: groupNavDiagnostics(twr.reasons),
    },
    // The curve reads only the values (a break where either is unknown); the
    // daily detail with its reasons is paged ("days").
    days: days.map((day) => ({
      date: day.date,
      nav: { value: day.nav.value },
      dailyReturn: { value: day.dailyReturn.value },
    })),
    details: {
      segments: navDetailPage(s, "segments", method, 0),
      days: navDetailPage(s, "days", method, 0),
      warnings: navDetailPage(s, "warnings", method, 0),
      twrReasons: navDetailPage(s, "twrReasons", method, 0),
      feeSources: navDetailPage(s, "feeSources", method, 0),
    },
  };
}
