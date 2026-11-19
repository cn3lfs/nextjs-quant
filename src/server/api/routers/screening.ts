import { readJob } from "../../db/jobs";
import { latestRpsObservation } from "../../db/rps-observations";
import {
  marketPoolQuerySchema,
  poolCategorySchema,
} from "~/lib/market/market-pool";
import { marketPoolCatalog } from "../../market/market-pool-files";
import {
  marketPoolAssociations,
  marketPoolAssociationsInput,
} from "../../market/market-pool-associations";
import {
  marketPoolPage,
  marketPoolRows,
} from "../../market/market-pool-service";
import { universeAuditQuerySchema } from "~/lib/screening/universe-audit";
import { universeAuditPage } from "../../research/universe-audit";
import { RpsStore } from "../../db/rps-store";
import { rpsClient } from "../../screening/rps-client";
import { rpsRequestSchema, rpsQuerySchema } from "~/lib/screening/rps";
import { rpsWorkflowHistory } from "../../db/workflow-history";
import { industryPageSchema } from "~/lib/screening/industry-rps";
import { industryRpsPage } from "../../screening/industry-rps-query";
import { readRpsBlockSource } from "../../screening/rps-block-source";
import { sqlite as chartSqlite } from "../../db";
import { screenSortSchema } from "~/lib/screening/screen-sort";
import { screenTaskProgress } from "../../db/task-history";
import {
  onlineScreenJob,
  type OnlineScreenResult,
} from "../../screening/online-screen";
import { readScreenResultPage } from "../../db/screen-result-pages";
import { z } from "zod";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import { settings, saveSettings } from "../../infra/settings";

import { securityNameMap } from "../../market/securities";
import {
  formulaSchema,
  validateScreenFormula,
} from "trading-strategies/formula/formula-screen";
import {
  savedFormulas,
  saveFormula,
  formulaScreenJob,
  exportStoredFormulaScreen,
} from "../../screening/formula-screen-service";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
import { formulaFromText } from "../../screening/formula-from-text";
import { formulaScreenInputSchema } from "~/lib/screening/formula-screen-request";
import {
  thsdkHotBlockKindSchema,
  thsdkWencaiQueryInputSchema,
} from "~/lib/market/thsdk-extensions";
import {
  thsdkWencaiQuery,
  thsdkWencaiHotBlocks,
} from "../../data-sources/thsdk/thsdk-wencai";

