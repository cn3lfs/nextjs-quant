import { clsReviewConfigSchema } from "~/lib/news/cls-review-config";
import {
  clsReviewConfig,
  clsReviewLastCheck,
  saveClsReviewConfig,
} from "../../news/cls-review-scheduler";
import { clsFactReviewSchema, clsFactStatistics } from "~/lib/news/cls-fact-review";
import { clsReportFiles, previewClsReport } from "../../news/cls-report-files";
import { ClsReviewStore } from "../../news/cls-review-store";
import { fixClsSample } from "../../news/cls-review-service";
import { verifyClsSample } from "../../news/cls-verification";
import { sqlite as chartSqlite } from "../../db";
import { newsBudget } from "../../news/news-budget";
import { readClsNews } from "../../data-sources/cls/cls-news";
import { newsSectorHistory } from "../../news/news-sector-history";
import { aggregateNewsDay } from "../../news/news-day";
import { checkThemePrices, latestThemePrices } from "../../news/theme-prices";
import { explainThemePricesJob } from "../../news/theme-price-explanation";
import { analyzeNewsThemes, latestNewsThemes } from "../../news/news-themes";
import { analyzeNewsSector, newsSectorInput } from "../../news/news-sector";
import {
  analyzeNews,
  newsAnalysisInput,
  newsAnalysisView,
  type NewsAnalysis,
} from "../../news/news-analysis";
import { z } from "zod";
import { list } from "../../db";
import { settings } from "../../infra/settings";
import { background, updateJob } from "../../jobs/jobs";
import { researchModel } from "../../research/research";
import { createTRPCRouter, publicProcedure as p } from "../trpc";
function recordOfKind<T>(kind: string, id: string): T | undefined {
  const row = chartSqlite()
    .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
    .get(kind, id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T) : undefined;
}
export const newsRouter = createTRPCRouter({
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
  newsBudget: p.query(() => newsBudget()),
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
});
