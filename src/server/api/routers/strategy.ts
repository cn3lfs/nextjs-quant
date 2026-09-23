import { sqlite as chartSqlite } from "../../db";
import { analyzeCzsc } from "../../strategies/chan/czsc";
import { analyzeBreakout } from "../../strategies/breakout/breakout";
import { completedBarFilter } from "~/lib/completed-bars";
import { financialGrowth } from "../../strategies/value/financial-growth";
import { fundamentalResearchInput } from "~/lib/research/factors/fundamental-research";
import {
  fundamentalResearchJob,
  type FundamentalReport,
} from "../../strategies/value/fundamental-report";
import {
  financialQualityJob,
  financialQualityHistory,
  type FinancialQualityArchive,
} from "../../strategies/value/financial-quality";
import { valuationScenarioSchema } from "~/lib/research/factors/valuation-scenario";
import {
  saveValuationScenario,
  valuationScenarioHistory,
  type ValuationScenario,
} from "../../strategies/value/valuation-scenario";
import { researchHistory } from "../../research/research-history";
import { wyckoffJob } from "../../strategies/wyckoff/wyckoff-job";
import type { WyckoffReport } from "../../strategies/wyckoff/wyckoff-report";
import {
  analyzeChan,
  chanWindow,
  type ChanReport,
} from "../../strategies/chan/chan-report";
import { gatherCanslimDossier } from "../../strategies/canslim/canslim-dossier";
import {
  analyzeCanslimDossier,
  type CanslimResearchReport,
} from "../../strategies/canslim/canslim-report";
import { z } from "zod";
import { symbolSchema, type Snapshot, type Channel } from "~/lib/domain";
import { list } from "../../db";
import { background, updateJob } from "../../jobs/jobs";
import { researchModel } from "../../research/research";
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
export const strategyRouter = createTRPCRouter({
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
  channels: p.query(() => list<Channel>("channel")),
});
