import {
  cashWorkspacePageSchema,
  cashEvidencePageSchema,
  cashDateSchema,
  cashWorkspacePage,
  cashWorkspaceDate,
  cashWorkspaceRows,
  cashWorkspaceOpening,
  cashWorkspaceDiagnostics,
} from "~/lib/portfolio/cash-workspace";
import { assertCashReviewVersion } from "../../db/cash-reconciliation-workspace";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { importOptionsSchema } from "~/lib/research/evidence/delivery-import";
import {
  cashReconciliationPage,
  cashReconciliationPageSchema,
} from "~/lib/portfolio/cash-reconciliation";
import {
  previewDeliveryImport,
  commitDeliveryImport,
} from "../../portfolio/delivery-import-service";
import { DeliveryStore } from "../../db/delivery-store";
import {
  deliveryFilePage,
  deliveryFilePageSchema,
} from "../../portfolio/delivery-file-page";
import {
  deliveryPreviewWorkspace,
  deliveryPreviewInputSchema,
  deliveryPreviewPageSchema,
  deliveryPreviewTokenSchema,
} from "../../portfolio/delivery-preview-workspace";
import {
  deliveryBatchPageSchema,
  deliveryBatchPage,
  deliveryBatchReceipt,
  deliveryBatchIdSchema,
  deliveryEvidencePageSchema,
  deliveryRevokeCheckedSchema,
  deliveryBatchDetail,
  deliveryEvidencePage,
  deliveryBatchExport,
  deliveryRevokeChecked,
} from "../../db/delivery-workspace-query";
import { sqlite as chartSqlite } from "../../db";
import { z } from "zod";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";

import { accountReview } from "./portfolio-review-source";

const deliveryPathSchema = z.string().trim().min(1).max(2048);
const deliveryInputSchema = importOptionsSchema.extend({
  path: deliveryPathSchema,
  account: z.string().trim().min(1).max(64),
});
async function deliveryBytes(path: string) {
  if (![".xls", ".txt", ".csv"].includes(extname(path).toLowerCase()))
    throw new Error("仅支持 .xls / .txt / .csv 交割单文件");
  return readFile(path);
}
const cashAccountSchema = z.object({
  account: z.string().trim().min(1).max(64),
});
const cashVersionSchema = cashAccountSchema.extend({
  version: z.string().regex(/^[a-f0-9]{64}$/),
});
async function cashReviewAt(input: z.infer<typeof cashVersionSchema>) {
  const result = await accountReview(input.account);
  assertCashReviewVersion(result.cashVersion, input.version);
  return result.snapshot.cashReconciliation;
}

