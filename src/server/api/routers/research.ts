import { researchRangeSchema, researchDateSchema } from "~/lib/research/workflow/research-usage";
import { researchUsage } from "../../research/research-usage";
import { researchAttemptsQuerySchema } from "~/lib/research/workflow/research-governance";
import { ResearchAttempts } from "../../research/research-governance";
import {
  rollingPageSchema,
  researchRollingPage,
} from "../../research/performance/rolling-performance-service";
import {
  threeSegmentSample,
  threeSegmentAdmission,
} from "../../research/performance/three-segment-sample";
import { readMarketPool } from "../../market/market-pool-files";
import { admissionPageSchema } from "../../research/performance/strategy-admission-service";
import { requireA500Selection } from "../../research/a500-research";
import { researchSpecSchema } from "~/lib/research/strategy-research";
import { researchMarketEvidenceSchema } from "~/lib/research/factors/research-market-evidence";
import { ResearchStore } from "../../backtest/research-store";
import {
  periodPageSchema,
  researchPeriodPage,
} from "../../research/performance/period-performance-service";
import {
  launchResearch,
  cancelResearch,
  recoverResearch,
} from "../../backtest/research-client";
import { sqlite as chartSqlite } from "../../db";
import { reportSecurityContext } from "../../research/report-security";
import {
  reportHistory,
  reportHistoryInput,
  archivedReport,
} from "../../research/report-history";
import {
  walkForwardJob,
  walkForwardInput,
} from "../../backtest/walk-forward-job";
import { walkForwardPage, type WalkForwardResult } from "~/lib/backtest/walk-forward";
import { explainWalkForwardJob } from "../../backtest/walk-forward-explanation";
import { researchSkillCatalog } from "../../research/research-skills";
import { exportRsArchive } from "../../research/rs-export";
import { z } from "zod";
import { strategySchema, type Snapshot, type Report } from "~/lib/domain";
import { list } from "../../db";
import { settings, saveSettings } from "../../infra/settings";
import { background } from "../../jobs/jobs";
import { analyze, interpret } from "../../research/research";
import { gatherEvidence } from "../../research/gather-evidence";
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
export const researchRouter = createTRPCRouter({
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
  savedSnapshot: p.input(z.string().min(1)).query(({ input }) => {
    const source = storedSnapshot(input);
    if (!source?.bars || !source.symbol)
      throw new Error("候选原始快照不存在，请重新运行选股");
    return source;
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
  researchSkills: p.query(() => researchSkillCatalog()),
  rsSourceExport: p
    .input(z.object({ reportId: z.string(), evidenceId: z.string() }))
    .query(({ input }) => exportRsArchive(input.reportId, input.evidenceId)),
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
});
