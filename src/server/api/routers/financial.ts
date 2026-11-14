import { z } from "zod";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import {
  financialScreenInput,
  financialSymbol,
  financialIsoDate,
  localFinancialQuery,
  localSeriesQuery,
} from "~/lib/financial/local-financial";
import {
  localFinancialView,
  localFinancialSeriesView,
  localFinancialExport,
} from "../../financial/local-financial-service";
import {
  verifyLocalFinancialArchive,
  type LocalFinancialArchive,
} from "../../financial/local-financial-archive";
import {
  type LocalFinancialScreen,
  type LocalFinancialWork,
} from "../../financial/local-financial-work";
import type { auditLocalFinancialFiles } from "../../data-sources/tdx/local-financial-audit";
import { settings } from "../../infra/settings";
import { get, put, remove, sqlite } from "../../db";
import { background, runWorker } from "../../jobs/jobs";
import { isAStock, securityNames } from "tstdx/local";
import { readMarketPool } from "../../market/market-pool-files";
import {
  latestRpsObservation,
  observationRanking,
} from "../../screening/rps-observation";
import { RpsStore } from "../../screening/rps-store";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";

const archiveId = z.string().regex(/^local-financial-[a-f0-9]{64}$/);
const screenId = z.string().regex(/^local-financial-screen-[a-f0-9]{64}$/);
type Audit = Awaited<ReturnType<typeof auditLocalFinancialFiles>>;
function stored<T>(kind: string, id: string) {
  const row = sqlite()
    .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
    .get(kind, id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T) : null;
}
function history(kind: string) {
  return sqlite()
    .prepare(
      "SELECT id,json_extract(payload,'$.symbol') AS symbol,json_extract(payload,'$.createdAt') AS createdAt,json_extract(payload,'$.reports[0].reportDate') AS reportDate FROM records WHERE kind=? ORDER BY updated_at DESC LIMIT 100",
    )
    .all(kind) as {
    id: string;
    symbol: string | null;
    createdAt: number;
    reportDate: string | null;
  }[];
}
export const financialRouter = createTRPCRouter({
  localFinancialView: p("financial", "read")
    .input(localFinancialQuery)
    .query(({ input }) => localFinancialView(settings().tdxRoot, input)),
  localFinancialSeries: p("financial", "read")
    .input(localSeriesQuery)
    .query(({ input }) => localFinancialSeriesView(settings().tdxRoot, input)),
  localFinancialExport: p("financial", "read")
    .input(
      z.object({
        query: localFinancialQuery,
        expectedSha256: z.string().regex(/^[a-f0-9]{64}$/),
        expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .query(({ input }) =>
      localFinancialExport(
        settings().tdxRoot,
        input.query,
        input.expectedSha256,
        input.expectedManifestHash,
      ),
    ),
  localFinancialAudit: p("financial", "read").query(() => {
    const result = get<Audit>("local-financial-audit-latest");
    if (!result || resolve(result.root) !== resolve(settings().tdxRoot))
      return null;
    const { files, ...summary } = result;
    return {
      ...summary,
      failures: files.filter(
        (file) => !["valid", "placeholder"].includes(file.status),
      ),
    };
  }),
  localFinancialAuditStart: p("financial", "compute").mutation(() => {
    const work: LocalFinancialWork = {
      type: "local-financial",
      operation: "audit",
      root: settings().tdxRoot,
    };
    return background(
      "research",
      work,
      async (job, signal) => {
        const result = await runWorker<Audit>(work, job.id);
        signal.throwIfAborted();
        put("local-financial-audit", "local-financial-audit-latest", result);
        return { auditId: "local-financial-audit-latest" };
      },
      work,
    );
  }),
  localFinancialArchiveCreate: p("financial", "compute")
    .input(
      z.object({
        symbol: financialSymbol,
        reportDate: financialIsoDate.optional(),
      }),
    )
    .mutation(({ input }) => {
      if (!isAStock(input.symbol))
        throw new Error("财务质量档案仅支持A股公司；板块/市场请查看对应序列");
      const work: LocalFinancialWork = {
        type: "local-financial",
        operation: "archive",
        root: settings().tdxRoot,
        ...input,
      };
      return background(
        "research",
        work,
        async (job, signal) => {
          const archive = await runWorker<LocalFinancialArchive>(work, job.id);
          signal.throwIfAborted();
          verifyLocalFinancialArchive(archive);
          if (!get(archive.id))
            put("local-financial-archive", archive.id, archive);
          return { reportId: archive.id };
        },
        work,
      );
    }),
  localFinancialArchiveHistory: p("financial", "read").query(() =>
    history("local-financial-archive"),
  ),
  localFinancialArchive: p("financial", "read")
    .input(archiveId)
    .query(({ input }) => {
      const archive = stored<LocalFinancialArchive>(
        "local-financial-archive",
        input,
      );
      return archive ? verifyLocalFinancialArchive(archive) : null;
    }),
  localFinancialArchiveDelete: p("financial", "configure")
    .input(archiveId)
    .mutation(({ input }) => {
      if (stored("local-financial-archive", input)) remove(input);
      return { deleted: true };
    }),
  localFinancialScreenStart: p("financial", "compute")
    .input(financialScreenInput)
    .mutation(async ({ input }) => {
      const config = settings(),
        names = Object.fromEntries(
          (
            await Promise.all(
              ["sh", "sz"].map((market) =>
                securityNames(config.tdxRoot, market),
              ),
            )
          ).flatMap((map) => [...map]),
        );
      const pool = input.pool
        ? await readMarketPool(
            config.industryBlocksRoot,
            input.pool,
            config.tdxRoot,
            true,
          )
        : null;
      const symbols = [
        ...new Set(input.symbols ?? pool?.members ?? Object.keys(names)),
      ]
        .filter((symbol) => /^(sh|sz)/.test(symbol) && isAStock(symbol))
        .sort();
      if (!symbols.length)
        throw new Error("沪深证券池为空，请先配置本地数据或输入代码");
      const observation = input.rps
        ? latestRpsObservation(config.tdxRoot)
        : null;
      const rpsStore = input.rps ? new RpsStore(sqlite()) : null;
      const rpsDay = rpsStore?.day(input.asOf);
      const rps =
        input.rps && observation?.date === input.asOf
          ? {
              date: observation.date,
              hash: observation.day.inputHash,
              values: Object.fromEntries(
                observationRanking(observation, input.rps.period).map((row) => [
                  row.symbol,
                  row.rps,
                ]),
              ),
            }
          : input.rps &&
              rpsDay &&
              resolve(rpsDay.source.root) === resolve(config.tdxRoot)
            ? {
                date: rpsDay.date,
                hash: rpsDay.inputHash,
                values: Object.fromEntries(
                  rpsStore!
                    .ranking(input.asOf, input.rps.period)
                    .map((row) => [row.symbol, row.rps]),
                ),
              }
            : null;
      const work: LocalFinancialWork = {
        type: "local-financial",
        operation: "screen",
        root: config.tdxRoot,
        input,
        symbols,
        names,
        rps,
        poolSource: {
          hash:
            pool?.hash ??
            createHash("sha256").update(JSON.stringify(symbols)).digest("hex"),
          description: pool
            ? `${pool.category}：${pool.name}`
            : input.symbols
              ? "用户明确选择的沪深证券池"
              : "本地当前沪深主档，非历史成员池",
        },
      };
      return background(
        "screen",
        work,
        async (job, signal) => {
          const result = await runWorker<LocalFinancialScreen>(work, job.id);
          signal.throwIfAborted();
          if (!get(result.id)) put("local-financial-screen", result.id, result);
          return { reportId: result.id, counts: result.counts };
        },
        work,
      );
    }),
  localFinancialScreenHistory: p("financial", "read").query(() =>
    history("local-financial-screen"),
  ),
  localFinancialScreenPage: p("financial", "read")
    .input(
      z.object({
        id: screenId,
        pageIndex: z.number().int().min(0).default(0),
        pageSize: z.number().int().min(1).max(100).default(30),
        status: z
          .enum(["all", "matched", "rejected", "unknown"])
          .default("matched"),
        sort: z.enum(["symbol", "reportDate"]).default("symbol"),
        descending: z.boolean().default(false),
      }),
    )
    .query(({ input }) => {
      const result = stored<LocalFinancialScreen>(
        "local-financial-screen",
        input.id,
      );
      if (!result) return null;
      const rows = result.rows.filter(
        (row) =>
          input.status === "all" ||
          row.matched ===
            (input.status === "matched"
              ? true
              : input.status === "rejected"
                ? false
                : null),
      );
      rows.sort(
        (a, b) =>
          (input.descending ? -1 : 1) *
            (a[input.sort] ?? "").localeCompare(b[input.sort] ?? "") ||
          a.symbol.localeCompare(b.symbol),
      );
      return {
        id: result.id,
        hash: result.hash,
        input: result.input,
        poolSource: result.poolSource,
        counts: result.counts,
        warning: result.warning,
        issues: result.issues,
        rowCount: rows.length,
        rows: rows.slice(
          input.pageIndex * input.pageSize,
          (input.pageIndex + 1) * input.pageSize,
        ),
      };
    }),
  localFinancialScreenExport: p("financial", "read")
    .input(screenId)
    .query(({ input }) => {
      const result = stored<LocalFinancialScreen>(
        "local-financial-screen",
        input,
      );
      if (!result) return null;
      const { id, hash, createdAt: _createdAt, ...content } = result;
      if (
        createHash("sha256").update(JSON.stringify(content)).digest("hex") !==
          hash ||
        id !== `local-financial-screen-${hash}`
      )
        throw new Error("财务筛选档案哈希校验失败");
      return result;
    }),
  localFinancialScreenDelete: p("financial", "configure")
    .input(screenId)
    .mutation(({ input }) => {
      if (stored("local-financial-screen", input)) remove(input);
      return { deleted: true };
    }),
});
