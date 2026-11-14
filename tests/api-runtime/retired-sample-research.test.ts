import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { appRouter } from "~/server/api/root";
import { put, sqlite } from "~/server/db";

const removed = [
  "strategyResearchAdmission",
  "strategyResearchAdmissionExport",
  "strategyResearchRollingPerformance",
  "strategyResearchPeriodPerformance",
  "strategyResearchTasks",
  "strategyResearchCreate",
  "strategyResearchRetry",
  "strategyResearchCancel",
  "strategyResearchSegments",
  "strategyResearchResult",
  "strategyResearchGovernance",
  "strategyResearchReveal",
  "strategyResearchExport",
  "strategyResearchRemove",
];
it("current account services do not expose retired sample adapters", async () => {
  expect(
    await import("~/server/research/performance/period-performance-service"),
  ).not.toHaveProperty("researchDailyReturns");
  expect(
    await import("~/server/research/performance/strategy-admission-service"),
  ).not.toHaveProperty("researchAdmissionSource");
  expect(await import("~/lib/backtest/weight-backtest")).not.toHaveProperty(
    "projectResearchWeights",
  );
  expect(await import("~/lib/research/specs/research-k13")).not.toHaveProperty(
    "researchK13Records",
  );
});
it.each([
  "src/components/research/research-strategy-fields.tsx",
  "src/components/research/research-management-fields.tsx",
  "src/components/research/research-risk-composition-fields.tsx",
  "src/server/backtest/research-run.ts",
  "src/server/strategies/shared/research-signals.ts",
  "src/server/backtest/research-portfolio.ts",
  "src/server/backtest/research-dataset.ts",
  "src/server/backtest/research-adjustment-coverage.ts",
  "src/server/backtest/research-json.ts",
  "src/server/backtest/quant.ts",
  "src/server/backtest/research-outcomes.ts",
  "src/server/backtest/dividend-ledger.ts",
  "src/server/backtest/cash-adjusted-signals.ts",
  "src/server/backtest/bonus-adjusted-signals.ts",
  "src/server/backtest/signal-backtest.ts",
  "src/server/backtest/signal-backtest-benchmark.ts",
  "src/components/backtest/research-adjustment.tsx",
  "src/components/backtest/trade-rounds-panel.tsx",
  "src/lib/backtest/trade-rounds.ts",
  "src/lib/research/evidence/research-adjustment.ts",
  "src/server/strategies/canslim/research-growth-intraday.ts",
  "src/server/strategies/chan/research-chan-movements.ts",
  "src/server/strategies/chan/research-chan-zhongyin.ts",
  "src/server/backtest/research-store.ts",
  "src/server/research/performance/three-segment-sample.ts",
  "src/components/backtest/three-segment-results.tsx",
  "src/lib/backtest/three-segment-sample.ts",
  "scripts/r3-batch-runner.ts",
  "scripts/r3-result-table.ts",
])("removes the obsolete sample persistence/report module %s", (file) => {
  expect(existsSync(file)).toBe(false);
});
it.each(removed)(
  "does not expose obsolete sample workflow %s",
  async (name) => {
    put("research-task", "research-retired-fixture", {
      id: "research-retired-fixture",
      status: "queued",
      ownerPid: -1,
    });
    const before = sqlite().prepare("SELECT * FROM records ORDER BY id").all();
    const caller = appRouter.createCaller({
      headers: new Headers(),
    }) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
    expect(appRouter._def.procedures).not.toHaveProperty(name);
    await expect(
      caller[name]!("research-retired-fixture"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(sqlite().prepare("SELECT * FROM records ORDER BY id").all()).toEqual(
      before,
    );
  },
);
it("rejects removed research snapshots at the current universe-audit boundary", async () => {
  const caller = appRouter.createCaller({ headers: new Headers() });
  const audit = caller.universeAuditPage as (
    input: unknown,
  ) => Promise<unknown>;
  await expect(
    audit({
      source: { kind: "research", id: "old" },
      start: "2026-01-01",
      end: "2026-01-31",
    }),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
});
it("keeps current strategy experiments and account review APIs", () => {
  for (const name of [
    "maBaseline",
    "maBaselineResult",
    "tradeReviewPeriodPerformance",
    "tradeReviewRollingPerformance",
    "tradeReviewAdmission",
    "tradeReviewAdmissionExport",
    "factorEvaluate",
  ])
    expect(appRouter._def.procedures).toHaveProperty(name);
});
