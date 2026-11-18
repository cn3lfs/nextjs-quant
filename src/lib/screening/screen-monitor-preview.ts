import type { Candidate } from "~/lib/domain";
import {
  monitorPrefillHref,
  monitorSymbolLimit,
} from "~/lib/strategy-facts/monitor-workspace-draft";

/** The confirmed page rows the preview shows and the draft link carries. */
export type ScreenMonitorCandidate = Pick<
  Candidate,
  "symbol" | "name" | "snapshotId" | "metrics"
>;

export type ScreenMonitorPreview = {
  /** Unsaved draft name, matching the link handed to the signals page. */
  name: string;
  href: string;
  /** Same order as the confirmed table page, cut to the subscription limit. */
  rows: { symbol: string; name: string; date: string }[];
  limit: number;
  /** Rows this draft would carry. */
  included: number;
  /** Confirmed-page rows beyond the limit, left out of this draft. */
  overflow: number;
  /** Rows on the confirmed page; `totalCount` is the filtered total, not
   * `candidateTotal`. */
  pageCount: number;
  totalCount: number;
  asOf: string | null;
};

/**
 * Builds the preview and the draft link from the same snapshot array. The
 * server already applied the query/sort, so `count` is the filtered total and
 * the slice order is the order shown in the table.
 */
export function screenMonitorPreview(input: {
  asOf: string | null;
  count: number;
  candidates: readonly ScreenMonitorCandidate[];
  limit?: number;
}): ScreenMonitorPreview | null {
  const limit = input.limit ?? monitorSymbolLimit;
  if (input.candidates.length === 0) return null;
  const rows = input.candidates.slice(0, limit).map((candidate) => ({
    symbol: candidate.symbol,
    name: candidate.name,
    date: candidate.metrics.date,
  }));
  const pageCount = input.candidates.length;
  const preview = {
    name: `选股候选 ${input.asOf ?? ""}`.trim(),
    rows,
    limit,
    included: rows.length,
    overflow: pageCount - rows.length,
    pageCount,
    totalCount: input.count,
    asOf: input.asOf,
  };
  return {
    ...preview,
    href: monitorPrefillHref({
      name: preview.name,
      symbols: rows.map((row) => row.symbol),
    }),
  };
}

/**
 * Content identity of the confirmed page: candidate order and snapshot ids,
 * the run's base date and the numbers the preview labels. A background refresh
 * that keeps the same page key still changes this when the rows change.
 */
export function screenMonitorContentSignature(input: {
  asOf: string | null;
  count: number;
  candidates: readonly ScreenMonitorCandidate[];
  limit?: number;
}) {
  return JSON.stringify([
    input.asOf,
    input.count,
    input.limit ?? monitorSymbolLimit,
    input.candidates.map((candidate) => [
      candidate.symbol,
      candidate.snapshotId,
      candidate.metrics.date,
    ]),
  ]);
}

/** A confirmation may only use the page captured when the preview opened. */
export function screenMonitorCaptureMatches(
  captured: { key: string; content: string; urlKey: string },
  latest: { key: string; content: string; urlKey: string },
) {
  return (
    captured.key === latest.key &&
    captured.content === latest.content &&
    captured.urlKey === latest.urlKey
  );
}
