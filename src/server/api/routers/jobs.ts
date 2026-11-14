import {
  readMaBaselineResultPage,
  readMaBaselineOrderPage,
  readMaBaselineArchive,
} from "../../db/backtest-results";
import { readJob, maBaselineHistory } from "../../db/jobs";
import { recentRuntimeErrors } from "../../infra/runtime-errors";
import { marketSourceSchema } from "~/lib/market/market-source";
import { chartSymbolSchema } from "~/lib/chart/chart-symbol";
import { futuresQuotes } from "../../market/futures-chart";
import { futuresSourceSchema } from "~/lib/market/futures";
import { cryptoSourceSchema } from "~/lib/market/crypto";
import { readSnapshot } from "../../db/snapshot";
import { queryDividendSchedule } from "../../data-sources/hithink/hithink-dividends";
import {
  readBacktestActions,
  validateActionRange,
} from "../../backtest/backtest-actions";
import { reconcileDividends } from "../../backtest/dividend-reconciliation";
import { jobSummaries } from "../../db/job-summaries";
import { taskHistory, taskState } from "../../db/task-history";
import { taskOverview } from "../../db/task-overview";
import { taskHistoryInput } from "~/lib/research/workflow/task-history";
import { readScreenResultPage } from "../../db/screen-result-pages";
import { z } from "zod";
import { periodSchema, type Coverage } from "~/lib/domain";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import { get, put, remove, atomic } from "../../db";
import { settings } from "../../infra/settings";
import { scanJob, startRuntime } from "../../runtime";
import { snapshot } from "../../market/snapshot";
import { maBaselineInputSchema } from "quant-backtest";
import { strategyExperimentInputSchema } from "quant-backtest";
import { maBaselineJob } from "../../backtest/ma-baseline-job";
import {
  queryPerformanceEvaluation,
  exportPerformanceEvaluation,
} from "../../performance/backtest-evaluation";

import { readBars } from "~/server/market/bar-store/read-bars";
import { cancelJob } from "../../jobs/jobs";

import { mcpConfigured } from "../../data-sources/tdx/tdx-mcp-disabled";
import { findCli } from "../../infra/local-llm";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
import { fullLocalCalendarReference } from "../../market/data-health";
import { latestHistoricalDate } from "~/lib/research/strategy-center-input";
import { monitorCalendar } from "../../monitoring/monitor-calendar";
import { expectedDailyAsOf } from "~/lib/market/daily-freshness";
export const jobsRouter = createTRPCRouter({
  maBaseline: p("backtest", "compute")
    .input(strategyExperimentInputSchema)
    .mutation(({ input }) => maBaselineJob(input)),
  maBaselineCoverage: p("backtest", "read")
    .input(maBaselineInputSchema.innerType().shape.symbol)
    .query(async ({ input }) => {
      const source = await readBars({
        instrument: { market: "cn-equity", symbol: input },
        root: settings().tdxRoot,
        period: "5m",
        adjustment: "none",
      });
      return {
        symbol: source.symbol,
        start: source.bars[0]!.date.slice(0, 10),
        end: source.bars.at(-1)!.date.slice(0, 10),
        bars: source.bars.length,
      };
    }),
  maBaselineHistory: p("backtest", "read").query(() => maBaselineHistory()),
  maBaselineResult: p("backtest", "read")
    .input(
      z.object({
        id: z.string().min(1),
        pageIndex: z.number().int().nonnegative().default(0),
      }),
    )
    .query(({ input }) => readMaBaselineResultPage(input.id, input.pageIndex)),
  maBaselineEvaluation: p("backtest", "read")
    .input(
      z.object({
        id: z.string().min(1),
        frequency: z.enum(["year", "quarter", "month"]).default("year"),
        year: z.number().int().min(1900).max(9999).optional(),
        period: z.string().max(10).optional(),
      }),
    )
    .query(({ input }) => {
      const archive = readMaBaselineArchive(input.id);
      return archive ? queryPerformanceEvaluation(archive, input) : null;
    }),
  maBaselineOrders: p("backtest", "read")
    .input(
      z.object({
        id: z.string().min(1),
        pageIndex: z.number().int().min(0).max(1000000).default(0),
        status: z.enum(["all", "filled", "rejected", "pending"]).default("all"),
      }),
    )
    .query(({ input }) =>
      readMaBaselineOrderPage(input.id, input.pageIndex, input.status),
    ),
  maBaselineExport: p("backtest", "read")
    .input(z.string().min(1))
    .query(({ input }) => {
      const archive = readMaBaselineArchive(input);
      if (!archive) throw new Error("没有已完成的策略实验结果");
      return { ...archive, evaluation: exportPerformanceEvaluation(archive) };
    }),
  maBaselineRemove: p("backtest", "configure")
    .input(z.string().min(1))
    .mutation(({ input }) =>
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
  status: p("tasks", "read").query(async () => {
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
  scan: p("market", "compute").mutation(() => scanJob()),
  snapshot: p("market", "compute")
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
  futuresQuotes: p("market", "read").query(() => futuresQuotes()),
  // How far local daily data reaches (last Shanghai-index bar) against the
  // day it should reach: today after 15:05 on a trading day, otherwise the
  // previous trading day, per the scheduler's (external when available) calendar.
  localDailyAsOf: p("market", "read").query(async () => {
    const config = settings(),
      now = Date.now();
    const [local, calendar] = await Promise.all([
      fullLocalCalendarReference(config.tdxRoot, []),
      monitorCalendar(config.tdxRoot, config.calendar, false, true, now),
    ]);
    return {
      asOf: local.coverage.end,
      historicalAsOf: latestHistoricalDate(local.days, now),
      expected: expectedDailyAsOf(calendar, now),
      calendarSource: calendar.source,
    };
  }),
  watchlist: p("market", "configure")
    .input(z.array(symbolSchema).max(100))
    .mutation(({ input }) =>
      put("watchlist", "watchlist", [...new Set(input)]),
    ),
  dividendSchedule: p("financial", "compute")
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
  jobs: p("tasks", "read").query(() => jobSummaries()),
  taskOverview: p("tasks", "read").query(() => taskOverview()),
  recentErrors: p("tasks", "read").query(() => recentRuntimeErrors()),
  taskHistory: p("tasks", "read")
    .input(taskHistoryInput)
    .query(({ input }) => taskHistory(input)),
  taskState: p("tasks", "read")
    .input(z.object({ id: z.string().min(1).max(200) }))
    .query(({ input }) => taskState(input.id)),
  job: p("tasks", "read")
    .input(z.object({ id: z.string(), version: z.number().optional() }))
    .query(({ input }) => readJob(input.id) ?? null),
  jobSummary: p("tasks", "read")
    .input(
      z.object({ id: z.string(), screenFirstPage: z.boolean().optional() }),
    )
    .query(({ input }) =>
      readSnapshot(() => {
        const summary = taskState(input.id);
        if (!summary) return null;
        return {
          ...summary,
          screenFirstPage:
            input.screenFirstPage &&
            summary.isFormulaScreen &&
            summary.status === "completed"
              ? readScreenResultPage(summary.id, {
                  page: 0,
                  query: "",
                  excludedPage: 0,
                  errorPage: 0,
                })
              : null,
        };
      }),
    ),
  cancel: p("tasks", "configure")
    .input(z.string())
    .mutation(({ input }) => {
      return cancelJob(input);
    }),
});
