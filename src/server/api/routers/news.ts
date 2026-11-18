import { newsAnalysisIdForTask } from "../../db/workflow-history";
import { intelEvents, todayIntel } from "../../news/intel-service";
import { intelEventQuerySchema } from "~/lib/news/intel-events";
import { readArchiveRecord } from "../../db/archive-records";
import { clsReviewConfigSchema } from "~/lib/news/cls-review-config";
import {
  clsReviewReportQuery,
  clsReviewFactQuery,
  clsReviewVerificationQuery,
  clsReviewVerificationIdentity,
} from "~/lib/news/cls-review-workspace";
import {
  clsReportPage,
  clsFactPage,
  clsFactDetail,
  clsVerificationPage,
  clsVerificationDetail,
  clsSampleView,
  clsReportSamples,
} from "../../db/cls-review-query";
import {
  clsReviewConfig,
  clsReviewLastCheck,
  saveClsReviewConfig,
} from "../../news/cls-review-scheduler";
import {
  clsFactReviewSchema,
  clsFactStatistics,
} from "~/lib/news/cls-fact-review";
import { clsReportFiles, previewClsReport } from "../../news/cls-report-files";
import { ClsReviewStore } from "../../db/cls-review-store";
import {
  fixClsSample,
  clsSampleEligibility,
} from "../../news/cls-review-service";
import { verifyClsSample } from "../../news/cls-verification";
import { sqlite as chartSqlite } from "../../db";
import { newsBudget } from "../../news/news-budget";
import { readClsNews } from "../../data-sources/cls/cls-news";
import { newsSectorHistory } from "../../db/news-sector-history";
import { aggregateNewsDay } from "../../news/news-day";
import { checkThemePrices } from "../../news/theme-prices";
import { latestThemePrices } from "../../db/theme-prices";
import { explainThemePricesJob } from "../../news/theme-price-explanation";
import { analyzeNewsThemes } from "../../news/news-themes";
import { latestNewsThemes } from "../../db/news-themes";
import { analyzeNewsSector, newsSectorInput } from "../../news/news-sector";
import {
  analyzeNews,
  newsAnalysisInput,
  newsAnalysisView,
  newsAnalysisPreflight,
  type NewsAnalysis,
} from "../../news/news-analysis";
import { z } from "zod";
import { list } from "../../db";
import { settings } from "../../infra/settings";
import { background, updateJob } from "../../jobs/jobs";
import { taskState } from "../../db/task-history";
import { researchModel } from "../../research/research";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
import {
  newsWorkspaceSchema,
  newsArchiveQuerySchema,
  newsArchiveIdSchema,
} from "~/lib/news/news-workspace";
import {
  newsWorkspacePage,
  newsWorkspaceDetail,
  newsArchivePage,
} from "../../db/news-workspace-query";
export const newsRouter = createTRPCRouter({
  intelEvents: p("news", "read")
    .input(intelEventQuerySchema)
    .query(({ input }) => intelEvents(input)),
  todayIntel: p("news", "read").query(() => todayIntel()),
  clsReviewFactDetail: p("news", "read")
    .input(
      z.object({
        reportId: z.string().min(1).max(200),
        id: z.string().min(1).max(200),
      }),
    )
    .query(({ input }) =>
      clsFactDetail(chartSqlite(), input.reportId, input.id),
    ),
  clsReviewSampleEligibility: p("news", "read")
    .input(z.string().min(1).max(200))
    .query(({ input }) => clsSampleEligibility(input)),
  clsReviewReportPage: p("news", "read")
    .input(clsReviewReportQuery)
    .query(({ input }) => clsReportPage(chartSqlite(), input)),
  clsReviewFactPage: p("news", "read")
    .input(clsReviewFactQuery)
    .query(({ input }) => clsFactPage(chartSqlite(), input)),
  clsReviewVerificationPage: p("news", "read")
    .input(clsReviewVerificationQuery)
    .query(({ input }) => clsVerificationPage(chartSqlite(), input)),
  clsReviewVerificationDetail: p("news", "read")
    .input(clsReviewVerificationIdentity)
    .query(({ input }) => clsVerificationDetail(chartSqlite(), input)),
  clsReviewReportSamples: p("news", "read")
    .input(z.string().min(1).max(200))
    .query(({ input }) => clsReportSamples(chartSqlite(), input)),
  newsAnalysisContext: p("news", "read").query(() => ({
    model: researchModel(false),
  })),
  newsTaskState: p("news", "read")
    .input(z.string().min(1).max(200))
    .query(({ input }) => {
      const state = taskState(input);
      if (!state) return null;
      // Polling sees queued/running states with no archive; only a terminal
      // state can have one, so other states skip the archive lookup entirely.
      if (
        state.status !== "completed" &&
        state.status !== "failed" &&
        state.status !== "cancelled"
      )
        return { ...state, analysisId: null };
      const analysisId = newsAnalysisIdForTask(input);
      return {
        ...state,
        analysisId:
          analysisId && newsArchiveIdSchema.safeParse(analysisId).success
            ? analysisId
            : null,
      };
    }),
  newsWorkspace: p("news", "read")
    .input(newsWorkspaceSchema)
    .query(({ input }) => newsWorkspacePage(settings().clsDbPath, input)),
  newsOriginal: p("news", "read")
    .input(
      z.object({
        filter: newsWorkspaceSchema,
        id: z.number().int().positive(),
        source: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .query(({ input }) =>
      newsWorkspaceDetail(
        settings().clsDbPath,
        input.filter,
        input.id,
        input.source,
      ),
    ),
  newsArchiveHistory: p("news", "read")
    .input(newsArchiveQuerySchema)
    .query(({ input }) => newsArchivePage(chartSqlite(), input)),
  newsResumePreflight: p("news", "read")
    .input(newsArchiveIdSchema)
    .query(({ input }) => newsAnalysisPreflight(input)),
  clsReviewExportAll: p("news", "read")
    .input(z.string())
    .query(({ input }) =>
      new ClsReviewStore(chartSqlite()).exportReport(input),
    ),
  clsReviewRemove: p("news", "configure")
    .input(z.string())
    .mutation(({ input }) =>
      new ClsReviewStore(chartSqlite()).removeReport(input),
    ),
  clsReviewSummary: p("news", "read").query(() =>
    new ClsReviewStore(chartSqlite()).outcomeSummary(),
  ),
  clsReviewSchedule: p("news", "read").query(() => ({
    config: clsReviewConfig(),
    lastCheck: clsReviewLastCheck(),
  })),
  clsReviewSaveSchedule: p("news", "configure")
    .input(clsReviewConfigSchema)
    .mutation(({ input }) => saveClsReviewConfig(input)),
  clsReviewSaveFact: p("news", "configure")
    .input(clsFactReviewSchema)
    .mutation(({ input }) => new ClsReviewStore(chartSqlite()).saveFact(input)),
  clsReviewFacts: p("news", "read")
    .input(z.string())
    .query(({ input }) => {
      const rows = new ClsReviewStore(chartSqlite()).facts(input);
      return { rows, statistics: clsFactStatistics(rows) };
    }),
  clsReviewVerify: p("news", "compute")
    .input(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .mutation(({ input }) => verifyClsSample(input)),
  clsReviewVerifications: p("news", "read")
    .input(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .query(({ input }) =>
      new ClsReviewStore(chartSqlite()).verifications(input),
    ),
  clsReviewFiles: p("news", "read")
    .input(z.string().min(1).max(2048))
    .query(({ input }) => clsReportFiles(input)),
  clsReviewPreview: p("news", "read")
    .input(z.string().min(1).max(2048))
    .query(({ input }) => previewClsReport(input)),
  clsReviewImport: p("news", "configure")
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
  clsReviewReports: p("news", "read")
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
  clsReviewExport: p("news", "read")
    .input(z.string())
    .query(({ input }) => new ClsReviewStore(chartSqlite()).report(input)),
  clsReviewFixSample: p("news", "compute")
    .input(z.string())
    .mutation(({ input }) => fixClsSample(input)),
  clsReviewSample: p("news", "read")
    .input(z.string().regex(/^\d{4}-\d{2}-\d{2}$/))
    .query(({ input }) => clsSampleView(chartSqlite(), input)),
  newsBudget: p("news", "read").query(() => newsBudget()),
  newsAnalyses: p("news", "read").query(() => {
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
  newsAnalysis: p("news", "read")
    .input(z.string().regex(/^news-analysis-[a-f0-9]{64}$/))
    .query(({ input }) => {
      const record = readArchiveRecord("news-analysis", input);
      return record ? newsAnalysisView(record) : null;
    }),
  newsSectorReports: p("news", "read")
    .input(z.string().regex(/^news-analysis-[a-f0-9]{64}$/))
    .query(({ input }) => newsSectorHistory(input)),
  explainThemePrices: p("news", "compute")
    .input(z.string().regex(/^theme-prices-[a-f0-9]{64}$/))
    .mutation(({ input }) => explainThemePricesJob(input)),
  themePrices: p("news", "read")
    .input(z.string().regex(/^news-themes-[a-f0-9]{64}$/))
    .query(({ input }) => latestThemePrices(input)),
  checkThemePrices: p("news", "compute")
    .input(z.string().regex(/^news-themes-[a-f0-9]{64}$/))
    .mutation(({ input }) =>
      background(
        "research",
        { kind: "theme-prices", themeId: input },
        (_job, signal) => checkThemePrices(input, signal),
        { kind: "theme-prices", input },
      ),
    ),
  newsThemes: p("news", "read")
    .input(z.string().regex(/^news-analysis-[a-f0-9]{64}$/))
    .query(({ input }) => latestNewsThemes(input)),
  analyzeNewsThemes: p("news", "compute")
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
  aggregateNewsDay: p("news", "compute")
    .input(z.string().regex(/^news-analysis-[a-f0-9]{64}$/))
    .mutation(({ input }) => aggregateNewsDay(input)),
  analyzeNewsSector: p("news", "compute")
    .input(newsSectorInput)
    .mutation(({ input }) =>
      background(
        "research",
        { kind: "news-sector", ...input },
        (_job, signal) => analyzeNewsSector(input, signal),
      ),
    ),
  analyzeNews: p("news", "compute")
    .input(newsAnalysisInput)
    .mutation(({ input }) =>
      background(
        "research",
        { kind: "news-analysis", ...input },
        (job, signal) =>
          analyzeNews(
            input,
            signal,
            (done, total) =>
              updateJob(job.id, {
                progress: Math.round((done / total) * 100),
                phase: `新闻分析 ${done}/${total}`,
              }),
            "interactive",
            undefined,
            (newsAnalysisId) => updateJob(job.id, { newsAnalysisId }),
          ),
        { kind: "news-analysis", input },
      ),
    ),
  news: p("news", "read")
    .input(
      z.object({
        cutoff: z.number().int().nonnegative(),
        page: z.number().int().min(0).default(0),
        query: z.string().max(100).default(""),
        historical: z.boolean().default(true),
      }),
    )
    .query(({ input }) => readClsNews(settings().clsDbPath, input)),
});
