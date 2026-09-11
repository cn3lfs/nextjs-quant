import { readMarketPool } from "../market-pool-files";
import { requireA500Selection } from "../a500-research";
import { latestRpsObservation } from "../rps-observation";
import { tradeDashboard } from "../trade-ledger-service";
import { indexDirectory } from "../index-directory";
import { clsReviewConfigSchema } from "~/lib/cls-review-config";
import {
  clsReviewConfig,
  clsReviewLastCheck,
  saveClsReviewConfig,
} from "../cls-review-scheduler";
import { clsFactReviewSchema, clsFactStatistics } from "~/lib/cls-fact-review";
import { clsReportFiles, previewClsReport } from "../cls-report-files";
import { ClsReviewStore } from "../cls-review-store";
import { fixClsSample } from "../cls-review-service";
import { verifyClsSample } from "../cls-verification";
import { researchSpecSchema } from "~/lib/strategy-research";
import { researchMarketEvidenceSchema } from "~/lib/research-market-evidence";
import { ResearchStore } from "../research-store";
import {
  launchResearch,
  cancelResearch,
  recoverResearch,
} from "../research-client";
import { intradayConfigSchema } from "~/lib/intraday-schedule";
import {
  intradayConfig,
  intradayLastCheck,
  saveIntradayConfig,
  intradayDependencies,
} from "../intraday-service";
import { intradayWorkerStatus, scheduleIntraday } from "../intraday-client";
import { IntradayStore } from "../intraday-store";
import { IntradayJob } from "../intraday-job";
import { marketPoolQuerySchema, poolCategorySchema } from "~/lib/market-pool";
import { marketPoolCatalog } from "../market-pool-files";
import { marketPoolPage, marketPoolRows } from "../market-pool-service";
import { RpsStore } from "../rps-store";
import { rpsClient } from "../rps-client";
import { rpsRequestSchema, rpsQuerySchema } from "~/lib/rps";
import { industryPageSchema } from "~/lib/industry-rps";
import { industryRpsPage } from "../industry-rps-query";
import { readRpsBlockSource } from "../rps-block-source";
import { chartBars, chartBarsInput } from "../chart-bars";
import { ChartViewStore } from "../chart-view-store";
import { chartKeySchema, chartSaveSchema } from "~/lib/chart-view";
import { sqlite as chartSqlite } from "../db";
import { newsBudget } from "../news-budget";
import { analyzeCzsc } from "../czsc";
import { analyzeBreakout } from "../breakout";
import { completedBarFilter } from "../screening";
import { reportSecurityContext } from "../report-security";
import { screenSortSchema } from "~/lib/screen-sort";
import { securityProfile } from "../securities";
import { verifySecurityLifecycle } from "../security-lifecycle";
import { verifySecurityTradingStatus } from "../security-trading-status";
import { screenReviews, screenReviewsInput } from "../screen-reviews";
import {
  reportHistory,
  reportHistoryInput,
  archivedReport,
} from "../report-history";
import { cashDividendInput, cashDividendJob } from "../cash-dividend-job";
import { queryDividendSchedule } from "../hithink-dividends";
import { readBacktestActions, validateActionRange } from "../backtest-actions";
import { reconcileDividends } from "../dividend-reconciliation";
import { financialGrowth } from "../financial-growth";
import { fundamentalResearchInput } from "~/lib/fundamental-research";
import {
  fundamentalResearchJob,
  type FundamentalReport,
} from "../fundamental-report";
import {
  financialQualityJob,
  financialQualityHistory,
  type FinancialQualityArchive,
} from "../financial-quality";
import { valuationScenarioSchema } from "~/lib/valuation-scenario";
import {
  saveValuationScenario,
  valuationScenarioHistory,
  type ValuationScenario,
} from "../valuation-scenario";
import { researchHistory } from "../research-history";
import { wyckoffJob } from "../wyckoff-job";
import type { WyckoffReport } from "../wyckoff-report";
import { jobSummaries } from "../job-summaries";
import { taskHistory, taskState, screenTaskProgress } from "../task-history";
import { taskHistoryInput } from "~/lib/task-history";
import { analyzeChan, chanWindow, type ChanReport } from "../chan-report";
import { gatherCanslimDossier } from "../canslim-dossier";
import {
  analyzeCanslimDossier,
  type CanslimResearchReport,
} from "../canslim-report";
import {
  verifySecurityIdentity,
  type IdentityCheck,
} from "../security-identity";
import { readClsNews } from "../cls-news";
import { walkForwardJob, walkForwardInput } from "../walk-forward-job";
import type { WalkForwardResult } from "~/lib/walk-forward";
import { explainWalkForwardJob } from "../walk-forward-explanation";
import { newsSectorHistory } from "../news-sector-history";
import { aggregateNewsDay } from "../news-day";
import { checkThemePrices, latestThemePrices } from "../theme-prices";
import { explainThemePricesJob } from "../theme-price-explanation";
import { analyzeNewsThemes, latestNewsThemes } from "../news-themes";
import { analyzeNewsSector, newsSectorInput } from "../news-sector";
import {
  analyzeNews,
  newsAnalysisInput,
  newsAnalysisView,
  type NewsAnalysis,
} from "../news-analysis";
import { historicalScreenSchema } from "~/lib/historical-screen";
import { backtestCostsSchema } from "~/lib/backtest-costs";
import { currentMcpHealth } from "../mcp-health";
import { onlineScreenJob, type OnlineScreenResult } from "../online-screen";
import { researchSkillCatalog } from "../research-skills";
import { exportRsArchive } from "../rs-export";
import {
  pageScreenResults,
  exportScreenResults,
  type StoredScreenResult,
} from "../screen-results";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  createCallerFactory,
  createTRPCRouter,
  publicProcedure as p,
} from "./trpc";
import {
  settingsSchema,
  strategySchema,
  symbolSchema,
  periodSchema,
  type Coverage,
  type Job,
  type Snapshot,
  type Report,
  type Channel,
  type Monitor,
  type Delivery,
  type Signal,
} from "~/lib/domain";
import { get, list, put } from "../db";
import { settings, saveSettings } from "../settings";
import {
  scanJob,
  snapshot,
  screenJob,
  backtestJob,
  startRuntime,
  tick,
} from "../runtime";
import { background, cancelJob, updateJob } from "../jobs";
import {
  analyze,
  interpret,
  snapshotEvidence,
  researchModel,
} from "../research";
import { saveChannel, testDelivery } from "../notifications";
import { importLocalMcp, mcpTools, queryMcp, mcpConfigured } from "../mcp";
import { gatherEvidence } from "../market-data";
import { searchSecurities } from "../security-search";
import { securityNames } from "../tdx";
import { findCli } from "../local-llm";
import { securityDirectory, securityNameMap } from "../securities";
import {
  TDX_HOSTS,
  barPage,
  configuredHosts,
  finance,
  historyMinutes,
  historyTransactionPage,
  indexBarPage,
  minutes,
  saveHosts,
  securityQuotes,
  transactionPage,
} from "../tdx-quotes";
import { KLINE, PAGE_LIMIT, QUOTES_BATCH_LIMIT } from "../tdx-wire";

