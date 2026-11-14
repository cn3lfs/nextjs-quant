import { researchRangeSchema } from "~/lib/research/workflow/research-usage";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { researchUsage } from "../../research/research-usage";
import { researchAttemptsQuerySchema } from "~/lib/research/workflow/research-governance";
import { ResearchAttempts } from "../../research/research-governance";
import { sqlite as chartSqlite } from "../../db";
import { reportSecurityContext } from "../../research/report-security";
import {
  reportHistory,
  reportHistoryInput,
  archivedReport,
} from "../../research/report-history";
import { researchSkillCatalog } from "../../research/research-skills";
import { exportRsArchive } from "../../research/rs-export";
import { z } from "zod";
import { archiveHistoryInput } from "~/lib/research/workflow/archive-history";
import { researchArchiveHistory } from "../../research/archive-history";
import { strategySchema, type Snapshot, type Report } from "~/lib/domain";
import { list } from "../../db";
import { settings, saveSettings } from "../../infra/settings";
import { background, runWorker } from "../../jobs/jobs";
import {
  factorEvaluationSchema,
  type evaluateFactorWork,
} from "../../research/factor-evaluation-job";
import { analyze } from "../../research/research";
import { gatherEvidence } from "../../research/gather-evidence";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
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
  savedSnapshot: p("research", "read")
    .input(z.string().min(1))
    .query(({ input }) => {
      const source = storedSnapshot(input);
      if (!source?.bars || !source.symbol)
        throw new Error("候选原始快照不存在，请重新运行选股");
      return source;
    }),
  researchUsage: p("research", "read")
    .input(researchRangeSchema)
    .query(({ input }) => researchUsage(input)),
  researchAttempts: p("research", "read")
    .input(researchAttemptsQuerySchema)
    .query(({ input }) => new ResearchAttempts(chartSqlite()).page(input)),
  holdoutSettings: p("research", "read").query(() => ({
    holdoutStart: settings().holdoutStart,
  })),
  saveHoldoutStart: p("research", "configure")
    .input(researchDateSchema.nullable())
    .mutation(({ input }) => {
      saveSettings({ ...settings(), holdoutStart: input });
      return { holdoutStart: input };
    }),
  // Cross-sectional factor evaluation over local A-shares (worker job).
  factorEvaluate: p("research", "compute")
    .input(factorEvaluationSchema)
    .mutation(({ input }) => {
      const work = {
        ...input,
        type: "factor-eval" as const,
        root: settings().tdxRoot,
        now: Date.now(),
      };
      return background("factor-eval", work, (job) =>
        runWorker<Awaited<ReturnType<typeof evaluateFactorWork>>>(work, job.id),
      );
    }),
  analyze: p("research", "compute")
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
  researchSkills: p("research", "read").query(() => researchSkillCatalog()),
  rsSourceExport: p("research", "read")
    .input(z.object({ reportId: z.string(), evidenceId: z.string() }))
    .query(({ input }) => exportRsArchive(input.reportId, input.evidenceId)),
  reports: p("research", "read").query(() =>
    list<Report>("report", 100).map((report) => ({
      ...report,
      securityContext: reportSecurityContext(report.contextId),
    })),
  ),
  researchArchiveHistory: p("research", "read")
    .input(archiveHistoryInput)
    .query(({ input }) => researchArchiveHistory(input)),
  reportHistory: p("research", "read")
    .input(reportHistoryInput)
    .query(({ input }) => reportHistory(input)),
  archivedReport: p("research", "read")
    .input(z.string().min(1).max(200))
    .query(({ input }) => archivedReport(input)),
});
