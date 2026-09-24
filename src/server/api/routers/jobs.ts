import { marketSourceSchema } from "~/lib/market/market-source";
import { chartSymbolSchema } from "~/lib/chart/chart-symbol";
import { futuresQuotes } from "../../market/futures-chart";
import { futuresSourceSchema } from "~/lib/market/futures";
import { researchAdjustmentSchema } from "~/lib/research/evidence/research-adjustment";
import { sqlite as chartSqlite } from "../../db";
import {
  cashDividendInput,
  cashDividendJob,
} from "../../backtest/cash-dividend-job";
import { queryDividendSchedule } from "../../data-sources/hithink/hithink-dividends";
import {
  readBacktestActions,
  validateActionRange,
} from "../../backtest/backtest-actions";
import { reconcileDividends } from "../../backtest/dividend-reconciliation";
import { jobSummaries } from "../../jobs/job-summaries";
import { taskHistory, taskState } from "../../jobs/task-history";
import { taskHistoryInput } from "~/lib/research/workflow/task-history";
import {
  walkForwardPage,
  type WalkForwardResult,
} from "~/lib/backtest/walk-forward";
import { backtestCostsSchema } from "~/lib/backtest/backtest-costs";
import {
  pageScreenResults,
  type StoredScreenResult,
} from "../../screening/screen-results";
import { z } from "zod";
import {
  strategySchema,
  symbolSchema,
  periodSchema,
  type Coverage,
  type Snapshot,
} from "~/lib/domain";
import { get, put } from "../../db";
import { settings } from "../../infra/settings";
import { scanJob, startRuntime } from "../../runtime";
import { snapshot } from "../../market/snapshot";
import { backtestJob } from "../../backtest/backtest-job";
import { cancelJob, readJob } from "../../jobs/jobs";
import { mcpConfigured } from "../../data-sources/tdx/tdx-mcp-disabled";
import { findCli } from "../../infra/local-llm";
import { createTRPCRouter, publicProcedure as p } from "../trpc";
function recordOfKind<T>(kind: string, id: string): T | undefined {
  const row = chartSqlite()
    .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
    .get(kind, id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T) : undefined;
}
function storedSnapshot(id: string) {
  return (
    recordOfKind<Snapshot>("snapshot", id) ??
    recordOfKind<Snapshot>("chart-snapshot", id)
  );
}
export const jobsRouter = createTRPCRouter({
  status: p.query(async () => {
    startRuntime();
    return {
      settings: settings(),
      coverage: get<Coverage>("coverage")
        ? {
            counts: get<Coverage>("coverage")!.counts,
            scannedAt: get<Coverage>("coverage")!.scannedAt,
            total: get<Coverage>("coverage")!.securities.length,
          }
        : null,
      deepseek: Boolean(process.env.DEEPSEEK_API_KEY),
      localModels: {
        codex: Boolean(findCli("codex")),
        claude: Boolean(findCli("claude")),
      },
      mcp: await mcpConfigured(),
      watchlist: get<string[]>("watchlist") ?? [
        "sh600519",
        "sz000001",
        "sz300750",
      ],
      now: Date.now(),
    };
  }),
  scan: p.mutation(() => scanJob()),
  snapshot: p
    .input(
      z.object({
        symbol: chartSymbolSchema,
        period: periodSchema,
        source: z.union([marketSourceSchema, z.literal("online")]).optional(),
        futuresSource: futuresSourceSchema.optional(),
      }),
    )
    .mutation(({ input }) =>
      snapshot(input.symbol, input.period, input.source, input.futuresSource),
    ),
  futuresQuotes: p.query(() => futuresQuotes()),
  watchlist: p
    .input(z.array(symbolSchema).max(100))
    .mutation(({ input }) =>
      put("watchlist", "watchlist", [...new Set(input)]),
    ),
  backtest: p
    .input(
      z.object({
        snapshotId: z.string(),
        strategy: strategySchema,
        initial: z.number().min(1000).max(1e9),
        scope: z.enum(["full", "window"]).default("full"),
        costs: backtestCostsSchema.default({}),
        adjustment: researchAdjustmentSchema.optional(),
      }),
    )
    .mutation(({ input }) => {
      if (!storedSnapshot(input.snapshotId))
        throw new Error("请先加载行情快照");
      return backtestJob(
        input.snapshotId,
        input.strategy,
        input.initial,
        input.scope,
        input.costs,
        input.adjustment,
      );
    }),
  dividendSchedule: p
    .input(
      z.object({
        symbol: z.string().regex(/^(sh|sz|bj)\d{6}$/),
        start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      }),
    )
    .mutation(async ({ input }) => {
      validateActionRange(input.start, input.end);
      const record = await queryDividendSchedule(input.symbol);
      const archiveId = `dividend-schedule-${record.hash}`;
      const local = await readBacktestActions(
        {
          symbol: input.symbol,
          source: "tdx-local",
          bars: [{ date: input.start }, { date: input.end }],
        },
        settings().tdxRoot,
      );
      const reconciliation = reconcileDividends(local, record);
      const reconciliationId = `dividend-reconciliation-${reconciliation.hash}`;
      put("market-source", archiveId, record);
      put("market-source", reconciliationId, {
        local,
        remoteArchiveId: archiveId,
        reconciliation,
      });
      return {
        reconciliation,
        reconciliationId,
        archiveId,
        symbol: record.symbol,
        fetchedAt: record.fetchedAt,
        events: record.events,
        warnings: record.warnings,
        source: record.source,
      };
    }),
  cashDividendSimulation: p.input(cashDividendInput).mutation(({ input }) => {
    if (!storedSnapshot(input.snapshotId)) throw new Error("请先加载行情快照");
    return cashDividendJob(input);
  }),
  jobs: p.query(() => jobSummaries()),
  taskHistory: p
    .input(taskHistoryInput)
    .query(({ input }) => taskHistory(input)),
  taskState: p
    .input(z.object({ id: z.string().min(1).max(200) }))
    .query(({ input }) => taskState(input.id)),
  job: p
    .input(z.object({ id: z.string(), version: z.number().optional() }))
    .query(({ input }) => {
      const job = readJob(input.id);
      return job?.type === "walk-forward" && job.result
        ? { ...job, result: walkForwardPage(job.result as WalkForwardResult) }
        : (job ?? null);
    }),
  jobSummary: p
    .input(
      z.object({ id: z.string(), screenFirstPage: z.boolean().optional() }),
    )
    .query(({ input }) => {
      const job = readJob(input.id);
      if (!job) return null;
      const { input: _input, result: _result, ...summary } = job;
      return {
        ...summary,
        screenFirstPage:
          input.screenFirstPage &&
          job.type === "screen" &&
          job.status === "completed" &&
          job.result
            ? {
                jobId: job.id,
                ...pageScreenResults(job.result as StoredScreenResult, {
                  page: 0,
                  query: "",
                  excludedPage: 0,
                  errorPage: 0,
                }),
              }
            : null,
      };
    }),
  cancel: p.input(z.string()).mutation(({ input }) => {
    cancelJob(input);
    return { ok: true };
  }),
});
