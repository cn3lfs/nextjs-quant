import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import SuperJSON from "superjson";
import { z } from "zod";
import type { Page } from "@playwright/test";
import { trpcHeaders } from "./helpers";
import type { RouterOutputs } from "../../src/trpc/react";

// Only reviewed local reads reach the isolated application. Unknown calls fail
// explicitly so a new page cannot silently introduce external traffic.
const localReads = new Set([
  "status",
  "securityNames",
  "jobs",
  "job",
  "jobSummary",
  "screenResults",
  "screenTaskProgress",
  "holdoutSettings",
  "savedSnapshot",
  "recentErrors",
  "deliveries",
  "channels",
  "monitors",
  "signalLedgerSummary",
  "intradayStatus",
  "chartView",
  "chartBars",
  "chartSharedDrawings",
  "czsc",
  "breakout",
  "rpsCurve",
  "tradePositionState",
  "securities",
  "securityProfile",
  "rpsStatus",
  "rpsRanking",
  "industryRpsStatus",
  "conceptRpsStatus",
  "researchSkills",
  "researchUsage",
  "researchArchiveHistory",
  "reportHistory",
  "report",
  "strategyCenterCatalog",
  "strategyCenterMethods",
  "strategyCenterHistory",
  "maBaselineHistory",
  "maBaselineCoverage",
  "maBaselineResult",
  "maBaselineOrders",
  "maBaselineEvaluation",
  "strategyCenterCompare",
  "strategyCenterEvaluation",
  "formulaHistory",
  "formulas",
  "newsAnalysisContext",
  "newsTaskState",
  "newsWorkspace",
  "newsArchiveHistory",
  "clsReviewReportPage",
  "clsReviewSummary",
  "clsReviewSchedule",
  "deliveryBatchPage",
  "tradeWorkspaceEnvironment",
  "tradeWorkspacePage",
  "tradeWorkspaceAdjustments",
  "tradeWorkspaceComparison",
  "deliveryWorkspacePage",
  "localFinancialArchiveHistory",
  "localFinancialScreenHistory",
  "cryptoBotStatus",
  "cryptoAccountView",
  "mxDataStatus",
  "monitorWorkspaceSummary",
  "monitorWorkspacePage",
  "signalWorkspacePage",
  "localDailyAsOf",
  "industryRpsPage",
  "conceptRpsPage",
  "intradayHistory",
  "intradayRuns",
  "intradayStorage",
  "intradaySummary",
  "marketPoolCatalog",
  "marketPoolPage",
  "indexDirectory",
  "rpsWorkflowLog",
  "chartPosition",
  "czscSchema",
  "tdxLocalFinancials",
  "financialQualityHistory",
  "valuationHistory",
  "archivedReport",
  "cryptoSettings",
  "ledgerCalendar",
  "ledgerHistory",
  "ledgerSummary",
  "newsBudget",
  "taskHistory",
  "taskOverview",
  "tradeWorkspacePositions",
  "tradeReviewExecution",
  "tradeReviewSnapshot",
  "tradeReviewNavPage",
  "tradeReviewExecutionDetail",
  "tradeReviewExecutionExport",
  "tradeReviewCashReconciliation",
  "tradeReviewCashReconciliationExport",
  "tradeReviewHoldingsCorrelation",
  "tradeReviewPositionRisk",
  "tradeReviewRollingPerformance",
  "tradeReviewPeriodPerformance",
  "tradeReviewAdmission",
  "deliveryBatchDetail",
  "deliveryEvidencePage",
  "deliveryFilePage",
  "cashWorkspace",
  "cashWorkspaceDate",
  "cashWorkspaceRows",
  "cashWorkspaceOpening",
  "cashWorkspaceDiagnostics",
  "localFinancialView",
  "localFinancialSeries",
  "localFinancialAudit",
  "localFinancialArchive",
  "localFinancialScreenPage",
  "clsReviewExport",
  "clsReviewFactPage",
  "clsReviewFactDetail",
  "clsReviewVerificationPage",
  "clsReviewVerificationDetail",
  "clsReviewReportSamples",
  "clsReviewSample",
  "clsReviewSampleEligibility",
  "newsOriginal",
  "newsAnalysis",
]);
const externalReads = new Set([
  "tdxQuotes",
  "tdxMinutes",
  "futuresQuotes",
  "macroRates",
  "limitSentiment",
  "tdxFinance",
  "stockEvents",
  "capitalProfile",
]);
const t = initTRPC.create({ transformer: SuperJSON });

