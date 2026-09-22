import { marketSourceSchema } from "~/lib/market-source";
import { chartSymbolSchema } from "~/lib/chart-symbol";
import { mxQuerySchema } from "~/lib/mx-data";
import { mxDataStatus, queryMxData } from "../data-sources/mx/mx-data";
import { researchAdjustmentSchema } from "~/lib/research-adjustment";
import {
  disciplineRequestSchema,
  startDiscipline,
  disciplineStatus,
  cancelDiscipline,
  exportDiscipline,
} from "../portfolio/discipline-service";
import { researchRangeSchema, researchDateSchema } from "~/lib/research-usage";
import { researchUsage } from "../research/research-usage";
import { researchAttemptsQuerySchema } from "~/lib/research-governance";
import { ResearchAttempts } from "../research/research-governance";
import {
  holdingsCorrelationPageSchema,
  pageHoldingsCorrelation,
} from "../portfolio/holdings-correlation-service";
import { keyTrades } from "~/lib/key-trades";
import {
  positionRiskPageSchema,
  pagePositionRisk,
} from "../portfolio/position-risk-service";
import {
  rollingPageSchema,
  tradeReviewRollingPage,
  researchRollingPage,
} from "../research/performance/rolling-performance-service";
import {
  threeSegmentSample,
  threeSegmentAdmission,
} from "../research/performance/three-segment-sample";
import { readMarketPool } from "../market/market-pool-files";
import {
  admissionPageSchema,
  tradeReviewAdmissionSource,
  pageStrategyAdmission,
  exportStrategyAdmission,
} from "../research/performance/strategy-admission-service";
import {
  executionPageSchema,
  pageExecutionQuality,
  exportExecutionQuality,
} from "../portfolio/execution-quality-service";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { importOptionsSchema } from "~/lib/delivery-import";
import { costMethods, type ReviewRound } from "~/lib/trade-review";
import {
  cashReconciliationPage,
  cashReconciliationPageSchema,
} from "~/lib/cash-reconciliation";
import {
  previewDeliveryImport,
  commitDeliveryImport,
} from "../portfolio/delivery-import-service";
import { DeliveryStore } from "../portfolio/delivery-store";
import {
  buildTradeReviewSnapshot,
  exportTradeReview,
  pageTradeReviewDrawdowns,
} from "../portfolio/trade-review-service";
import { fullLocalCalendarReference } from "../market/data-health";
import { requireA500Selection } from "../research/a500-research";
import { latestRpsObservation } from "../screening/rps-observation";
import { tradeDashboard } from "../portfolio/trade-ledger-service";
import { indexDirectory } from "../market/index-directory";
import { clsReviewConfigSchema } from "~/lib/cls-review-config";
import {
  clsReviewConfig,
  clsReviewLastCheck,
  saveClsReviewConfig,
} from "../news/cls-review-scheduler";
import { clsFactReviewSchema, clsFactStatistics } from "~/lib/cls-fact-review";
import { clsReportFiles, previewClsReport } from "../news/cls-report-files";
import { ClsReviewStore } from "../news/cls-review-store";
import { fixClsSample } from "../news/cls-review-service";
import { verifyClsSample } from "../news/cls-verification";
import { researchSpecSchema } from "~/lib/strategy-research";
import { researchMarketEvidenceSchema } from "~/lib/research-market-evidence";
import { ResearchStore } from "../backtest/research-store";
import {
  periodPageSchema,
  tradeReviewPeriodPage,
  researchPeriodPage,
} from "../research/performance/period-performance-service";
import {
  launchResearch,
  cancelResearch,
  recoverResearch,
} from "../backtest/research-client";
import { intradayConfigSchema } from "~/lib/intraday-schedule";
import {
  intradayConfig,
  intradayLastCheck,
  saveIntradayConfig,
  intradayDependencies,
} from "../monitoring/intraday-service";
import {
  intradayWorkerStatus,
  scheduleIntraday,
} from "../monitoring/intraday-client";
import { IntradayStore } from "../monitoring/intraday-store";
import { IntradayJob } from "../monitoring/intraday-job";
import { marketPoolQuerySchema, poolCategorySchema } from "~/lib/market-pool";
import { marketPoolCatalog } from "../market/market-pool-files";
import { marketPoolPage, marketPoolRows } from "../market/market-pool-service";
import { universeAuditQuerySchema } from "~/lib/universe-audit";
import { universeAuditPage } from "../research/universe-audit";
import { RpsStore } from "../screening/rps-store";
import { rpsClient } from "../screening/rps-client";
import { rpsRequestSchema, rpsQuerySchema } from "~/lib/rps";
import { rpsLogIdPrefix, toRpsLogEntry } from "~/lib/rps-log";
import { industryPageSchema } from "~/lib/industry-rps";
import { industryRpsPage } from "../screening/industry-rps-query";
import { readRpsBlockSource } from "../screening/rps-block-source";
import { chartBars, chartBarsInput } from "../charts/chart-bars";
import { ChartViewStore } from "../charts/chart-view-store";
import { chartKeySchema, chartSaveSchema } from "~/lib/chart-view";
import { sqlite as chartSqlite } from "../db";
import { newsBudget } from "../news/news-budget";
import { analyzeCzsc } from "../strategies/chan/czsc";
import { analyzeBreakout } from "../strategies/breakout/breakout";
import { completedBarFilter } from "~/lib/completed-bars";
import { reportSecurityContext } from "../research/report-security";
import { screenSortSchema } from "~/lib/screen-sort";
import { securityProfile } from "../market/securities";
import { verifySecurityLifecycle } from "../market/security-lifecycle";
import { verifySecurityTradingStatus } from "../market/security-trading-status";
import { screenReviews, screenReviewsInput } from "../screening/screen-reviews";
import {
  reportHistory,
  reportHistoryInput,
  archivedReport,
} from "../research/report-history";
import {
  cashDividendInput,
  cashDividendJob,
} from "../backtest/cash-dividend-job";
import { queryDividendSchedule } from "../data-sources/hithink/hithink-dividends";
import {
  readBacktestActions,
  validateActionRange,
} from "../backtest/backtest-actions";
import { reconcileDividends } from "../backtest/dividend-reconciliation";
import { financialGrowth } from "../strategies/value/financial-growth";
import { fundamentalResearchInput } from "~/lib/fundamental-research";
import {
  fundamentalResearchJob,
  type FundamentalReport,
} from "../strategies/value/fundamental-report";
import {
  financialQualityJob,
  financialQualityHistory,
  type FinancialQualityArchive,
} from "../strategies/value/financial-quality";
import { valuationScenarioSchema } from "~/lib/valuation-scenario";
import {
  saveValuationScenario,
  valuationScenarioHistory,
  type ValuationScenario,
} from "../strategies/value/valuation-scenario";
import { researchHistory } from "../research/research-history";
import { wyckoffJob } from "../strategies/wyckoff/wyckoff-job";
import type { WyckoffReport } from "../strategies/wyckoff/wyckoff-report";
import { jobSummaries } from "../jobs/job-summaries";
import {
  taskHistory,
  taskState,
  screenTaskProgress,
} from "../jobs/task-history";
import { taskHistoryInput } from "~/lib/task-history";
import {
  analyzeChan,
  chanWindow,
  type ChanReport,
} from "../strategies/chan/chan-report";
import { gatherCanslimDossier } from "../strategies/canslim/canslim-dossier";
import {
  analyzeCanslimDossier,
  type CanslimResearchReport,
} from "../strategies/canslim/canslim-report";
import {
  verifySecurityIdentity,
  type IdentityCheck,
} from "../market/security-identity";
import { readClsNews } from "../data-sources/cls/cls-news";
import { walkForwardJob, walkForwardInput } from "../backtest/walk-forward-job";
import { walkForwardPage, type WalkForwardResult } from "~/lib/walk-forward";
import { explainWalkForwardJob } from "../backtest/walk-forward-explanation";
import { newsSectorHistory } from "../news/news-sector-history";
import { aggregateNewsDay } from "../news/news-day";
import { checkThemePrices, latestThemePrices } from "../news/theme-prices";
import { explainThemePricesJob } from "../news/theme-price-explanation";
import { analyzeNewsThemes, latestNewsThemes } from "../news/news-themes";
import { analyzeNewsSector, newsSectorInput } from "../news/news-sector";
import {
  analyzeNews,
  newsAnalysisInput,
  newsAnalysisView,
  type NewsAnalysis,
} from "../news/news-analysis";
import { historicalScreenSchema } from "~/lib/historical-screen";
import { backtestCostsSchema } from "~/lib/backtest-costs";
import { currentMcpHealth } from "../mcp-health";
import {
  onlineScreenJob,
  type OnlineScreenResult,
} from "../screening/online-screen";
import { researchSkillCatalog } from "../research/research-skills";
import { exportRsArchive } from "../research/rs-export";
import {
  pageScreenResults,
  exportScreenResults,
  type StoredScreenResult,
} from "../screening/screen-results";
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
import { settings, saveSettings } from "../infra/settings";
import {
  localReportLag,
  readLocalFinancials,
  resolveFinanceReportPeriod,
} from "../data-sources/tdx/tdx-financial-reports";
import {
  scanJob,
  snapshot,
  screenJob,
  backtestJob,
  startRuntime,
  tick,
} from "../runtime";
import { background, cancelJob, updateJob, readJob } from "../jobs/jobs";
import {
  analyze,
  interpret,
  snapshotEvidence,
  researchModel,
} from "../research/research";
import { saveChannel, testDelivery } from "../infra/notifications";
import {
  importLocalMcp,
  mcpTools,
  queryMcp,
  mcpConfigured,
} from "../data-sources/tdx/tdx-mcp-disabled";
import { gatherEvidence } from "../research/gather-evidence";
import { searchSecurities } from "../market/security-search";
import { securityNames } from "../data-sources/tdx/tdx";
import { findCli } from "../infra/local-llm";
import { securityDirectory, securityNameMap } from "../market/securities";
import {
  TDX_HOSTS,
  barPage,
  companyInfoCategories,
  companyInfoContent,
  configuredHosts,
  finance,
  historyMinutes,
  historyTransactionPage,
  indexBarPage,
  minutes,
  saveHosts,
  securityQuotes,
  transactionPage,
} from "../data-sources/tdx/tdx-quotes";
import {
  KLINE,
  PAGE_LIMIT,
  QUOTES_BATCH_LIMIT,
} from "../data-sources/tdx/tdx-wire";