export const portfolioLedgerRouter = createTRPCRouter({
  cashWorkspace: p("portfolio", "read")
    .input(cashWorkspacePageSchema.and(cashAccountSchema))
    .query(async ({ input }) => {
      const result = await accountReview(input.account);
      return {
        account: input.account,
        version: result.cashVersion,
        ...cashWorkspacePage(result.snapshot.cashReconciliation, input),
      };
    }),
  cashWorkspaceDate: p("portfolio", "read")
    .input(
      cashVersionSchema
        .extend({ date: cashDateSchema })
        .merge(cashEvidencePageSchema),
    )
    .query(async ({ input }) => ({
      account: input.account,
      version: input.version,
      ...cashWorkspaceDate(await cashReviewAt(input), input.date, input),
    })),
  cashWorkspaceRows: p("portfolio", "read")
    .input(
      cashVersionSchema
        .extend({ date: cashDateSchema, batchId: z.string().min(1).max(200) })
        .merge(cashEvidencePageSchema),
    )
    .query(async ({ input }) => ({
      account: input.account,
      version: input.version,
      ...cashWorkspaceRows(
        await cashReviewAt(input),
        input.date,
        input.batchId,
        input,
      ),
    })),
  cashWorkspaceOpening: p("portfolio", "read")
    .input(cashVersionSchema.merge(cashEvidencePageSchema))
    .query(async ({ input }) => ({
      account: input.account,
      version: input.version,
      ...cashWorkspaceOpening(await cashReviewAt(input), input),
    })),
  cashWorkspaceDiagnostics: p("portfolio", "read")
    .input(cashVersionSchema.merge(cashEvidencePageSchema))
    .query(async ({ input }) => ({
      account: input.account,
      version: input.version,
      ...cashWorkspaceDiagnostics(await cashReviewAt(input), input),
    })),
  cashWorkspaceExport: p("portfolio", "read")
    .input(cashVersionSchema)
    .query(async ({ input }) => {
      const evidence = await cashReviewAt(input);
      return {
        account: input.account,
        snapshotVersion: input.version,
        generatedAt: new Date().toISOString(),
        evidenceHash: createHash("sha256")
          .update(JSON.stringify(evidence))
          .digest("hex"),
        evidence,
      };
    }),
  deliveryFiles: p("portfolio", "read")
    .input(deliveryPathSchema)
    .query(async ({ input }) => {
      const directory = resolve(input);
      const entries = await readdir(directory, { withFileTypes: true });
      return Promise.all(
        entries
          .filter(
            (entry) =>
              entry.isFile() &&
              [".xls", ".txt", ".csv"].includes(
                extname(entry.name).toLowerCase(),
              ),
          )
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(async (entry) => {
            const path = resolve(directory, entry.name);
            const info = await stat(path);
            return {
              name: entry.name,
              path,
              size: info.size,
              modifiedAt: info.mtimeMs,
            };
          }),
      );
    }),
  deliveryPreview: p("portfolio", "read")
    .input(deliveryInputSchema)
    .query(async ({ input }) =>
      previewDeliveryImport(
        await deliveryBytes(input.path),
        { ...input, fileName: basename(input.path) },
        chartSqlite(),
      ),
    ),
  deliveryImport: p("portfolio", "configure")
    .input(
      deliveryInputSchema.extend({ hash: z.string().regex(/^[a-f0-9]{64}$/) }),
    )
    .mutation(async ({ input }) => {
      const bytes = await deliveryBytes(input.path);
      if (createHash("sha256").update(bytes).digest("hex") !== input.hash)
        throw new Error("文件已改变，请重新预览后确认导入");
      return commitDeliveryImport(
        bytes,
        { ...input, fileName: basename(input.path) },
        chartSqlite(),
      );
    }),
  deliveryFilePage: p("portfolio", "read")
    .input(deliveryFilePageSchema)
    .query(({ input }) => deliveryFilePage(input)),
  deliveryPreviewStart: p("portfolio", "compute")
    .input(deliveryPreviewInputSchema)
    .mutation(({ input }) =>
      deliveryPreviewWorkspace.start(chartSqlite(), input),
    ),
  deliveryPreviewPage: p("portfolio", "read")
    .input(deliveryPreviewPageSchema)
    .query(({ input }) => deliveryPreviewWorkspace.page(chartSqlite(), input)),
  deliveryPreviewExport: p("portfolio", "read")
    .input(deliveryPreviewTokenSchema)
    .query(({ input }) =>
      deliveryPreviewWorkspace.export(chartSqlite(), input),
    ),
  deliveryPreviewConfirm: p("portfolio", "configure")
    .input(deliveryPreviewTokenSchema)
    .mutation(({ input }) =>
      deliveryPreviewWorkspace.confirm(chartSqlite(), input),
    ),
  deliveryBatchPage: p("portfolio", "read")
    .input(deliveryBatchPageSchema)
    .query(({ input }) => deliveryBatchPage(chartSqlite(), input)),
  deliveryReceipt: p("portfolio", "read")
    .input(
      z.object({
        account: z.string().trim().min(1).max(64),
        fileHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .query(({ input }) =>
      deliveryBatchReceipt(chartSqlite(), input.account, input.fileHash),
    ),
  deliveryBatchDetail: p("portfolio", "read")
    .input(deliveryBatchIdSchema)
    .query(({ input }) => deliveryBatchDetail(chartSqlite(), input)),
  deliveryEvidencePage: p("portfolio", "read")
    .input(deliveryEvidencePageSchema)
    .query(({ input }) => deliveryEvidencePage(chartSqlite(), input)),
  deliveryBatchExport: p("portfolio", "read")
    .input(deliveryBatchIdSchema)
    .query(({ input }) => deliveryBatchExport(chartSqlite(), input)),
  deliveryRevokeChecked: p("portfolio", "configure")
    .input(deliveryRevokeCheckedSchema)
    .mutation(({ input }) => deliveryRevokeChecked(chartSqlite(), input)),
  deliveryBatches: p("portfolio", "read").query(() =>
    new DeliveryStore(chartSqlite())
      .batches(false)
      .map(({ payload, ...batch }) => ({
        ...batch,
        statistics: payload.statistics,
        ...(payload.scope ? { scope: payload.scope } : {}),
        ...(payload.statementOpeningCash !== undefined
          ? { statementOpeningCash: payload.statementOpeningCash }
          : {}),
        ...(payload.counts ? { counts: payload.counts } : {}),
      })),
  ),
  deliveryRevoke: p("portfolio", "configure")
    .input(z.string().min(1).max(128))
    .mutation(({ input }) =>
      new DeliveryStore(chartSqlite()).revokeBatch(input),
    ),
  tradeReviewCashReconciliation: p("portfolio", "read")
    .input(
      cashReconciliationPageSchema.extend({
        account: z.string().trim().min(1),
      }),
    )
    .query(async ({ input }) =>
      cashReconciliationPage(
        (await accountReview(input.account)).snapshot.cashReconciliation,
        input,
      ),
    ),
  tradeReviewCashReconciliationExport: p("portfolio", "read")
    .input(z.object({ account: z.string().trim().min(1) }))
    .query(
      async ({ input }) =>
        (await accountReview(input.account)).snapshot.cashReconciliation,
    ),
});
