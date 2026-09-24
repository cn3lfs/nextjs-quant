import type { Query, QueryClient } from "@tanstack/react-query";

/**
 * Client cache policy for tRPC queries (flat router: the key starts with
 * `[procedureName]`).
 *
 * - `staleTimes`: how long data counts as fresh before a remount or restore
 *   refetches it in the background. Unlisted queries keep the 30 s default.
 * - `persisted`: queries restored from IndexedDB after a reload or restart.
 *   The cached value renders at once and is revalidated in the background, so
 *   new content still replaces it. Realtime quotes, job progress, settings and
 *   credentials are never persisted.
 */
const MIN = 60_000;
const HOUR = 60 * MIN;

export const staleTimes: Record<string, number> = {
  // Reference data: changes at most daily.
  securityNames: HOUR,
  securities: HOUR,
  securityProfile: HOUR,
  indexDirectory: HOUR,
  marketPoolCatalog: HOUR,
  tdxCompanyInfo: HOUR,
  tdxCompanyInfoContent: HOUR,
  researchSkills: HOUR,
  // Daily or slower data; the server keeps its own caches as well.
  tdxLocalFinancials: 30 * MIN,
  tdxFinance: 30 * MIN,
  stockEvents: 30 * MIN,
  capitalProfile: 30 * MIN,
  macroRates: 30 * MIN,
  valuationHistory: 10 * MIN,
  rpsCurve: 10 * MIN,
  archivedReport: HOUR,
  reportHistory: 5 * MIN,
  fundamentalHistory: 5 * MIN,
  financialQualityHistory: 5 * MIN,
  chanHistory: 5 * MIN,
  canslimHistory: 5 * MIN,
  wyckoffHistory: 5 * MIN,
  walkForwardHistory: 5 * MIN,
  newsThemes: 5 * MIN,
  newsSectorReports: 5 * MIN,
};

export const persisted = new Set<string>([
  ...Object.keys(staleTimes),
  "limitSentiment",
  "marketPoolPage",
  "industryRpsPage",
  "conceptRpsPage",
  "chartView",
]);

export const PERSIST_MAX_AGE = 3 * 24 * HOUR;

const procedureOf = (key: readonly unknown[]) => {
  const head = key[0];
  return Array.isArray(head) && typeof head[0] === "string" ? head[0] : null;
};

export function shouldPersistQuery(query: Query) {
  const name = procedureOf(query.queryKey);
  return (
    !!name && persisted.has(name) && query.state.status === "success"
  );
}

export function applyCachePolicy(client: QueryClient) {
  for (const name of persisted)
    client.setQueryDefaults([[name]], {
      ...(staleTimes[name] ? { staleTime: staleTimes[name] } : {}),
      // Unobserved queries must outlive the persist window or they are
      // garbage-collected before being written.
      gcTime: PERSIST_MAX_AGE,
    });
}