export const screeningRouter = createTRPCRouter({
  thsdkWencaiQuery: p("market", "read")
    .input(thsdkWencaiQueryInputSchema)
    .query(({ input, signal }) => thsdkWencaiQuery(input, signal)),
  thsdkWencaiHotBlocks: p("market", "read")
    .input(z.object({ kind: thsdkHotBlockKindSchema.default("concept") }))
    .query(({ input, signal }) => thsdkWencaiHotBlocks(input.kind, signal)),
  conceptRpsStatus: p("rps", "read").query(() => {
    const store = new RpsStore(chartSqlite(), "concept");
    const latest = store.latest();
    return {
      root: settings().industryBlocksRoot,
      membershipSource: settings().industryMembershipSource,
      tdxConfigured: !!settings().tdxRoot,
      ready:
        !!settings().tdxRoot &&
        (settings().industryMembershipSource === "tdx" ||
          !!settings().industryBlocksRoot),
      progress: store.progress(),
      latest: latest
        ? {
            date: latest.date,
            mode: latest.mode,
            total: latest.total,
            counts: latest.counts,
            periods: latest.periods,
            hash: latest.industry!.snapshot.hash,
          }
        : null,
    };
  }),
  conceptRpsPage: p("rps", "read")
    .input(industryPageSchema)
    .query(({ input }) =>
      industryRpsPage(
        new RpsStore(chartSqlite(), "concept"),
        input,
        latestRpsObservation(settings().tdxRoot),
      ),
    ),
  marketPoolCatalog: p("market", "read")
    .input(poolCategorySchema)
    .query(({ input }) =>
      marketPoolCatalog(
        settings().industryBlocksRoot,
        input,
        settings().tdxRoot,
      ),
    ),
  marketPoolAssociations: p("market", "read")
    .input(marketPoolAssociationsInput)
    .query(({ input }) => marketPoolAssociations(input, settings().tdxRoot)),
  marketPoolPage: p("market", "read")
    .input(marketPoolQuerySchema)
    .query(({ input }) => marketPoolPage(input)),
  universeAuditPage: p("market", "read")
    .input(universeAuditQuerySchema)
    .query(({ input }) => universeAuditPage(input)),
  marketPoolExport: p("market", "read")
    .input(marketPoolQuerySchema)
    .mutation(({ input }) => marketPoolRows(input)),
  industryRpsStatus: p("rps", "read").query(() => {
    const store = new RpsStore(chartSqlite(), "industry");
    const latest = store.latest();
    // Full membership evidence stays on disk; status polling returns only summary counts.
    return {
      root: settings().industryBlocksRoot,
      membershipSource: settings().industryMembershipSource,
      tdxConfigured: !!settings().tdxRoot,
      ready:
        !!settings().tdxRoot &&
        (settings().industryMembershipSource === "tdx" ||
          !!settings().industryBlocksRoot),
      progress: store.progress(),
      latest: latest
        ? {
            date: latest.date,
            mode: latest.mode,
            counts: latest.counts,
            periods: latest.periods,
            total: latest.total,
            excluded: latest.industry!.excluded,
          }
        : null,
    };
  }),
  industryRpsSourceConfigure: p("rps", "configure")
    .input(z.enum(["blocks", "tdx"]))
    .mutation(({ input }) => {
      saveSettings({ ...settings(), industryMembershipSource: input });
      return { source: input };
    }),
  industryRpsConfigure: p("rps", "configure")
    .input(z.string().trim().max(2048))
    .mutation(({ input }) => {
      saveSettings({ ...settings(), industryBlocksRoot: input });
      return { root: input };
    }),
  industryRpsInspect: p("rps", "read").mutation(async () => {
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
  industryRpsPage: p("rps", "read")
    .input(industryPageSchema)
    .query(({ input }) =>
      industryRpsPage(
        new RpsStore(chartSqlite(), "industry"),
        input,
        latestRpsObservation(settings().tdxRoot),
      ),
    ),
  rpsWorkflowLog: p("rps", "read").query(() => rpsWorkflowHistory()),
  rpsStatus: p("rps", "read").query(() => {
    const store = new RpsStore(chartSqlite());
    return { progress: store.progress(), latest: store.latest() };
  }),
  rpsStart: p("rps", "compute")
    .input(rpsRequestSchema)
    .mutation(({ input }) => ({ id: rpsClient().start(input).id })),
  rpsCancel: p("rps", "configure").mutation(() => {
    rpsClient().cancel();
    return { cancelled: true };
  }),
  rpsRanking: p("rps", "read")
    .input(rpsQuerySchema)
    .query(({ input }) => {
      const store = new RpsStore(chartSqlite());
      return {
        day: store.day(input.date),
        rows: store.ranking(input.date, input.period),
      };
    }),
  rpsCurve: p("rps", "read")
    .input(symbolSchema)
    .query(({ input }) => new RpsStore(chartSqlite()).curve(input)),
  formulas: p("formulaScreen", "read").query(() => savedFormulas()),
  saveFormula: p("formulaScreen", "configure")
    .input(formulaSchema)
    .mutation(({ input }) => saveFormula(input)),
  checkFormula: p("formulaScreen", "compute")
    .input(formulaSchema)
    .mutation(({ input }) => {
      validateScreenFormula(input);
      return { ok: true };
    }),
  // Drafts a formula from a sentence; the draft is checked, never launched here.
  formulaFromText: p("formulaScreen", "compute")
    .input(z.string().trim().min(2).max(500))
    .mutation(({ input, signal }) => formulaFromText(input, signal)),
  formulaScreen: p("formulaScreen", "compute")
    .input(formulaScreenInputSchema)
    .mutation(({ input }) => formulaScreenJob(input)),
  onlineScreen: p("onlineScreen", "compute")
    .input(
      z.object({
        query: z.string().trim().min(2).max(2000),
        page: z.number().int().min(1).max(10000).default(1),
      }),
    )
    .mutation(({ input }) => onlineScreenJob(input.query, input.page)),
  onlineScreenResult: p("onlineScreen", "read")
    .input(z.object({ id: z.string(), version: z.number().optional() }))
    .query(({ input }) => {
      const job = readJob(input.id);
      return job?.type === "online-screen" && job.status === "completed"
        ? (job.result as OnlineScreenResult)
        : null;
    }),
  screenTaskProgress: p("tasks", "read")
    .input(z.object({ id: z.string().min(1).max(200) }))
    .query(({ input }) => screenTaskProgress(input.id)),
  screenResults: p("formulaScreen", "read")
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
    .query(async ({ input }) =>
      readScreenResultPage(
        input.id,
        input,
        input.query.trim() ? await securityNameMap() : {},
      ),
    ),
  screenExport: p("formulaScreen", "read")
    .input(z.string())
    .query(({ input }) => exportStoredFormulaScreen(input)),
});
