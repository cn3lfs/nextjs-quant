import type { ScreeningFormula } from "~/lib/formula/formula-screen";
import type { ScreeningResult } from "./screening-result";
import type { Candidate } from "~/lib/domain";
import { securityDisplayName } from "~/lib/market/security-display";
import type { ScreenSort } from "~/lib/screening/screen-sort";

export type StoredScreenResult = Omit<ScreeningResult, "snapshots"> & {
  formula: ScreeningFormula;
  adjustment?: "none" | "forward" | "backward";
  period: "day";
  researchMode: "latest-local";
  universeSource: string;
  researchWarnings: string[];
};
/** Shared by in-memory paging and the SQLite search predicate. Query is normalized. */
export function matchesScreenCandidate(
  candidate: Pick<Candidate, "symbol" | "name">,
  query: string,
  currentNames: Record<string, string>,
) {
  return (
    !query ||
    candidate.symbol.includes(query) ||
    candidate.name.toLowerCase().includes(query) ||
    securityDisplayName(candidate.symbol, currentNames, candidate.name)
      .toLowerCase()
      .includes(query)
  );
}
export function pageScreenResults(
  result: StoredScreenResult,
  input: {
    page: number;
    query: string;
    excludedPage: number;
    errorPage: number;
    sort?: ScreenSort;
    direction?: "asc" | "desc";
  },
  currentNames: Record<string, string> = {},
) {
  const query = input.query.trim().toLowerCase();
  const candidates = result.candidates.filter((c) =>
    matchesScreenCandidate(c, query, currentNames),
  );
  const slice = <T>(rows: T[], page: number) =>
    rows.slice(page * 50, (page + 1) * 50);
  const sort = input.sort ?? "original",
    direction = input.direction ?? "desc";
  if (sort !== "original") {
    const codeOrder = (a: Candidate, b: Candidate) =>
      a.symbol < b.symbol ? -1 : a.symbol > b.symbol ? 1 : 0;
    candidates.sort((a, b) => {
      if (sort === "symbol")
        return codeOrder(a, b) * (direction === "asc" ? 1 : -1);
      const av = a.metrics?.[sort],
        bv = b.metrics?.[sort];
      const aValid = typeof av === "number" && Number.isFinite(av),
        bValid = typeof bv === "number" && Number.isFinite(bv);
      if (!aValid || !bValid) return aValid ? -1 : bValid ? 1 : codeOrder(a, b);
      return (av - bv) * (direction === "asc" ? 1 : -1) || codeOrder(a, b);
    });
  }
  // Explicit fields prevent future stored snapshots/evidence from leaking into list responses.
  return {
    sort,
    formula: result.formula,
    adjustment: result.adjustment ?? "none",
    direction,
    total: result.total,
    asOf: result.asOf,
    elapsedMs: result.elapsedMs,
    period: result.period,
    researchMode: result.researchMode,
    universeSource: result.universeSource,
    researchWarnings: result.researchWarnings,
    candidates: slice(candidates, input.page),
    count: candidates.length,
    candidateTotal: result.candidates.length,
    excluded: slice(result.excluded, input.excludedPage),
    excludedTotal: result.excluded.length,
    errors: slice(result.errors, input.errorPage),
    errorTotal: result.errors.length,
  };
}
