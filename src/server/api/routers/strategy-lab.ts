import { z } from "zod";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
import {
  labIdentitySchema,
  labQuerySchema,
  labActionSchema,
} from "~/lib/research/strategy-lab";
import {
  strategyLabPage,
  strategyLabDetail,
  strategyLabCompareRuns,
  actOnLabStrategy,
} from "../../db/strategy-lab";
import { labValidationReport } from "../../research/lab-report";
import { researchCommandSchema } from "~/lib/research/research-command";
import { background, runWorker, updateJob } from "../../jobs/jobs";
import { prepareLabBacktest } from "../../research/lab-backtest";
import { readJobResultSnapshot } from "../../db/job-results";
import { readJob } from "../../db/jobs";
import { atomic } from "../../db";
import {
  diagnoseArchiveDetailInputSchema,
  diagnoseArchivesInputSchema,
  diagnoseCompareInputSchema,
  diagnoseResultInputSchema,
  labDiagnoseRunInputSchema,
} from "~/lib/research/diagnose-contract";
import {
  listDiagnoseArchives,
  createDiagnoseStagingDir,
  cleanupDiagnoseStagingDir,
  publishStagedDiagnoseArchive,
  readDiagnoseArchive,
  resolveDiagnoseArchiveKey,
  removeUnpublishedDiagnoseArchive,
} from "../../research/diagnose/archive";
import type { LabDiagnoseWorkerResult } from "../../research/diagnose/grouped-run";
import { labBacktestSchema } from "~/lib/research/lab-backtest";
import {
  labPortfolioEvidenceHashSchema,
  labPortfolioEvidenceImportSchema,
} from "~/lib/research/lab-portfolio-evidence";
import {
  importLabPortfolioEvidence,
  labPortfolioEvidenceDetail,
  listLabPortfolioEvidence,
} from "../../research/lab-portfolio-evidence";
import { settings, saveSettings } from "../../infra/settings";
import { AlertRepository } from "../../db/alert-repository";
import { strategyObjectSchema } from "trading-strategies";
import { freezeMatchingAccountExpectation } from "../../portfolio/account-expectation-service";
import {
  paperShadowScanning,
  enablePaperShadowScanning,
  enablePaperShadowSchema,
} from "../../paper/shadow-scanning";

