import type { Candidate, Period, Job } from "~/lib/domain";
import { strategySchema, periodSchema, symbolSchema } from "~/lib/domain";
import { z } from "zod";
import type { ScreenDataHealth } from "./data-health";
import { historicalScreenSchema } from "~/lib/historical-screen";
import type { PoolContext } from "./pool-context";
import { securityDisplayName } from "~/lib/security-display";
import type { ScreenSort } from "~/lib/screen-sort";
export type StoredScreenResult = {
  formula?: import("~/lib/formula-screen").ScreeningFormula;
  candidates: Candidate[];
  errors: { symbol: string; error: string }[];
  excluded?: { symbol: string; name?: string; date?: string; reason: string }[];
  total: number;
  asOf?: string | null;
  elapsedMs?: number;
  period?: Period;
  dataHealth?: ScreenDataHealth;
  researchMode?: string;
  requestedAsOf?: string | null;
  universeSource?: string;
  researchWarnings?: string[];
  poolContext?: PoolContext;
};
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
  const candidates = result.candidates.filter(
    (c) =>
      !query ||
      c.symbol.includes(query) ||
      c.name.toLowerCase().includes(query) ||
      securityDisplayName(c.symbol, currentNames, c.name)
        .toLowerCase()
        .includes(query),
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
    formula: result.formula ?? null,
    direction,
    total: result.total,
    asOf: result.asOf,
    elapsedMs: result.elapsedMs,
    period: result.period,
    dataHealth: result.dataHealth ?? null,
    poolContext: result.poolContext ?? null,
    researchMode: result.researchMode ?? "latest-local",
    requestedAsOf: result.requestedAsOf ?? null,
    universeSource: result.universeSource ?? "旧任务未记录",
    researchWarnings: result.researchWarnings ?? [],
    candidates: slice(candidates, input.page),
    count: candidates.length,
    candidateTotal: result.candidates.length,
    excluded: slice(result.excluded ?? [], input.excludedPage),
    excludedTotal: result.excluded?.length ?? 0,
    errors: slice(result.errors, input.errorPage),
    errorTotal: result.errors.length,
  };
}
export function exportScreenResults(job: Job) {
  if (job.type !== "screen" || job.status !== "completed" || !job.result)
    throw new Error("只能导出已完成的本地选股任务");
  const input = historicalScreenSchema
    .extend({
      strategy: strategySchema,
      period: periodSchema,
      symbols: z.array(symbolSchema),
      root: z.string().optional(),
    })
    .parse(job.input);
  const result = job.result as StoredScreenResult;
  return {
    format: "quant-screen-export-1",
    jobId: job.id,
    createdAt: job.createdAt,
    completedAt: job.updatedAt,
    source: "tdx-local",
    adjustment: "none",
    parameters: input,
    asOf: result.asOf ?? null,
    elapsedMs: result.elapsedMs ?? null,
    dataHealth: result.dataHealth ?? null,
    poolContext: result.poolContext ?? null,
    researchMode: result.researchMode ?? "latest-local",
    requestedAsOf: result.requestedAsOf ?? null,
    universeSource: result.universeSource ?? "旧任务未记录",
    researchWarnings: result.researchWarnings ?? [],
    total: result.total,
    candidateTotal: result.candidates.length,
    candidates: result.candidates,
    excluded: result.excluded ?? [],
    errors: result.errors,
    warnings: !result.asOf
      ? ["旧任务未记录统一基准日，不能据此证明候选同时点有效"]
      : [],
  };
}