const klineSchema = z.enum(
  Object.keys(KLINE) as [keyof typeof KLINE, ...(keyof typeof KLINE)[]],
);
const pageSchema = z.object({
  symbol: symbolSchema,
  start: z.number().int().min(0).max(65535).default(0),
  count: z.number().int().min(1).max(PAGE_LIMIT).default(PAGE_LIMIT),
});
const tradingDateSchema = z.number().int().min(19900101).max(21001231);

const deliveryPathSchema = z.string().trim().min(1).max(2048);
const deliveryInputSchema = importOptionsSchema.extend({
  path: deliveryPathSchema,
  account: z.string().trim().min(1).max(64),
});
const reviewInputSchema = z.object({
  account: z.string().trim().min(1).max(64),
});
const roundSortFields = [
  "security",
  "openingDate",
  "closingDate",
  "holdingTradingDays",
  "buyAveragePrice",
  "sellAveragePrice",
  "quantity",
  "totalFees",
  "netProfit",
  "netReturn",
] as const;

async function deliveryBytes(path: string) {
  if (![".xls", ".txt", ".csv"].includes(extname(path).toLowerCase()))
    throw new Error("仅支持 .xls / .txt / .csv 交割单文件");
  return readFile(path);
}

/** Record IDs are global across kinds. A TypeScript generic cannot restrict a
 * database read; every user-selected ID must stay in its endpoint's domain. */
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

