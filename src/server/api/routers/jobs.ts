import { marketSourceSchema } from "~/lib/market/market-source";
import { chartSymbolSchema } from "~/lib/chart/chart-symbol";
import { futuresQuotes } from "../../market/futures-chart";
import { futuresSourceSchema } from "~/lib/market/futures";
import { cryptoSourceSchema } from "~/lib/market/crypto";
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
import { taskHistory, taskState, taskOverview } from "../../jobs/task-history";
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
import { get, put, remove, atomic } from "../../db";
import { settings } from "../../infra/settings";
import { scanJob, startRuntime } from "../../runtime";
import { snapshot } from "../../market/snapshot";
import { backtestJob } from "../../backtest/backtest-job";
import { maBaselineInputSchema } from "~/lib/backtest/ma-baseline";
import {
  strategyExperimentInputSchema,
  factorStrategyId,
} from "~/lib/backtest/strategy-experiment";
import {
  maBaselineId,
  strategyLifecycle,
} from "~/lib/backtest/strategy-lifecycle";
import { researchStrategyIds } from "~/lib/research/specs/research-strategies";
import { researchCompositePresetIds } from "~/lib/research/specs/research-composite-presets";
import { listStrategyRepresentatives } from "trading-strategies";
import { maBaselineJob } from "../../backtest/ma-baseline-job";
import type { MaBaselineArchive } from "../../backtest/ma-baseline-work";
import {
  queryPerformanceEvaluation,
  exportPerformanceEvaluation,
} from "../../performance/backtest-evaluation";
import { readSnapshot as readBaselineSnapshot } from "../../data-sources/tdx/tdx";
import { cancelJob, readJob } from "../../jobs/jobs";
import { mcpConfigured } from "../../data-sources/tdx/tdx-mcp-disabled";
import { findCli } from "../../infra/local-llm";
import { createTRPCRouter, publicProcedure as p } from "../trpc";
import { fullLocalCalendarReference } from "../../market/data-health";
import { monitorCalendar } from "../../monitoring/monitor-calendar";
import { expectedDailyAsOf } from "~/lib/market/daily-freshness";
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
  strategyLifecycle: p.query(() => ({
    active: [
      {
        id: maBaselineId,
        label: "双均线交叉 · TS 基线",
        status: strategyLifecycle(maBaselineId),
      },
      {
        id: factorStrategyId,
        label: "模块化技术因子组合",
        status: strategyLifecycle(factorStrategyId),
      },
    ],
    deprecated: [
      ...new Set([
        ...researchStrategyIds,
        ...researchCompositePresetIds,
        ...listStrategyRepresentatives().flatMap((item) => [
          item.id,
          item.methodId,
          ...(item.presetId ? [item.presetId] : []),
        ]),
      ]),
    ].map((id) => ({
      id,
      status: strategyLifecycle(id),
    })),
  })),
  maBaseline: p
    .input(strategyExperimentInputSchema)
    .mutation(({ input }) => maBaselineJob(input)),
  maBaselineCoverage: p
    .input(maBaselineInputSchema.innerType().shape.symbol)
    .query(async ({ input }) => {
      const source = await readBaselineSnapshot(
        settings().tdxRoot,
        input,
        "5m",
      );
      return {
        symbol: source.symbol,
        start: source.bars[0]!.date.slice(0, 10),
        end: source.bars.at(-1)!.date.slice(0, 10),
        bars: source.bars.length,
      };
    }),
  maBaselineHistory: p.query(
    () =>
      chartSqlite()
        .prepare(
          "SELECT id, json_extract(payload,'$.status') AS status, json_extract(payload,'$.input.input.symbol') AS symbol, json_extract(payload,'$.createdAt') AS createdAt FROM records WHERE kind='job' AND json_extract(payload,'$.input.type')='ma-baseline' ORDER BY updated_at DESC LIMIT 20",
        )
        .all() as {
        id: string;
        status: string;
        symbol: string;
        createdAt: number;
      }[],
  ),
  maBaselineResult: p
    .input(
      z.object({
        id: z.string().min(1),
        pageIndex: z.number().int().nonnegative().default(0),
      }),
    )
    .query(({ input }) => {
      const job = readJob(input.id);
      if (
        !job ||
        job.type !== "backtest" ||
        (job.input as { type?: string } | null)?.type !== "ma-baseline"
      )
        throw new Error("策略实验任务不存在");
      if (job.status !== "completed") return null;
      const archive = job.result as MaBaselineArchive;
      const { fills, orders, ...summary } = archive.result;
      return {
        summary,
        manifest: archive.manifest,
        fills: fills.slice(input.pageIndex * 50, (input.pageIndex + 1) * 50),
        fillCount: fills.length,
        orderCount: orders.length,
        rejectedCount: orders.filter((o) => o.status === "rejected").length,
        pending: orders.filter((o) => o.status === "pending"),
      };
    }),
  maBaselineEvaluation: p
    .input(
      z.object({
        id: z.string().min(1),
        frequency: z.enum(["year", "quarter", "month"]).default("year"),
        year: z.number().int().min(1900).max(9999).optional(),
        period: z.string().max(10).optional(),
      }),
    )
    .query(({ input }) => {
      const job = readJob(input.id);
      if (
        !job ||
        job.type !== "backtest" ||
        (job.input as { type?: string } | null)?.type !== "ma-baseline"
      )
        throw new Error("策略实验任务不存在");
      if (job.status !== "completed") return null;
      return queryPerformanceEvaluation(job.result as MaBaselineArchive, input);
    }),
  maBaselineOrders: p
    .input(
      z.object({
        id: z.string().min(1),
        pageIndex: z.number().int().min(0).max(1000000).default(0),
        status: z.enum(["all", "filled", "rejected", "pending"]).default("all"),
      }),
    )
    .query(({ input }) => {
      const job = readJob(input.id);
      if (
        !job ||
        job.type !== "backtest" ||
        (job.input as { type?: string } | null)?.type !== "ma-baseline"
      )
        throw new Error("策略实验任务不存在");
      if (job.status !== "completed") return null;
      const archive = job.result as MaBaselineArchive;
      const orders = archive.result.orders.filter(
        (order) => input.status === "all" || order.status === input.status,
      );
      return {
        orders: orders.slice(input.pageIndex * 50, (input.pageIndex + 1) * 50),
        rowCount: orders.length,
      };
    }),
  maBaselineExport: p.input(z.string().min(1)).query(({ input }) => {
    const job = readJob(input);
    if (
      !job ||
      job.status !== "completed" ||
      (job.input as { type?: string } | null)?.type !== "ma-baseline"
    )
      throw new Error("没有已完成的策略实验结果");
    const archive = job.result as MaBaselineArchive;
    return { ...archive, evaluation: exportPerformanceEvaluation(archive) };
  }),
  maBaselineRemove: p.input(z.string().min(1)).mutation(({ input }) =>
    atomic(() => {
      const job = readJob(input);
      if (
        !job ||
        (job.input as { type?: string } | null)?.type !== "ma-baseline"
      )
        throw new Error("策略实验任务不存在");
      if (["queued", "running"].includes(job.status))
        throw new Error("先取消或等待任务完成，再删除冻结输入与结果");
      remove(input);
      return { removed: true };
    }),
  ),
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
        cryptoSource: cryptoSourceSchema.optional(),
      }),
    )
    .mutation(({ input }) =>
      snapshot(
        input.symbol,
        input.period,
        input.source,
        input.futuresSource,
        input.cryptoSource,
      ),
    ),
  futuresQuotes: p.query(() => futuresQuotes()),
  // How far local daily data reaches (last Shanghai-index bar) against the
  // day it should reach: today after 15:05 on a trading day, otherwise the
  // previous trading day, per the scheduler's (external when available) calendar.
  localDailyAsOf: p.query(async () => {
    const config = settings(),
      now = Date.now();
    const [local, calendar] = await Promise.all([
      fullLocalCalendarReference(config.tdxRoot, []),
      monitorCalendar(config.tdxRoot, config.calendar, false, true, now),
    ]);
    return {
      asOf: local.coverage.end,
      expected: expectedDailyAsOf(calendar, now),
      calendarSource: calendar.source,
    };
  }),
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
  taskOverview: p.query(() => taskOverview()),
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
    return cancelJob(input);
  }),
});
