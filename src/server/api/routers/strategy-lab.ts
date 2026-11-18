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
  actOnLabStrategy,
} from "../../db/strategy-lab";
import { labValidationReport } from "../../research/lab-report";
import { researchCommandSchema } from "~/lib/research/research-command";
import { background, runWorker } from "../../jobs/jobs";
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
      background("backtest", { type: "lab-backtest", ...input }, (job) =>
        runWorker({ type: "lab-backtest", input }, job.id),
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