export const strategyLabRouter = createTRPCRouter({
  strategyLabDiagnoseArchives: p("backtest", "read")
    .input(diagnoseArchivesInputSchema)
    .query(({ input }) => listDiagnoseArchives(input)),
  strategyLabDiagnoseArchiveDetail: p("backtest", "read")
    .input(diagnoseArchiveDetailInputSchema)
    .query(({ input: { id, ...page } }) => readDiagnoseArchive(id, page)),
  strategyLabDiagnoseCompare: p("backtest", "read")
    .input(diagnoseCompareInputSchema)
    .query(async ({ input }) => {
      const unreadable = (side: string) =>
        new Error(`${side}诊断归档不可读取，请选择已完成且可访问的归档`);
      const keyFor = (id: string, side: string) =>
        resolveDiagnoseArchiveKey(id).catch(() => {
          throw unreadable(side);
        });
      const [leftKey, rightKey] = await Promise.all([
        keyFor(input.leftId, "左侧"),
        keyFor(input.rightId, "右侧"),
      ]);
      if (leftKey === rightKey)
        throw new Error("不能将同一份诊断归档与自身对比");
      const readSide = async (id: string, side: string) => {
        const detail = await readDiagnoseArchive(id, { allCells: true }).catch(
          () => null,
        );
        if (!detail) throw unreadable(side);
        if (
          detail.boundaryState === "missing-files" ||
          detail.summary.missingFiles.length
        )
          throw new Error(`${side}诊断归档缺少完整产物，无法对比`);
        return detail;
      };
      const [left, right] = await Promise.all([
        readSide(input.leftId, "左侧"),
        readSide(input.rightId, "右侧"),
      ]);
      return { left, right };
    }),
  strategyLabDiagnoseRun: p("backtest", "compute")
    .input(labDiagnoseRunInputSchema)
    .mutation(({ input }) =>
      background(
        "backtest",
        { type: "lab-diagnose", ...input },
        async (job, signal) => {
          const stagingDir = await createDiagnoseStagingDir();
          let published = false;
          const archiveId = `lab-${job.id}`;
          try {
            const receipt = await runWorker<LabDiagnoseWorkerResult>(
              {
                type: "lab-diagnose",
                input,
                config: settings(),
                stagingDir,
                jobId: job.id,
              },
              job.id,
            );
            if (receipt.archiveId !== archiveId)
              throw new Error("诊断归档与任务 ID 不一致");
            atomic(() => {
              const current = readJob(job.id);
              if (signal.aborted || current?.status !== "running")
                throw new Error("诊断任务已取消或不再运行");
              const completed = updateJob(job.id, {
                status: "completed",
                progress: 100,
                phase: "完成",
                result: receipt,
              });
              if (
                completed?.status !== "completed" ||
                !completed.result ||
                typeof completed.result !== "object" ||
                !("archiveId" in completed.result) ||
                completed.result.archiveId !== receipt.archiveId
              )
                throw new Error("诊断任务完成状态未保存");
              publishStagedDiagnoseArchive(stagingDir, receipt.archiveId);
              published = true;
            });
            return receipt;
          } catch (error) {
            // Includes SQLite commit failures after the filesystem rename.
            if (published) await removeUnpublishedDiagnoseArchive(archiveId);
            throw error;
          } finally {
            await cleanupDiagnoseStagingDir(stagingDir);
          }
        },
      ),
    ),
  strategyLabDiagnoseResult: p("backtest", "read")
    .input(diagnoseResultInputSchema)
    .query(async ({ input }) => {
      const result = readJobResultSnapshot(input.jobId, ({ job, json }) => {
        if (job.type !== "backtest" || json("$.input.type") !== "lab-diagnose")
          return null;
        return {
          jobId: job.id,
          status: job.status,
          progress: json<number>("$.progress"),
          phase: json<string | null>("$.phase"),
          error: json<string | null>("$.error"),
          archiveId:
            job.status === "completed"
              ? z.string().parse(json("$.result.archiveId"))
              : null,
        };
      });
      if (!result) throw new Error("诊断任务不存在");
      const { archiveId, ...job } = result;
      return {
        ...job,
        detail: archiveId ? await readDiagnoseArchive(archiveId) : null,
      };
    }),
  paperShadowScanning: p("strategyCenter", "read").query(() =>
    paperShadowScanning(),
  ),
  enablePaperShadowScanning: p("alerts", "configure")
    .input(enablePaperShadowSchema)
    .mutation(({ input }) => enablePaperShadowScanning(input)),
  strategyLabRegister: p("alerts", "configure")
    .input(strategyObjectSchema)
    .mutation(({ input }) => {
      const repo = new AlertRepository();
      // Definition registration never changes observation, promotion or mode.
      const strategy = repo.strategies.saveStrategy(input);
      freezeMatchingAccountExpectation(strategy.id, strategy.version);
      return strategy;
    }),
  strategyLabBacktest: p("backtest", "compute")
    .input(labBacktestSchema)
    .mutation(({ input }) =>
      background(
        "backtest",
        { type: "lab-backtest", ...input },
        async (job, signal) => {
          const work = { type: "lab-backtest" as const, input };
          if (input.source !== "thsdk") return runWorker(work, job.id);
          const frozen = await prepareLabBacktest(
            work,
            (progress, phase) => {
              signal.throwIfAborted();
              if (
                updateJob(job.id, { progress, phase })?.status === "cancelled"
              )
                throw new Error("任务已取消");
            },
            undefined,
            signal,
          );
          return runWorker({ type: "lab-backtest-replay", frozen }, job.id);
        },
      ),
    ),
  strategyLabMode: p("alerts", "configure")
    .input(
      z
        .object({
          mode: z.enum(["off", "shadow", "live"]),
          confirmed: z.literal(true),
        })
        .strict(),
    )
    .mutation(({ input }) => {
      const repo = new AlertRepository();
      return repo.atomic(() => {
        if (
          input.mode === "live" &&
          !repo.liveStrategies().some((s) => {
            const d = strategyLabDetail(s.id, s.version, repo);
            return d.promotion && d.eligible;
          })
        )
          throw new Error("先核对门槛并手动晋级、开启至少一个策略的live提醒");
        saveSettings({
          ...settings(),
          alerts: { ...settings().alerts, mode: input.mode },
        });
        return { mode: input.mode };
      });
    }),
  strategyLab: p("strategyCenter", "read")
    .input(labQuerySchema)
    .query(({ input }) => strategyLabPage(input)),
  strategyLabCompareRuns: p("backtest", "read")
    .input(
      z.object({
        ids: z
          .array(z.string().min(1).max(200))
          .min(2)
          .max(12)
          .refine((ids) => new Set(ids).size === ids.length, "任务 ID 重复"),
      }),
    )
    .query(({ input }) => strategyLabCompareRuns(input.ids)),
  strategyLabDetail: p("strategyCenter", "read")
    .input(labIdentitySchema)
    .query(({ input }) => strategyLabDetail(input.id, input.version)),
  strategyLabAction: p("alerts", "configure")
    .input(labActionSchema)
    .mutation(({ input }) => actOnLabStrategy(input)),
  strategyLabReport: p("strategyCenter", "read")
    .input(
      z
        .object({
          hash: z.string().regex(/^[a-f0-9]{64}$/),
          id: z.string().min(1).max(150),
        })
        .strict(),
    )
    .query(({ input }) => labValidationReport(input.hash, input.id)),
  strategyLabPortfolioEvidenceImport: p("research", "compute")
    .input(labPortfolioEvidenceImportSchema)
    .mutation(({ input }) => importLabPortfolioEvidence(input)),
  strategyLabPortfolioEvidenceList: p("strategyCenter", "read").query(() =>
    listLabPortfolioEvidence(),
  ),
  strategyLabPortfolioEvidenceDetail: p("strategyCenter", "read")
    .input(labPortfolioEvidenceHashSchema)
    .query(({ input }) => labPortfolioEvidenceDetail(input.hash)),
  researchCommand: p("research", "compute")
    .input(researchCommandSchema)
    .mutation(({ input }) =>
      background("research", { type: "research-command", ...input }, (job) =>
        runWorker({ type: "research-command", input }, job.id),
      ),
    ),
});