const klineSchema = z.enum(
  Object.keys(KLINE) as [keyof typeof KLINE, ...(keyof typeof KLINE)[]],
);
const pageSchema = z.object({
  symbol: symbolSchema,
  start: z.number().int().min(0).max(65535).default(0),
  count: z.number().int().min(1).max(PAGE_LIMIT).default(PAGE_LIMIT),
});
const tradingDateSchema = z.number().int().min(19900101).max(21001231);

export const appRouter = createTRPCRouter({
  clsReviewExportAll: p
    .input(z.string())
    .query(({ input }) =>
      new ClsReviewStore(chartSqlite()).exportReport(input),
    ),
  clsReviewRemove: p
    .input(z.string())
    .mutation(({ input }) =>
      new ClsReviewStore(chartSqlite()).removeReport(input),
    ),
  clsReviewSummary: p.query(() =>
    new ClsReviewStore(chartSqlite()).outcomeSummary(),
  ),
  clsReviewSchedule: p.query(() => ({
    config: clsReviewConfig(),
    lastCheck: clsReviewLastCheck(),
  })),
  clsReviewSaveSchedule: p
    .input(clsReviewConfigSchema)
    .mutation(({ input }) => saveClsReviewConfig(input)),
  clsReviewSaveFact: p
    .input(clsFactReviewSchema)
    .mutation(({ input }) => new ClsReviewStore(chartSqlite()).saveFact(input)),
  clsReviewFacts: p.input(z.string()).query(({ input }) => {
    const rows = new ClsReviewStore(chartSqlite()).facts(input);
    return { rows, statistics: clsFactStatistics(rows) };
  }),
  clsReviewVerify: p
    .input(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .mutation(({ input }) => verifyClsSample(input)),
  clsReviewVerifications: p
    .input(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .query(({ input }) =>
      new ClsReviewStore(chartSqlite()).verifications(input),
    ),
  clsReviewFiles: p
    .input(z.string().min(1).max(2048))
    .query(({ input }) => clsReportFiles(input)),
  clsReviewPreview: p
    .input(z.string().min(1).max(2048))
    .query(({ input }) => previewClsReport(input)),
  clsReviewImport: p
    .input(
      z.object({
        path: z.string().min(1).max(2048),
        hash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .mutation(async ({ input }) =>
      new ClsReviewStore(chartSqlite()).import(
        await previewClsReport(input.path),
        input.hash,
      ),
    ),
  clsReviewReports: p
    .input(z.number().int().min(0).default(0))
    .query(({ input }) =>
      new ClsReviewStore(chartSqlite()).reports(input).map((report) => ({
        ...report,
        report: {
          ...report.report,
          markdown: undefined,
          sections: report.report.sections.map((section) => ({
            ...section,
            text: undefined,
          })),
        },
      })),
    ),
  clsReviewExport: p
    .input(z.string())
    .query(({ input }) => new ClsReviewStore(chartSqlite()).report(input)),
  clsReviewFixSample: p
    .input(z.string())
    .mutation(({ input }) => fixClsSample(input)),
  clsReviewSample: p
    .input(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .query(({ input }) => new ClsReviewStore(chartSqlite()).sample(input)),
  strategyResearchTasks: p.query(() => {
    recoverResearch();
    return new ResearchStore(chartSqlite()).tasks();
  }),
  strategyResearchCreate: p
    .input(
      z.object({
        spec: researchSpecSchema.refine(
          (spec) => !!spec.symbols?.length,
          "请先选择研究品种清单",
        ),
        evidence: researchMarketEvidenceSchema.nullable(),
      }),
    )
    .mutation(async ({ input }) => {
      if (!input.spec.pool) throw new Error("请选择A500成分清单");
      requireA500Selection(
        input.spec,
        await readMarketPool(
          settings().industryBlocksRoot,
          input.spec.pool,
          settings().tdxRoot,
        ),
      );
      const task = new ResearchStore(chartSqlite()).create(
        input.spec,
        input.evidence,
      );
      return launchResearch(task.id);
    }),
  strategyResearchRetry: p.input(z.string()).mutation(({ input }) => {
    const task = new ResearchStore(chartSqlite()).retry(input);
    return launchResearch(task.id);
  }),
  strategyResearchCancel: p
    .input(z.string())
    .mutation(({ input }) => cancelResearch(input)),
  strategyResearchResult: p
    .input(z.string())
    .query(({ input }) => new ResearchStore(chartSqlite()).result(input)),
  strategyResearchExport: p.input(z.string()).query(({ input }) => {
    const store = new ResearchStore(chartSqlite());
    return {
      task: store.task(input),
      dataset: store.dataset(input),
      evidence: store.evidence(input),
      result: store.result(input),
    };
  }),
  strategyResearchRemove: p
    .input(z.string())
    .mutation(({ input }) => new ResearchStore(chartSqlite()).remove(input)),
  intradayStatus: p
    .input(z.object({ offset: z.number().int().min(0).default(0) }))
    .query(({ input }) => {
      const store = new IntradayStore(chartSqlite());
      const job = new IntradayJob(
        store,
        intradayDependencies((bars) => analyzeCzsc(bars, true)),
      );
      return {
        config: intradayConfig(),
        storage: store.usage(),
        lastCheck: intradayLastCheck(),
        worker: intradayWorkerStatus(),
        runs: job.runs(),
        rows: store.page(input.offset).map((row) => ({
          ...row,
          value: {
            ...row.value,
            snapshot: { ...row.value.snapshot, bars: undefined },
          },
          attempts: row.attempts.map((attempt) => ({
            ...attempt,
            close: { ...attempt.close, snapshot: undefined },
          })),
        })),
      };
    }),
  intradayExport: p
    .input(z.string().regex(/^intraday-preview:[a-f0-9]{64}$/))
    .query(({ input }) => {
      const store = new IntradayStore(chartSqlite());
      const observation = store.observation(input);
      if (!observation) throw new Error("预选记录不存在");
      return {
        schemaVersion: 1,
        observation,
        attempts: store.attempts(input),
        run: get(observation.sessionId),
      };
    }),
  intradaySave: p
    .input(intradayConfigSchema)
    .mutation(({ input }) => saveIntradayConfig(input)),
  intradayRemove: p
    .input(z.string().regex(/^intraday-preview:[a-f0-9]{64}$/))
    .mutation(({ input }) => {
      if (intradayWorkerStatus().running)
        throw new Error("任务仍在执行，请完成后清理");
      new IntradayStore(chartSqlite()).remove(input);
      return { removed: true };
    }),
  intradayRun: p.mutation(() => {
    void scheduleIntraday(Date.now(), true);
    return intradayWorkerStatus();
  }),
  conceptRpsStatus: p.query(() => {
    const store = new RpsStore(chartSqlite(), "concept");
    const latest = store.latest();
    return {
      root: settings().industryBlocksRoot,
      membershipSource: settings().industryMembershipSource,
      ready:
        settings().industryMembershipSource === "tdx" ||
        !!settings().industryBlocksRoot,
      progress: store.progress(),
      latest: latest
        ? {
            date: latest.date,
            mode: latest.mode,
            total: latest.total,
            counts: latest.counts,
            hash: latest.industry!.snapshot.hash,
          }
        : null,
    };
  }),
  conceptRpsPage: p
    .input(industryPageSchema)
    .query(({ input }) =>
      industryRpsPage(
        new RpsStore(chartSqlite(), "concept"),
        input,
        latestRpsObservation(settings().tdxRoot),
      ),
    ),
  marketPoolCatalog: p
    .input(poolCategorySchema)
    .query(({ input }) =>
      marketPoolCatalog(
        settings().industryBlocksRoot,
        input,
        settings().tdxRoot,
      ),
    ),
  marketPoolPage: p
    .input(marketPoolQuerySchema)
    .query(({ input }) => marketPoolPage(input)),
  marketPoolExport: p
    .input(marketPoolQuerySchema)
    .mutation(({ input }) => marketPoolRows(input)),
  industryRpsStatus: p.query(() => {
    const store = new RpsStore(chartSqlite(), "industry");
    const latest = store.latest();
    // Full membership evidence stays on disk; status polling returns only summary counts.
    return {
      root: settings().industryBlocksRoot,
      membershipSource: settings().industryMembershipSource,
      ready:
        settings().industryMembershipSource === "tdx" ||
        !!settings().industryBlocksRoot,
      progress: store.progress(),
      latest: latest
        ? {
            date: latest.date,
            mode: latest.mode,
            counts: latest.counts,
            total: latest.total,
            excluded: latest.industry!.excluded,
          }
        : null,
    };
  }),
  industryRpsSourceConfigure: p
    .input(z.enum(["blocks", "tdx"]))
    .mutation(({ input }) => {
      saveSettings({ ...settings(), industryMembershipSource: input });
      return { source: input };
    }),
  industryRpsConfigure: p
    .input(z.string().trim().max(2048))
    .mutation(({ input }) => {
      saveSettings({ ...settings(), industryBlocksRoot: input });
      return { root: input };
    }),
  industryRpsInspect: p.mutation(async () => {
    const config = settings();
    const snapshot = await readRpsBlockSource({
      source: config.industryMembershipSource,
      blocksRoot: config.industryBlocksRoot,
      tdxRoot: config.tdxRoot,
    });
    const previous = new RpsStore(chartSqlite(), "industry").latest()?.industry
      ?.snapshot;
    const old = new Map(previous?.files.map((f) => [f.file, f]));
    return {
      count: snapshot.files.length,
      hash: snapshot.hash,
      baseline: !!previous,
      changed: snapshot.files
        .filter(
          (f) =>
            old.has(f.file) &&
            (old.get(f.file)!.hash !== f.hash ||
              old.get(f.file)!.mtimeMs !== f.mtimeMs),
        )
        .map((f) => f.file),
      added: snapshot.files.filter((f) => !old.has(f.file)).map((f) => f.file),
      removed:
        previous?.files
          .filter((f) => !snapshot.files.some((n) => n.file === f.file))
          .map((f) => f.file) ?? [],
    };
  }),
  industryRpsPage: p
    .input(industryPageSchema)
    .query(({ input }) =>
      industryRpsPage(
        new RpsStore(chartSqlite(), "industry"),
        input,
        latestRpsObservation(settings().tdxRoot),
      ),
    ),
  workflowStatus: p.query(() => {
    const rows = chartSqlite()
      .prepare(
        "SELECT payload FROM records WHERE kind IN ('workflow-check','cls-analysis-batch') ORDER BY updated_at DESC LIMIT 6",
      )
      .all() as { payload: string }[];
    return rows.map(
      (row) =>
        JSON.parse(row.payload) as {
          phase: string;
          date: string;
          status: string;
          error?: string;
        },
    );
  }),
  rpsStatus: p.query(() => {
    const store = new RpsStore(chartSqlite());
    return { progress: store.progress(), latest: store.latest() };
  }),
  rpsStart: p
    .input(rpsRequestSchema)
    .mutation(({ input }) => ({ id: rpsClient().start(input).id })),
  rpsCancel: p.mutation(() => {
    rpsClient().cancel();
    return { cancelled: true };
  }),
  rpsRanking: p.input(rpsQuerySchema).query(({ input }) => {
    const store = new RpsStore(chartSqlite());
    return {
      day: store.day(input.date),
      rows: store.ranking(input.date, input.period),
    };
  }),
  rpsCurve: p
    .input(symbolSchema)
    .query(({ input }) => new RpsStore(chartSqlite()).curve(input)),
  chartPosition: p
    .input(symbolSchema)
    .query(
      async ({ input }) =>
        (await tradeDashboard()).positions.find((p) => p.symbol === input) ??
        null,
    ),
  chartBars: p.input(chartBarsInput).query(({ input }) => chartBars(input)),
  chartView: p
    .input(chartKeySchema)
    .query(({ input }) => new ChartViewStore(chartSqlite()).read(input)),
  saveChartView: p
    .input(chartSaveSchema)
    .mutation(({ input }) => new ChartViewStore(chartSqlite()).save(input)),
  /*
   * 通达信 7709 实时行情。这些是公共服务器的即时快照，只供盘中观察：
   * 不要与本地 vipdoc 历史混用生成回测信号，也不代表成交可得性。
   */
  tdxHosts: p.query(() => ({
    hosts: [...configuredHosts()],
    builtin: [...TDX_HOSTS],
    fromEnv: Boolean(process.env.TDX_HOSTS),
  })),
  tdxSaveHosts: p
    .input(z.array(z.string().trim().max(253)).max(50))
    .mutation(({ input }) => ({ hosts: saveHosts(input) })),
  tdxQuotes: p
    .input(
      z
        .array(symbolSchema)
        .min(1)
        .max(QUOTES_BATCH_LIMIT * 10),
    )
    .query(({ input }) => securityQuotes(input)),
  tdxBars: p
    .input(
      z.object({
        symbol: symbolSchema,
        kline: klineSchema.default("day"),
        start: z.number().int().min(0).max(65535).default(0),
        count: z.number().int().min(1).max(PAGE_LIMIT).default(PAGE_LIMIT),
        index: z.boolean().default(false),
      }),
    )
    .query(({ input }) =>
      (input.index ? indexBarPage : barPage)(
        input.symbol,
        input.kline,
        input.start,
        input.count,
      ),
    ),
  tdxMinutes: p
    .input(
      z.object({ symbol: symbolSchema, date: tradingDateSchema.optional() }),
    )
    .query(({ input }) =>
      input.date === undefined
        ? minutes(input.symbol)
        : historyMinutes(input.symbol, input.date),
    ),
  tdxTransactions: p
    .input(pageSchema.extend({ date: tradingDateSchema.optional() }))
    .query(({ input }) =>
      input.date === undefined
        ? transactionPage(input.symbol, input.start, input.count)
        : historyTransactionPage(
            input.symbol,
            input.date,
            input.start,
            input.count,
          ),
    ),
  tdxFinance: p.input(symbolSchema).query(({ input }) => finance(input)),
  fundamentalAnalyze: p
    .input(fundamentalResearchInput)
    .mutation(({ input }) => fundamentalResearchJob(input)),
  fundamentalHistory: p.query(() => researchHistory("fundamental-report")),
  fundamentalReport: p
    .input(z.string().regex(/^fundamental-report-[a-f0-9]{64}$/))
    .query(({ input }) => get<FundamentalReport>(input) ?? null),
  financialQualityCreate: p
    .input(symbolSchema)
    .mutation(({ input }) => financialQualityJob(input)),
  financialQualityHistory: p.query(() => financialQualityHistory()),
  financialQualityReport: p
    .input(z.string().regex(/^financial-quality-[a-f0-9]{64}$/))
    .query(({ input }) => get<FinancialQualityArchive>(input) ?? null),
  financialGrowthReport: p
    .input(z.string().regex(/^financial-quality-[a-f0-9]{64}$/))
    .query(({ input }) => {
      const archive = get<FinancialQualityArchive>(input);
      return archive ? financialGrowth(archive) : null;
    }),
  valuationSave: p
    .input(valuationScenarioSchema)
    .mutation(({ input }) => ({ id: saveValuationScenario(input).id })),
  valuationHistory: p.query(() => valuationScenarioHistory()),
  valuationReport: p
    .input(z.string().regex(/^valuation-scenario-[a-f0-9]{64}$/))
    .query(({ input }) => get<ValuationScenario>(input) ?? null),
  wyckoffAnalyze: p
    .input(
      z.object({
        snapshotId: z.string().min(1),
        question: z.string().trim().min(1).max(2000),
      }),
    )
    .mutation(({ input }) => wyckoffJob(input.snapshotId, input.question)),
  wyckoffHistory: p.query(() => researchHistory("wyckoff-report")),
  wyckoffReport: p
    .input(z.string().regex(/^wyckoff-report-[a-f0-9]{64}$/))
    .query(({ input }) => get<WyckoffReport>(input) ?? null),
  savedSnapshot: p.input(z.string().min(1)).query(({ input }) => {
    const source = get<Snapshot>(input);
    if (!source?.bars || !source.symbol)
      throw new Error("候选原始快照不存在，请重新运行选股");
    return source;
  }),
  mcpHealth: p.query(() => currentMcpHealth()),
  newsBudget: p.query(() => newsBudget()),
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
  saveSettings: p
    .input(settingsSchema)
    .mutation(({ input }) => saveSettings(input)),
  scan: p.mutation(() => scanJob()),
  securityNames: p.query(() => securityNameMap()),
  securityProfile: p
    .input(symbolSchema)
    .query(({ input }) => securityProfile(input)),
  verifySecurityLifecycle: p
    .input(symbolSchema)
    .mutation(({ input }) => verifySecurityLifecycle(input)),
  verifySecurityTradingStatus: p
    .input(symbolSchema)
    .mutation(({ input }) => verifySecurityTradingStatus(input)),
  indexDirectory: p.query(() => indexDirectory(settings().tdxRoot)),
  securities: p
    .input(
      z.object({
        query: z.string().default(""),
        period: periodSchema.default("day"),
      }),
    )
    .query(async ({ input }) => {
      const directory = await securityDirectory();
      return searchSecurities(
        [
          ...(get<Coverage>("coverage")?.securities ?? []).map((item) => ({
            ...item,
            name: directory.entries[item.symbol]?.name ?? item.name,
          })),
          ...(await indexDirectory(settings().tdxRoot, input.period)),
        ],
        input.query,
        input.period,
      );
    }),
  breakout: p
    .input(
      z.object({
        snapshotId: z.string().min(1),
        chartSnapshot: z.boolean().default(false),
      }),
    )
    .query(({ input }) => {
      const source = get<Snapshot>(input.snapshotId);
      if (!source || !Array.isArray(source.bars))
        throw new Error("行情快照不存在");
      if (input.chartSnapshot) {
        if (!source.id.startsWith("chart-snapshot-"))
          throw new Error("图表快照不匹配");
        return analyzeBreakout(source.bars, 0, true);
      }
      if (source.period !== "day") throw new Error("双突破仅支持日线");
      const completed = completedBarFilter("day", Date.now());
      return analyzeBreakout(
        source.bars.filter((b) => completed(b.date)),
        0,
      );
    }),
  czsc: p
    .input(
      z.object({
        snapshotId: z.string().min(1),
        chartSnapshot: z.boolean().default(false),
      }),
    )
    .query(({ input }) => {
      const source = get<Snapshot>(input.snapshotId);
      if (!source || !Array.isArray(source.bars))
        throw new Error("行情快照不存在");
      return analyzeCzsc(source.bars);
    }),
  snapshot: p
    .input(
      z.object({
        symbol: symbolSchema,
        period: periodSchema,
        source: z.enum(["local", "mcp", "online"]).default("local"),
      }),
    )
    .mutation(({ input }) =>
      snapshot(input.symbol, input.period, input.source),
    ),
  watchlist: p
    .input(z.array(symbolSchema).max(100))
    .mutation(({ input }) =>
      put("watchlist", "watchlist", [...new Set(input)]),
    ),
  screen: p
    .input(
      historicalScreenSchema.extend({
        strategy: strategySchema,
        period: periodSchema,
        symbols: z.array(symbolSchema).max(10000).optional(),
      }),
    )
    .mutation(({ input }) =>
      screenJob(input.strategy, input.period, input.symbols, input),
    ),
  formulas: p.query(() => savedFormulas()),
  saveFormula: p
    .input(formulaSchema)
    .mutation(({ input }) => saveFormula(input)),
  checkFormula: p.input(formulaSchema).mutation(({ input }) => {
    validateScreenFormula(input);
    return { ok: true };
  }),
  formulaScreen: p
    .input(formulaSchema)
    .mutation(({ input }) => formulaScreenJob(input)),
  backtest: p
    .input(
      z.object({
        snapshotId: z.string(),
        strategy: strategySchema,
        initial: z.number().min(1000).max(1e9),
        scope: z.enum(["full", "window"]).default("full"),
        costs: backtestCostsSchema.default({}),
      }),
    )
    .mutation(({ input }) =>
      backtestJob(
        input.snapshotId,
        input.strategy,
        input.initial,
        input.scope,
        input.costs,
      ),
    ),
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
  cashDividendSimulation: p
    .input(cashDividendInput)
    .mutation(({ input }) => cashDividendJob(input)),
  walkForward: p
    .input(walkForwardInput)
    .mutation(({ input }) => walkForwardJob(input)),
  walkForwardHistory: p.query(() =>
    list<WalkForwardResult>("walk-forward", 20).map((r) => ({
      id: r.id!,
      symbol: r.symbol,
      createdAt: r.createdAt!,
      folds: r.summary.folds,
    })),
  ),
  explainWalkForward: p
    .input(z.string().regex(/^walk-forward-[a-f0-9-]{36}$/))
    .mutation(({ input }) => explainWalkForwardJob(input)),
  walkForwardResult: p
    .input(z.string().regex(/^walk-forward-[a-f0-9-]{36}$/))
    .query(({ input }) => get<WalkForwardResult>(input) ?? null),
  interpret: p
    .input(z.string().min(1).max(2000))
    .mutation(({ input }) =>
      background("research", { prompt: input }, async (_, signal) =>
        interpret(input, signal),
      ),
    ),
  analyze: p
    .input(
      z.object({
        snapshotId: z.string(),
        question: z.string().min(1).max(3000),
        method: z.enum(["general", "sepa"]).default("general"),
        strategy: strategySchema,
      }),
    )
    .mutation(({ input }) => {
      const source = get<Snapshot>(input.snapshotId);
      if (!source) throw new Error("请先加载行情");
      return background(
        "research",
        {
          contextId: source.id,
          method: input.method,
          question: input.question,
          strategy: input.strategy,
        },
        async (_, signal) =>
          analyze(
            source.id,
            input.question,
            await gatherEvidence(source, input.strategy, signal, {
              relativeStrength: input.method === "sepa",
            }),
            signal,
            input.method,
          ),
      );
    }),
  chanAnalyze: p
    .input(
      z.object({
        snapshotId: z.string(),
        question: z.string().trim().min(1).max(2000),
      }),
    )
    .mutation(({ input }) => {
      const source = get<Snapshot>(input.snapshotId);
      if (!source) throw new Error("请先加载研究行情");
      const now = Date.now(),
        window = chanWindow(source, now),
        model = researchModel();
      return background(
        "research",
        {
          contextId: source.id,
          method: "chan",
          model,
          question: input.question,
        },
        async (job, signal) => {
          updateJob(job.id, { phase: "生成缠论待核验标注", progress: 20 });
          const report = await analyzeChan(
            source,
            input.question,
            signal,
            model,
            now,
          );
          signal.throwIfAborted();
          return { reportId: report.id };
        },
        {
          method: "chan",
          window: window.hash,
          question: input.question,
          model,
        },
      );
    }),
  chanHistory: p.query(() => researchHistory("chan-report")),
  chanReport: p
    .input(z.string().regex(/^chan-report-[a-f0-9]{64}$/))
    .query(({ input }) => get<ChanReport>(input) ?? null),
  canslimAnalyze: p
    .input(z.object({ snapshotId: z.string() }))
    .mutation(({ input }) => {
      const source = get<Snapshot>(input.snapshotId);
      if (!source || source.period !== "day" || source.historicalAsOf)
        throw new Error(
          "请先加载当前研究的个股日线；CANSLIM暂不支持分钟或历史时点研究",
        );
      const model = researchModel();
      return background(
        "research",
        { contextId: source.id, method: "canslim", model },
        async (job, signal) => {
          updateJob(job.id, { phase: "补充财务与指数资料", progress: 10 });
          const dossier = await gatherCanslimDossier(source, signal);
          signal.throwIfAborted();
          updateJob(job.id, { phase: "生成CANSLIM六阶段报告", progress: 60 });
          const report = await analyzeCanslimDossier(dossier, signal, model);
          return { reportId: report.id };
        },
        { method: "canslim", snapshotId: source.id, hash: source.hash, model },
      );
    }),
  canslimHistory: p.query(() => researchHistory("canslim-report")),
  canslimReport: p
    .input(z.string().regex(/^canslim-report-[a-f0-9]{64}$/))
    .query(({ input }) => get<CanslimResearchReport>(input) ?? null),
  newsAnalyses: p.query(() => {
    const seen = new Set<string>();
    return list<NewsAnalysis>("news-analysis", 50)
      .filter((record) => {
        const key = JSON.stringify({
          news: record.news.map((n) => n.hash),
          method: record.method,
          model: record.model,
        });
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ id, createdAt, model, news, input }) => ({
        id,
        createdAt,
        model,
        count: news.length,
        query: input.query,
      }));
  }),
  newsAnalysis: p
    .input(z.string().regex(/^news-analysis-[a-f0-9]{64}$/))
    .query(({ input }) => {
      const record = get<NewsAnalysis>(input);
      return record ? newsAnalysisView(record) : null;
    }),
  newsSectorReports: p
    .input(z.string().regex(/^news-analysis-[a-f0-9]{64}$/))
    .query(({ input }) => newsSectorHistory(input)),
  explainThemePrices: p
    .input(z.string().regex(/^theme-prices-[a-f0-9]{64}$/))
    .mutation(({ input }) => explainThemePricesJob(input)),
  themePrices: p
    .input(z.string().regex(/^news-themes-[a-f0-9]{64}$/))
    .query(({ input }) => latestThemePrices(input)),
  checkThemePrices: p
    .input(z.string().regex(/^news-themes-[a-f0-9]{64}$/))
    .mutation(({ input }) =>
      background(
        "research",
        { kind: "theme-prices", themeId: input },
        (_job, signal) => checkThemePrices(input, signal),
        { kind: "theme-prices", input },
      ),
    ),
  newsThemes: p
    .input(z.string().regex(/^news-analysis-[a-f0-9]{64}$/))
    .query(({ input }) => latestNewsThemes(input)),
  analyzeNewsThemes: p
    .input(z.string().regex(/^news-analysis-[a-f0-9]{64}$/))
    .mutation(({ input }) => {
      const model = researchModel(false);
      return background(
        "research",
        { kind: "news-themes", analysisId: input, model },
        (_job, signal) => analyzeNewsThemes(input, signal, model),
        { kind: "news-themes", input, model },
      );
    }),
  aggregateNewsDay: p
    .input(z.string().regex(/^news-analysis-[a-f0-9]{64}$/))
    .mutation(({ input }) => aggregateNewsDay(input)),
  analyzeNewsSector: p
    .input(newsSectorInput)
    .mutation(({ input }) =>
      background(
        "research",
        { kind: "news-sector", ...input },
        (_job, signal) => analyzeNewsSector(input, signal),
      ),
    ),
  analyzeNews: p.input(newsAnalysisInput).mutation(({ input }) =>
    background("research", { kind: "news-analysis", ...input }, (job, signal) =>
      analyzeNews(input, signal, (done, total) =>
        updateJob(job.id, {
          progress: Math.round((done / total) * 100),
          phase: `新闻分析 ${done}/${total}`,
        }),
      ),
    ),
  ),
  news: p
    .input(
      z.object({
        cutoff: z.number().int().nonnegative(),
        page: z.number().int().min(0).default(0),
        query: z.string().max(100).default(""),
        historical: z.boolean().default(true),
      }),
    )
    .query(({ input }) => readClsNews(settings().clsDbPath, input)),
  securityIdentity: p
    .input(symbolSchema)
    .mutation(({ input }) => verifySecurityIdentity(input)),
  identityRecord: p
    .input(symbolSchema)
    .query(({ input }) => get<IdentityCheck>(`identity-${input}`) ?? null),
  researchSkills: p.query(() => researchSkillCatalog()),
  rsSourceExport: p
    .input(z.object({ reportId: z.string(), evidenceId: z.string() }))
    .query(({ input }) => exportRsArchive(input.reportId, input.evidenceId)),
  onlineScreen: p
    .input(
      z.object({
        query: z.string().trim().min(2).max(2000),
        page: z.number().int().min(1).max(10000).default(1),
      }),
    )
    .mutation(({ input }) => onlineScreenJob(input.query, input.page)),
  onlineScreenResult: p
    .input(z.object({ id: z.string(), version: z.number().optional() }))
    .query(({ input }) => {
      const job = get<Job>(input.id);
      return job?.type === "online-screen" && job.status === "completed"
        ? (job.result as OnlineScreenResult)
        : null;
    }),
  jobs: p.query(() => jobSummaries()),
  screenTaskProgress: p
    .input(z.object({ id: z.string().min(1).max(200) }))
    .query(({ input }) => screenTaskProgress(input.id)),
  taskHistory: p
    .input(taskHistoryInput)
    .query(({ input }) => taskHistory(input)),
  taskState: p
    .input(z.object({ id: z.string().min(1).max(200) }))
    .query(({ input }) => taskState(input.id)),
  job: p
    .input(z.object({ id: z.string(), version: z.number().optional() }))
    .query(({ input }) => get<Job>(input.id) ?? null),
  jobSummary: p
    .input(
      z.object({ id: z.string(), screenFirstPage: z.boolean().optional() }),
    )
    .query(({ input }) => {
      const job = get<Job>(input.id);
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
  screenResults: p
    .input(
      z.object({
        id: z.string(),
        version: z.number().optional(),
        page: z.number().int().min(0).default(0),
        query: z.string().max(100).default(""),
        sort: screenSortSchema.default("original"),
        direction: z.enum(["asc", "desc"]).default("desc"),
        excludedPage: z.number().int().min(0).default(0),
        errorPage: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ input }) => {
      const job = get<Job>(input.id);
      if (job?.type !== "screen" || !job.result) return null;
      return {
        jobId: job.id,
        ...pageScreenResults(
          job.result as StoredScreenResult,
          input,
          input.query.trim() ? await securityNameMap() : {},
        ),
      };
    }),
  screenReviews: p
    .input(screenReviewsInput)
    .query(({ input }) => screenReviews(input)),
  screenExport: p.input(z.string()).query(({ input }) => {
    const job = get<Job>(input);
    if (!job) throw new Error("任务不存在");
    if ((job.input as { type?: string })?.type === "formula-screen")
      return exportFormulaScreen(job);
    return exportScreenResults(job);
  }),
  cancel: p.input(z.string()).mutation(({ input }) => {
    cancelJob(input);
    return { ok: true };
  }),
  reports: p.query(() =>
    list<Report>("report", 100).map((report) => ({
      ...report,
      securityContext: reportSecurityContext(report.contextId),
    })),
  ),
  reportHistory: p
    .input(reportHistoryInput)
    .query(({ input }) => reportHistory(input)),
  archivedReport: p
    .input(z.string().min(1).max(200))
    .query(({ input }) => archivedReport(input)),
  channels: p.query(() => list<Channel>("channel")),
  saveChannel: p.input(z.unknown()).mutation(({ input }) => saveChannel(input)),
  testChannel: p.input(z.string()).mutation(({ input }) => testDelivery(input)),
  deliveries: p.query(() => list<Delivery>("delivery", 200)),
  retryDelivery: p.input(z.string()).mutation(({ input }) => {
    const d = get<Delivery>(input);
    if (!d) throw new Error("投递不存在");
    const id = `manual-${randomUUID()}`;
    return put("delivery", id, {
      ...d,
      id,
      body: `【手动重发历史通知】\n${d.body}`,
      manualRetry: true,
      remoteId: undefined,
      error: undefined,
      status: "pending",
      attempts: 0,
      nextAt: Date.now(),
      expiresAt: Date.now() + 600000,
      createdAt: Date.now(),
    });
  }),
  monitors: p.query(() => list<Monitor>("monitor")),
  saveMonitor: p
    .input(
      z.object({
        id: z.string().optional(),
        name: z.string().min(1).max(80),
        symbols: z.array(symbolSchema).min(1).max(20),
        strategy: strategySchema,
        period: periodSchema,
        source: z.enum(["local", "mcp"]).default("local"),
        channels: z.array(z.string()).max(20),
        ai: z.boolean(),
        enabled: z.boolean(),
      }),
    )
    .mutation(({ input }) => {
      if (
        ["czsc", "dual-breakout"].includes(input.strategy.type ?? "") &&
        input.period !== "day"
      )
        throw new Error("缠论/双突破监控仅支持日线");
      for (const id of input.channels)
        if (!get<Channel>(id)) throw new Error("通知渠道不存在");
      const id = input.id ?? `monitor-${randomUUID()}`;
      return put<Monitor>("monitor", id, {
        ...input,
        id,
        states: {},
        revision: randomUUID(),
        createdAt: Date.now(),
      });
    }),
  toggleMonitor: p
    .input(z.object({ id: z.string(), enabled: z.boolean() }))
    .mutation(({ input }) => {
      const m = get<Monitor>(input.id);
      if (!m) throw new Error("监控不存在");
      return put("monitor", m.id, {
        ...m,
        enabled: input.enabled,
        states: {},
        revision: randomUUID(),
      });
    }),
  signals: p.query(() => list<Signal>("signal", 100)),
  importMcp: p.mutation(() => importLocalMcp()),
  mcpTools: p.mutation(async () =>
    (await mcpTools()).map((t) => ({
      name: t.name,
      description: t.description,
      schema: t.inputSchema,
    })),
  ),
  mcpQuery: p
    .input(z.object({ name: z.string(), args: z.record(z.unknown()) }))
    .mutation(({ input }) => queryMcp(input.name, input.args)),
});
export type AppRouter = typeof appRouter;
export const createCaller = createCallerFactory(appRouter);
import { formulaSchema, validateScreenFormula } from "~/lib/formula-screen";
import {
  savedFormulas,
  saveFormula,
  formulaScreenJob,
  exportFormulaScreen,
} from "../formula-screen-service";