async function accountReview(account: string) {
  const config = settings();
  const calendar = await fullLocalCalendarReference(
    config.tdxRoot,
    config.calendar,
  );
  if (!calendar.days.length)
    throw new Error("交易日历不可用，请先配置交易日历或本地指数日线后重试");
  const db = chartSqlite();
  const store = new DeliveryStore(db);
  const dates = [
    ...store.fills(account).map((f) => f.tradeDate),
    ...store.cashFlows(account).map((f) => f.flowDate),
  ].sort();
  const start = dates[0];
  const end = dates.at(-1);
  if (!start || !end)
    throw new Error("该账户暂无可复盘的成交或资金流水，请先导入");
  if (calendar.days[0]! > start || calendar.days.at(-1)! < end)
    throw new Error(
      `交易日历未覆盖账户流水区间：日历实际覆盖 ${calendar.coverage.start} 至 ${calendar.coverage.end}，账户流水 ${start} 至 ${end}；日历共 ${calendar.coverage.count} 条；请补齐本地日历后重试`,
    );
  const tradingDays = calendar.days.filter((day) => day >= start && day <= end);
  if (!tradingDays.length) throw new Error("流水区间内没有可用交易日历");
  const snapshot = await buildTradeReviewSnapshot(
    {
      account,
      tdxRoot: config.tdxRoot,
      blocksRoot: config.industryBlocksRoot || undefined,
      tradingDays,
    },
    db,
  );
  return {
    snapshot,
    fullTradingDays: calendar.days,
    calendar: {
      source: calendar.source,
      hash: calendar.hash,
      coverage: calendar.coverage,
      start: tradingDays[0],
      end: tradingDays.at(-1),
    },
  };
}