export async function installOfflineVisualApi(
  page: Page,
  failedReads: ReadonlySet<string> = new Set(),
  poolFixture?: (
    data: RouterOutputs["marketPoolPage"],
  ) =>
    RouterOutputs["marketPoolPage"] | Promise<RouterOutputs["marketPoolPage"]>,
  localMutations: ReadonlySet<string> = new Set(),
) {
  const calls = new Set<string>();
  const unknown = new Set<string>();
  const blocked = new Set<string>();
  await page.route("**/api/trpc/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== new URL(page.url()).origin) {
      unknown.add("cross-origin-trpc");
      await route.abort("blockedbyclient");
      return;
    }
    const names = decodeURIComponent(
      url.pathname.split("/api/trpc/")[1]!,
    ).split(",");
    const mutation = request.method() === "POST";
    const procedures = Object.fromEntries(
      names.map((name) => {
        const resolve = async ({ input }: { input: unknown }) => {
          calls.add(name);
          const snapshotInput = input as
            { symbol?: string; source?: string } | undefined;
          const external =
            externalReads.has(name) ||
            (name === "snapshot" &&
              (!/^(sh|sz|bj)\d{6}$/.test(snapshotInput?.symbol ?? "") ||
                (snapshotInput?.source !== undefined &&
                  snapshotInput.source !== "local")));
          if (external) {
            blocked.add(name);
            throw new TRPCError({
              code: "SERVICE_UNAVAILABLE",
              message: "离线验收：外部行情不可用",
            });
          }
          if (
            !(mutation
              ? // Evaluate consumes only supplied candidates via a pure strategy
                // function. It does not fetch data, create jobs or trade.
                [
                  "snapshot",
                  "saveChartView",
                  "strategyCenterEvaluate",
                ].includes(name) || localMutations.has(name)
              : localReads.has(name))
          ) {
            unknown.add(name);
            throw new TRPCError({
              code: "PRECONDITION_FAILED",
              message: `验收接口尚未分类：${name}`,
            });
          }
          if (!mutation && failedReads.has(name)) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "离线验收：读取故障",
            });
          }
          const target = new URL(`/api/trpc/${name}`, url.origin);
          const data = SuperJSON.serialize(input);
          const response = mutation
            ? await page.request.post(target.toString(), {
                headers: trpcHeaders,
                data,
              })
            : await page.request.get(target.toString(), {
                headers: trpcHeaders,
                params: { input: JSON.stringify(data) },
              });
          const body = await response.json();
          if (body.error) {
            const error = SuperJSON.deserialize<{
              message: string;
              data?: { code?: string };
            }>(body.error);
            throw new TRPCError({
              code:
                (error.data?.code as TRPCError["code"]) ??
                "INTERNAL_SERVER_ERROR",
              message: error.message,
            });
          }
          const result = SuperJSON.deserialize(body.result.data);
          // Controlled loaded-state cases use the real page and local read,
          // then substitute only this read model. Never bypass the call policy.
          return name === "marketPoolPage" && poolFixture
            ? poolFixture(result as RouterOutputs["marketPoolPage"])
            : result;
        };
        const procedure = t.procedure.input(z.unknown());
        return [
          name,
          mutation ? procedure.mutation(resolve) : procedure.query(resolve),
        ];
      }),
    );
    // Reuse tRPC's streaming adapter; do not handcraft its JSONL wire format.
    const response = await fetchRequestHandler({
      endpoint: "/api/trpc",
      req: new Request(request.url(), {
        method: request.method(),
        headers: request.headers(),
        ...(mutation ? { body: request.postData() } : {}),
      }),
      router: t.router(procedures),
      createContext: () => ({}),
    });
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  return { calls, unknown, blocked };
}
