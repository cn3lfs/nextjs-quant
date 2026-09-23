import { latestRpsObservation } from "../../screening/rps-observation";
import { marketPoolQuerySchema, poolCategorySchema } from "~/lib/market/market-pool";
import { marketPoolCatalog } from "../../market/market-pool-files";
import {
  marketPoolPage,
  marketPoolRows,
} from "../../market/market-pool-service";
import { universeAuditQuerySchema } from "~/lib/screening/universe-audit";
import { universeAuditPage } from "../../research/universe-audit";
import { RpsStore } from "../../screening/rps-store";
import { rpsClient } from "../../screening/rps-client";
import { rpsRequestSchema, rpsQuerySchema } from "~/lib/screening/rps";
import { rpsLogIdPrefix, toRpsLogEntry } from "~/lib/screening/rps-log";
import { industryPageSchema } from "~/lib/screening/industry-rps";
import { industryRpsPage } from "../../screening/industry-rps-query";
import { readRpsBlockSource } from "../../screening/rps-block-source";
import { sqlite as chartSqlite } from "../../db";
import { screenSortSchema } from "~/lib/screening/screen-sort";
import {
  screenReviews,
  screenReviewsInput,
} from "../../screening/screen-reviews";
import { screenTaskProgress } from "../../jobs/task-history";
import { historicalScreenSchema } from "~/lib/screening/historical-screen";
import {
  onlineScreenJob,
  type OnlineScreenResult,
} from "../../screening/online-screen";
import {
  pageScreenResults,
  exportScreenResults,
  type StoredScreenResult,
} from "../../screening/screen-results";
import { z } from "zod";
import { strategySchema, symbolSchema, periodSchema } from "~/lib/domain";
import { settings, saveSettings } from "../../infra/settings";
import { screenJob } from "../../screening/screen-job";
import { snapshot } from "../../market/snapshot";
import { readJob } from "../../jobs/jobs";
import { securityNameMap } from "../../market/securities";
import { formulaSchema, validateScreenFormula } from "~/lib/formula/formula-screen";
import {
  savedFormulas,
  saveFormula,
  formulaScreenJob,
  exportFormulaScreen,
} from "../../screening/formula-screen-service";
import { createTRPCRouter, publicProcedure as p } from "../trpc";
export const screeningRouter = createTRPCRouter({
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
  screenTaskProgress: p
    .input(z.object({ id: z.string().min(1).max(200) }))
    .query(({ input }) => screenTaskProgress(input.id)),
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
});
