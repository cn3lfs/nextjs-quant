import { readArchiveRecord } from "../../db/archive-records";
import { researchRangeSchema } from "~/lib/research/workflow/research-usage";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { researchUsage } from "../../research/research-usage";
import { researchAttemptsQuerySchema } from "~/lib/research/workflow/research-governance";
import { ResearchAttempts } from "../../db/research-governance";
import { sqlite as chartSqlite } from "../../db";
import { reportSecurityContext } from "../../db/report-security";
import {
  reportHistory,
  reportHistoryInput,
  archivedReport,
} from "../../db/report-history";
import { researchSkillCatalog } from "../../research/research-skills";
import { exportRsArchive } from "../../research/rs-export";
import { z } from "zod";
import { archiveHistoryInput } from "~/lib/research/workflow/archive-history";
import { researchArchiveHistory } from "../../db/archive-history";
import { strategySchema, type Report } from "~/lib/domain";
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
import {
  alphaExperimentSchema,
  alphaEvaluationInputSchema,
  type AlphaEvaluationResult,
} from "~/lib/research/alpha-experiment";
import {
  alphaBacktestInputSchema,
  type AlphaBacktestResult,
  type AlphaWork,
} from "../../research/alpha";
import { compileFactors } from "../../research/alpha/panel";
import {
  upsertFactorCompositeInputSchema,
  upsertFactorComposite,
  getFactorComposite,
  listFactorComposites,
  deleteFactorComposite,
  updateFactorCompositeSummary,
  type UpsertFactorCompositeInput,
} from "../../db/factor-composite-repository";
import { runIfJobRunning } from "../../db/jobs";
import {
  evaluateValuePitSnapshot,
  macroClockPreviewInput,
  pairSwitchPreviewInput,
  previewMacroClockAllocation,
  previewPairSwitchAllocation,
  valuePitPreviewInput,
} from "../../research/value-pit-service";
import { sentimentRegimeSnapshot } from "../../market/limit-sentiment-regime";

const compositeKey = z.object({ id: z.string().trim().min(1) }).strict();
function experimentFor(saved: UpsertFactorCompositeInput) {
  return alphaExperimentSchema.parse({
    ...saved.config.parameters,
    factors: saved.config.factors,
    weightingMethod: saved.weightingMethod,
    neutralizationMode: saved.neutralizationMode,
    winsorizeMethod: saved.winsorizeMethod,
  });
}

function storedSnapshot(id: string) {
  return (
    readArchiveRecord("snapshot", id) ?? readArchiveRecord("chart-snapshot", id)
  );
}
export const researchRouter = createTRPCRouter({
  macroClockPreview: p("research", "read")
    .input(macroClockPreviewInput)
    .query(({ input }) => previewMacroClockAllocation(input)),
  pairSwitchPreview: p("research", "read")
    .input(pairSwitchPreviewInput)
    .query(({ input }) => previewPairSwitchAllocation(input)),
  valuePitPreview: p("research", "read")
    .input(valuePitPreviewInput)
    .query(({ input }) => evaluateValuePitSnapshot(input)),
  sentimentRegimeSnapshot: p("research", "read")
    .input(
      z
        .object({ asOfDate: researchDateSchema.optional() })
        .strict()
        .default({}),
    )
    .query(({ input }) => sentimentRegimeSnapshot(input)),
  alphaComposites: p("research", "read")
    .input(
      z
        .object({
          limit: z.number().int().min(1).max(1000).default(50),
          after: z
            .object({
              updatedAt: z.number().int().safe().nonnegative(),
              id: z.string().min(1),
            })
            .strict()
            .optional(),
        })
        .strict()
        .default({}),
    )
    .query(({ input }) => listFactorComposites(input.limit, input.after)),
  alphaCompositeGet: p("research", "read")
    .input(compositeKey)
    .query(({ input }) => getFactorComposite(input.id)),
  alphaCompositeSave: p("research", "configure")
    .input(upsertFactorCompositeInputSchema)
    .mutation(({ input }) => {
      compileFactors(experimentFor(input));
      return upsertFactorComposite(input);
    }),
  alphaCompositeDelete: p("research", "configure")
    .input(compositeKey)
    .mutation(({ input }) => deleteFactorComposite(input.id)),
  alphaEvaluate: p("research", "compute")
    .input(
      z.union([
        z
          .object({
            compositeId: z.string().min(1),
            input: alphaEvaluationInputSchema,
          })
          .strict(),
        z
          .object({
            config: alphaExperimentSchema,
            input: alphaEvaluationInputSchema,
          })
          .strict(),
      ]),
    )
    .mutation(({ input }) => {
      const saved =
        "compositeId" in input ? getFactorComposite(input.compositeId) : null;
      const config =
        "config" in input ? input.config : saved ? experimentFor(saved) : null;
      if (!config) throw new Error("合成配置不存在");
      const work: AlphaWork = {
        type: "factor-eval",
        mode: "alpha-composite",
        payload: {
          config,
          input: input.input,
          root: settings().tdxRoot,
          now: Date.now(),
        },
      };
      const expectedConfigHash = saved?.configHash;
      return background(
        "factor-eval",
        {
          ...work,
          start: input.input.start,
          end: input.input.end,
          compositeId: saved?.id,
          expectedConfigHash,
        },
        async (job) => {
          const result = await runWorker<AlphaEvaluationResult>(work, job.id);
          let summaryUpdated = false;
          if (saved && expectedConfigHash)
            runIfJobRunning(job.id, () => {
              const h =
                result.decay.find((h) => h.horizon === config.icirHorizon) ??
                result.decay[0]!;
              summaryUpdated =
                updateFactorCompositeSummary(
                  saved.id,
                  {
                    rankIC: h.rankIC,
                    icir: h.icir,
                    details: {
                      horizon: h.horizon,
                      panelId: result.metadata.panelId,
                      start: input.input.start,
                      end: input.input.end,
                    },
                  },
                  expectedConfigHash,
                ) !== null;
            });
          return { ...result, summaryUpdated };
        },
      );
    }),
  alphaBacktest: p("research", "compute")
    .input(alphaBacktestInputSchema)
    .mutation(({ input }) => {
      const work: AlphaWork = {
        type: "factor-eval",
        mode: "alpha-backtest",
        payload: { ...input, root: settings().tdxRoot },
      };
      return background(
        "backtest",
        { ...work, start: input.snapshot.start, end: input.snapshot.end },
        (job) => runWorker<AlphaBacktestResult>(work, job.id),
      );
    }),
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