export const appRouter = createTRPCRouter({
  mxDataStatus: p.query(() => mxDataStatus()),
  mxDataQuery: p
    .input(mxQuerySchema)
    .mutation(({ input, signal }) => queryMxData(input, signal)),
  disciplineStart: p.input(disciplineRequestSchema).mutation(({ input }) => {
    const store = new DeliveryStore(chartSqlite()),
      config = settings();
    const ledger = store.db.transaction(() => ({
      fills: store.fills(input.account),
      cashFlows: store.cashFlows(input.account),
    }))();
    return startDiscipline(input.account, {
      ...ledger,
      openingCash: input.openingCash,
      stopCosts: input.stopCosts,
      tdxRoot: config.tdxRoot,
      calendar: config.calendar,
    });
  }),
  disciplineStatus: p
    .input(z.string().uuid())
    .query(({ input }) => disciplineStatus(input)),
  disciplineCancel: p
    .input(z.string().uuid())
    .mutation(({ input }) => cancelDiscipline(input)),
  disciplineExport: p
    .input(z.string().uuid())
    .query(({ input }) => exportDiscipline(input)),
  deliveryFiles: p.input(deliveryPathSchema).query(async ({ input }) => {
    const directory = resolve(input);
    const entries = await readdir(directory, { withFileTypes: true });
    return Promise.all(
      entries
        .filter(
          (entry) =>
            entry.isFile() &&
            [".xls", ".txt", ".csv"].includes(
              extname(entry.name).toLowerCase(),
            ),
        )
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(async (entry) => {
          const path = resolve(directory, entry.name);
          const info = await stat(path);
          return {
            name: entry.name,
            path,
            size: info.size,
            modifiedAt: info.mtimeMs,
          };
        }),
    );
  }),
  deliveryPreview: p
    .input(deliveryInputSchema)
    .query(async ({ input }) =>
      previewDeliveryImport(
        await deliveryBytes(input.path),
        { ...input, fileName: basename(input.path) },
        chartSqlite(),
      ),
    ),
  deliveryImport: p
    .input(
      deliveryInputSchema.extend({ hash: z.string().regex(/^[a-f0-9]{64}$/) }),
    )
    .mutation(async ({ input }) => {
      const bytes = await deliveryBytes(input.path);
      if (createHash("sha256").update(bytes).digest("hex") !== input.hash)
        throw new Error("文件已改变，请重新预览后确认导入");
      return commitDeliveryImport(
        bytes,
        { ...input, fileName: basename(input.path) },
        chartSqlite(),
      );
    }),
  deliveryBatches: p.query(() =>
    new DeliveryStore(chartSqlite()).batches().map(({ payload, ...batch }) => ({
      ...batch,
      statistics: payload.statistics,
      ...(payload.scope ? { scope: payload.scope } : {}),
      ...(payload.statementOpeningCash !== undefined
        ? { statementOpeningCash: payload.statementOpeningCash }
        : {}),
      ...(payload.counts ? { counts: payload.counts } : {}),
    })),
  ),
  deliveryRevoke: p
    .input(z.string().min(1).max(128))
    .mutation(({ input }) =>
      new DeliveryStore(chartSqlite()).revokeBatch(input),
    ),
  tradeReviewAdmission: p
    .input(admissionPageSchema.extend({ account: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return pageStrategyAdmission(
        tradeReviewAdmissionSource(review.snapshot, review.fullTradingDays),
        input,
        false,
      );
    }),
  tradeReviewAdmissionExport: p
    .input(
      admissionPageSchema
        .pick({ params: true })
        .extend({ account: z.string().trim().min(1) }),
    )
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return exportStrategyAdmission(
        tradeReviewAdmissionSource(review.snapshot, review.fullTradingDays),
        input.params,
        false,
      );
    }),
  strategyResearchAdmission: p
    .input(
      admissionPageSchema.extend({
        id: z.string().min(1),
        partition: z.enum(["development", "validation"]),
      }),
    )
    .query(({ input }) => {
      const store = new ResearchStore(chartSqlite());
      if (!store.isResultVisible(input.id))
        throw new Error(
          store.task(input.id) ? "最终验证尚未揭示" : "研究结果尚不可得",
        );
      const result = store.result(input.id),
        dataset = store.dataset(input.id);
      if (!result || !dataset) throw new Error("研究结果或冻结快照尚不可得");
      return threeSegmentAdmission(
        store.db,
        result,
        dataset,
        input.partition,
        input,
      ).page;
    }),
  strategyResearchAdmissionExport: p
    .input(
      admissionPageSchema.pick({ params: true }).extend({
        id: z.string().min(1),
        partition: z.enum(["development", "validation"]),
      }),
    )
    .query(({ input }) => {
      const store = new ResearchStore(chartSqlite());
      if (!store.isResultVisible(input.id))
        throw new Error(
          store.task(input.id) ? "最终验证尚未揭示" : "研究结果尚不可得",
        );
      const result = store.result(input.id),
        dataset = store.dataset(input.id);
      if (!result || !dataset) throw new Error("研究结果或冻结快照尚不可得");
      return threeSegmentAdmission(
        store.db,
        result,
        dataset,
        input.partition,
        admissionPageSchema.parse(input),
      ).exported;
    }),
  tradeReviewHoldingsCorrelation: p
    .input(
      holdingsCorrelationPageSchema.extend({
        account: z.string().trim().min(1),
      }),
    )
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return pageHoldingsCorrelation(
        {
          days: review.snapshot.nav.days,
          tradingDays: review.fullTradingDays,
          bars: review.snapshot.replayInput.trades.bars ?? {},
        },
        input,
      );
    }),
  tradeReviewPositionRisk: p
    .input(positionRiskPageSchema.extend({ account: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return pagePositionRisk(review.snapshot.nav.days, input);
    }),
  tradeReviewRollingPerformance: p
    .input(rollingPageSchema.extend({ account: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return tradeReviewRollingPage(
        review.snapshot,
        input,
        review.fullTradingDays,
      );
    }),
  strategyResearchRollingPerformance: p
    .input(
      rollingPageSchema.extend({
        id: z.string().min(1),
        partition: z.enum(["development", "validation"]),
      }),
    )
    .query(({ input }) => {
      const store = new ResearchStore(chartSqlite());
      if (!store.isResultVisible(input.id))
        throw new Error(
          store.task(input.id) ? "最终验证尚未揭示" : "研究结果尚不可得",
        );
      return researchRollingPage(store, input.id, input.partition, input);
    }),
  tradeReviewPeriodPerformance: p
    .input(periodPageSchema.extend({ account: z.string().trim().min(1) }))
    .query(async ({ input }) => {
      const review = await accountReview(input.account);
      return tradeReviewPeriodPage(
        review.snapshot,
        input,
        review.fullTradingDays,
      );
    }),
  strategyResearchPeriodPerformance: p
    .input(
      periodPageSchema.extend({
        id: z.string().min(1),
        partition: z.enum(["development", "validation"]),
      }),
    )
    .query(({ input }) => {
      const store = new ResearchStore(chartSqlite());
      if (!store.isResultVisible(input.id))
        throw new Error(
          store.task(input.id) ? "最终验证尚未揭示" : "研究结果尚不可得",
        );
      return researchPeriodPage(store, input.id, input.partition, input);
    }),
  tradeReviewExecution: p
    .input(executionPageSchema)
    .query(async ({ input }) =>
      pageExecutionQuality(
        (await accountReview(input.account)).snapshot,
        input,
      ),
    ),
  tradeReviewCashReconciliation: p
    .input(
      cashReconciliationPageSchema.extend({
        account: z.string().trim().min(1),
      }),
    )
    .query(async ({ input }) =>
      cashReconciliationPage(
        (await accountReview(input.account)).snapshot.cashReconciliation,
        input,
      ),
    ),
  tradeReviewCashReconciliationExport: p
    .input(z.object({ account: z.string().trim().min(1) }))
    .query(
      async ({ input }) =>
        (await accountReview(input.account)).snapshot.cashReconciliation,
    ),
  tradeReviewExecutionExport: p
    .input(executionPageSchema)
    .query(async ({ input }) =>
      exportExecutionQuality(
        (await accountReview(input.account)).snapshot,
        input,
      ),
    ),
  tradeReviewSnapshot: p
    .input(
      reviewInputSchema.extend({
        method: z.enum(costMethods).default("movingAverage"),
        keyTradesN: z.number().int().min(1).max(20).default(3),
        pageIndex: z.number().int().min(0).max(1000000).default(0),
        pageSize: z.number().int().min(1).max(100).default(20),
        pointPageIndex: z.number().int().min(0).max(1000000).default(0),
        pointPageSize: z.number().int().min(1).max(100).default(10),
        pointSort: z.enum(["fillIndex", "security"]).default("fillIndex"),
        pointDesc: z.boolean().default(false),
        attributionPageIndex: z.number().int().min(0).max(1000000).default(0),
        attributionPageSize: z.number().int().min(1).max(100).default(10),
        attributionSort: z
          .enum(["dimension", "name", "sampleCount", "netProfitTotal"])
          .default("dimension"),
        attributionDesc: z.boolean().default(false),
        drawdownPageIndex: z.number().int().min(0).max(1000000).default(0),
        drawdownPageSize: z.number().int().min(1).max(100).default(10),
        drawdownSort: z
          .enum([
            "peakDate",
            "troughDate",
            "recoveryDate",
            "drawdown",
            "drawdownTradingDays",
            "recoveryTradingDays",
            "underwaterTradingDays",
          ])
          .default("drawdown"),
        drawdownDesc: z.boolean().default(true),
        monthPageIndex: z.number().int().min(0).max(10000).default(0),
        sort: z.enum(roundSortFields).default("openingDate"),
        desc: z.boolean().default(false),
      }),
    )
    .query(async ({ input }) => {
      const { snapshot: s, calendar } = await accountReview(input.account);
      const selected = s.trades[input.method];
      const rounds = [...selected.closedRounds, ...selected.openPositions].map(
        (round, index) => ({ ...round, id: `${input.method}-${index}` }),
      );
      const field = (round: ReviewRound) => {
        const v = round[input.sort];
        return typeof v === "object" && v !== null ? v.value : v;
      };
      rounds.sort((a, b) => {
        const x = field(a),
          y = field(b);
        if (x === null || y === null)
          return x === y ? a.id.localeCompare(b.id) : x === null ? 1 : -1;
        const order =
          typeof x === "number" && typeof y === "number"
            ? x - y
            : String(x).localeCompare(String(y));
        return (input.desc ? -order : order) || a.id.localeCompare(b.id);
      });
      const excludedCashFlows = s.excludedCashFlows.map((row) => {
        const batch = s.replayInput.batches.find((b) => b.id === row.batchId)!;
        const index = batch.payload.mapping.columns.netAmount;
        const raw =
          index === undefined
            ? ""
            : (row.cells[index] ?? "").replaceAll(",", "").trim();
        const amount =
          /^[+-]?\d+(\.\d+)?$/.test(raw) && Number.isFinite(Number(raw))
            ? Number(raw)
            : null;
        return {
          ...row,
          amount,
          amountReason:
            amount === null ? "作废行缺少可识别的发生金额，未计入合计" : null,
        };
      });
      const page = <T>(rows: T[], index: number, size: number) =>
        rows.slice(index * size, (index + 1) * size);
      const compare = (
        x: string | number | null,
        y: string | number | null,
        desc: boolean,
      ) => {
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
        const order =
          typeof x === "number" && typeof y === "number"
            ? x - y
            : String(x).localeCompare(String(y));
        return desc ? -order : order;
      };
      const tradePoints = [...s.trades.tradePoints].sort(
        (a, b) =>
          compare(a[input.pointSort], b[input.pointSort], input.pointDesc) ||
          a.fillIndex - b.fillIndex,
      );
      const drawdownPage = pageTradeReviewDrawdowns(s.nav.segments, {
        pageIndex: input.drawdownPageIndex,
        pageSize: input.drawdownPageSize,
        sort: input.drawdownSort,
        desc: input.drawdownDesc,
      });
      const attribution = s.attribution[input.method].groups
        .flatMap((group) =>
          group.items.map(
            ({ rounds: _rounds, roundIndices: _indices, ...item }) => ({
              ...item,
              dimension: group.dimension,
              sampleNote: group.sampleNote,
              id: `${group.dimension}:${item.name}`,
            }),
          ),
        )
        .sort(
          (a, b) =>
            compare(
              a[input.attributionSort],
              b[input.attributionSort],
              input.attributionDesc,
            ) || a.id.localeCompare(b.id),
        );
      return {
        account: s.account,
        basis: s.basis,
        calendar,
        rounds: rounds.slice(
          input.pageIndex * input.pageSize,
          (input.pageIndex + 1) * input.pageSize,
        ),
        rowCount: rounds.length,
        keyTrades: keyTrades(
          [...selected.closedRounds, ...selected.openPositions],
          input.keyTradesN,
        ),
        tradePoints: page(
          tradePoints,
          input.pointPageIndex,
          input.pointPageSize,
        ),
        pointCount: tradePoints.length,
        nav: {
          ...s.nav,
          segments: drawdownPage.segments,
          monthlyReturns: s.nav.monthlyReturns.slice(
            input.monthPageIndex * 12,
            (input.monthPageIndex + 1) * 12,
          ),
        },
        drawdowns: drawdownPage.drawdowns,
        drawdownCount: drawdownPage.drawdownCount,
        monthCount: s.nav.monthlyReturns.length,
        attribution: page(
          attribution,
          input.attributionPageIndex,
          input.attributionPageSize,
        ),
        attributionCount: attribution.length,
        unexplainedCashResidual: s.unexplainedCashResidual,
        excludedCashFlows,
        feeSources: s.replayInput.trades.fills.map((fill, index) => ({
          index,
          security: fill.symbol ?? fill.code,
          date: fill.tradeDate,
          sources: rounds
            .flatMap((r) => r.feeSources)
            .concat(s.reverseRepo.feeSources)
            .filter((f) => f.fillIndex === index)
            .slice(0, 1),
        })),
        missingMarketData: s.missingMarketData,
        warnings: s.warnings,
        exceptions: s.exceptions,
        pendingRows: s.pendingRows,
      };
    }),
  tradeReviewExport: p
    .input(reviewInputSchema)
    .query(async ({ input }) =>
      exportTradeReview((await accountReview(input.account)).snapshot),
    ),
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
    const store = new ResearchStore(chartSqlite());
    return store.tasks().map((task) => store.projectTask(task));
  }),
  strategyResearchCreate: p
    .input(
      z.object({
        spec: researchSpecSchema.refine(
          (spec) => !!spec.symbols?.length,
          "请先选择研究品种清单",
        ),
        evidence: researchMarketEvidenceSchema.nullable(),
        mode: z
          .enum(["exploration", "final-validation"])
          .default("exploration"),
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
        input.mode,
      );
      return new ResearchStore(chartSqlite()).projectTask(
        launchResearch(task.id),
      );
    }),
  strategyResearchRetry: p.input(z.string()).mutation(({ input }) => {
    const task = new ResearchStore(chartSqlite()).retry(input);
    return new ResearchStore(chartSqlite()).projectTask(
      launchResearch(task.id),
    );
  }),
  strategyResearchCancel: p
    .input(z.string())
    .mutation(({ input }) => cancelResearch(input)),
  strategyResearchSegments: p.input(z.string().min(1)).query(({ input }) => {
    const store = new ResearchStore(chartSqlite());
    if (!store.isResultVisible(input))
      throw new Error(
        store.task(input) ? "最终验证尚未揭示" : "研究结果尚不可得",
      );
    const result = store.result(input),
      dataset = store.dataset(input);
    if (!result || !dataset) throw new Error("研究结果或冻结快照尚不可得");
    return threeSegmentSample(store.db, result, dataset);
  }),
  strategyResearchResult: p.input(z.string()).query(({ input }) => {
    const store = new ResearchStore(chartSqlite());
    return store.isResultVisible(input) ? store.result(input) : null;
  }),
  strategyResearchGovernance: p
    .input(z.string().min(1))
    .query(({ input }) => new ResearchStore(chartSqlite()).governance(input)),
  strategyResearchReveal: p
    .input(z.string().min(1))
    .mutation(({ input }) => new ResearchStore(chartSqlite()).reveal(input)),
  strategyResearchExport: p.input(z.string()).query(({ input }) => {
    const store = new ResearchStore(chartSqlite());
    if (!store.isResultVisible(input))
      throw new Error("最终验证尚未揭示，不能导出快照或结果");
    const result = store.result(input),
      dataset = store.dataset(input);
    return {
      task: store.task(input),
      dataset: store.dataset(input),
      evidence: store.evidence(input),
      result,
      threeSegments:
        result && dataset
          ? threeSegmentSample(store.db, result, dataset)
          : null,
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
        run: recordOfKind("intraday-run", observation.sessionId),
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
  universeAuditPage: p
    .input(universeAuditQuerySchema)
    .query(({ input }) => universeAuditPage(input)),
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
  /* RPS 批次历史。只取RPS观测工作流写入的检查记录，不混入财联社分析批次。 */
  rpsWorkflowLog: p.query(() => {
    const rows = chartSqlite()
      .prepare(
        "SELECT id, payload, updated_at AS updatedAt FROM records WHERE kind='workflow-check' AND id LIKE ? ORDER BY updated_at DESC LIMIT 50",
      )
      .all(`${rpsLogIdPrefix}%`) as {
      id: string;
      payload: string;
      updatedAt: number;
    }[];
    return rows
      .map((row) =>
        toRpsLogEntry({
          id: row.id,
          payload: JSON.parse(row.payload),
          updatedAt: row.updatedAt,
        }),
      )
      .filter((entry) => entry !== null);
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
  /*
   * 基本面主源：本地只读财务包，读盘即得、报告期来自包头，不碰公共服务器。
   */
  tdxLocalFinancials: p
    .input(symbolSchema)
    .query(({ input }) => readLocalFinancials(settings().tdxRoot, input)),
  /*
   * 协议快照作为叠加：提供最新股本（本地只有报告期末口径）、上市日期与股本结构槽位，
   * 并通过反查报告期判断本地财务包是否该更新。它慢且依赖公共服务器，所以与上面分开，
   * 由页面先渲染本地数据再补齐。
   */
  tdxFinance: p.input(symbolSchema).query(async ({ input }) => {
    const snapshot = await finance(input);
    const root = settings().tdxRoot;
    const period = await resolveFinanceReportPeriod(root, input, snapshot);
    const local = await readLocalFinancials(root, input);
    return {
      finance: snapshot,
      period,
      lag: localReportLag(local.financials, period),
    };
  }),
  /** F10 栏目清单；正文按需单独取，避免展开即拉全部文本。 */
  tdxCompanyInfo: p
    .input(symbolSchema)
    .query(({ input }) => companyInfoCategories(input)),
  tdxCompanyInfoContent: p
    .input(
      z.object({
        symbol: symbolSchema,
        filename: z.string().min(1).max(120),
        start: z.number().int().min(0).max(0x7fffffff),
        length: z
          .number()
          .int()
          .min(1)
          .max(1024 * 1024),
      }),
    )
    .query(({ input }) =>
      companyInfoContent(
        input.symbol,
        input.filename,
        input.start,
        input.length,
      ),
    ),
  fundamentalAnalyze: p
    .input(fundamentalResearchInput)
    .mutation(({ input }) => {
      if (
        !storedSnapshot(input.snapshotId) ||
        !recordOfKind("financial-quality", input.financeId) ||
        (input.scenarioId &&
          !recordOfKind("valuation-scenario", input.scenarioId))
      )
        throw new Error("基本面分析所需快照、财务档案或估值方案不存在");
      return fundamentalResearchJob(input);
    }),
  fundamentalHistory: p.query(() => researchHistory("fundamental-report")),
  fundamentalReport: p
    .input(z.string().regex(/^fundamental-report-[a-f0-9]{64}$/))
    .query(
      ({ input }) =>
        recordOfKind<FundamentalReport>("fundamental-report", input) ?? null,
    ),
  financialQualityCreate: p
    .input(symbolSchema)
    .mutation(({ input }) => financialQualityJob(input)),
  financialQualityHistory: p.query(() => financialQualityHistory()),
  financialQualityReport: p
    .input(z.string().regex(/^financial-quality-[a-f0-9]{64}$/))
    .query(
      ({ input }) =>
        recordOfKind<FinancialQualityArchive>("financial-quality", input) ??
        null,
    ),
  financialGrowthReport: p
    .input(z.string().regex(/^financial-quality-[a-f0-9]{64}$/))
    .query(({ input }) => {
      const archive = recordOfKind<FinancialQualityArchive>(
        "financial-quality",
        input,
      );
      return archive ? financialGrowth(archive) : null;
    }),
  valuationSave: p
    .input(valuationScenarioSchema)
    .mutation(({ input }) => ({ id: saveValuationScenario(input).id })),
  valuationHistory: p.query(() => valuationScenarioHistory()),
  valuationReport: p
    .input(z.string().regex(/^valuation-scenario-[a-f0-9]{64}$/))
    .query(
      ({ input }) =>
        recordOfKind<ValuationScenario>("valuation-scenario", input) ?? null,
    ),
  wyckoffAnalyze: p
    .input(
      z.object({
        snapshotId: z.string().min(1),
        question: z.string().trim().min(1).max(2000),
      }),
    )
    .mutation(({ input }) => {
      if (!storedSnapshot(input.snapshotId))
        throw new Error("请先加载行情快照");
      return wyckoffJob(input.snapshotId, input.question);
    }),
  wyckoffHistory: p.query(() => researchHistory("wyckoff-report")),
  wyckoffReport: p
    .input(z.string().regex(/^wyckoff-report-[a-f0-9]{64}$/))
    .query(
      ({ input }) =>
        recordOfKind<WyckoffReport>("wyckoff-report", input) ?? null,
    ),
  savedSnapshot: p.input(z.string().min(1)).query(({ input }) => {
    const source = storedSnapshot(input);
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
  researchUsage: p
    .input(researchRangeSchema)
    .query(({ input }) => researchUsage(input)),
  researchAttempts: p
    .input(researchAttemptsQuerySchema)
    .query(({ input }) => new ResearchAttempts(chartSqlite()).page(input)),
  holdoutSettings: p.query(() => ({ holdoutStart: settings().holdoutStart })),
  saveHoldoutStart: p
    .input(researchDateSchema.nullable())
    .mutation(({ input }) => {
      saveSettings({ ...settings(), holdoutStart: input });
      return { holdoutStart: input };
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
      const source = storedSnapshot(input.snapshotId);
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
      const source = storedSnapshot(input.snapshotId);
      if (!source || !Array.isArray(source.bars))
        throw new Error("行情快照不存在");
      return analyzeCzsc(source.bars);
    }),
  snapshot: p
    .input(
      z.object({
        symbol: chartSymbolSchema,
        period: periodSchema,
        source: z.union([marketSourceSchema, z.literal("online")]).optional(),
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
  walkForward: p.input(walkForwardInput).mutation(({ input }) => {
    if (!storedSnapshot(input.snapshotId)) throw new Error("请先加载行情快照");
    return walkForwardJob(input);
  }),
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
    .query(({ input }) => {
      const result = recordOfKind<WalkForwardResult>("walk-forward", input);
      return result ? walkForwardPage(result) : null;
    }),
  walkForwardExport: p
    .input(z.string().regex(/^walk-forward-[a-f0-9-]{36}$/))
    .query(
      ({ input }) =>
        recordOfKind<WalkForwardResult>("walk-forward", input) ?? null,
    ),
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
      const source = storedSnapshot(input.snapshotId);
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
      const source = storedSnapshot(input.snapshotId);
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
    .query(
      ({ input }) => recordOfKind<ChanReport>("chan-report", input) ?? null,
    ),
  canslimAnalyze: p
    .input(z.object({ snapshotId: z.string() }))
    .mutation(({ input }) => {
      const source = storedSnapshot(input.snapshotId);
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
    .query(
      ({ input }) =>
        recordOfKind<CanslimResearchReport>("canslim-report", input) ?? null,
    ),
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
      const record = recordOfKind<NewsAnalysis>("news-analysis", input);
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
    .query(
      ({ input }) =>
        recordOfKind<IdentityCheck>("security-identity", `identity-${input}`) ??
        null,
    ),
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
      const job = readJob(input.id);
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
      const job = readJob(input.id);
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
    const job = readJob(input);
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
    const d = recordOfKind<Delivery>("delivery", input);
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
        source: marketSourceSchema.default("local"),
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
        if (!recordOfKind<Channel>("channel", id))
          throw new Error("通知渠道不存在");
      if (
        input.id &&
        chartSqlite()
          .prepare("SELECT id FROM records WHERE id=? AND kind<>'monitor'")
          .get(input.id)
      )
        throw new Error("不能覆盖其他类型记录");
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
      const m = recordOfKind<Monitor>("monitor", input.id);
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
} from "../screening/formula-screen-service";
