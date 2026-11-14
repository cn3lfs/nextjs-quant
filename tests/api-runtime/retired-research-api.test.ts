import { expect, it } from "vitest";
import { existsSync } from "node:fs";
import { appRouter } from "~/server/api/root";
import { sqlite } from "~/server/db";

const retired = [
  "strategyLifecycle",
  "screen",
  "backtest",
  "cashDividendSimulation",
  "walkForward",
  "walkForwardHistory",
  "walkForwardResult",
  "walkForwardExport",
  "explainWalkForward",
  "chanAnalyze",
  "chanHistory",
  "chanReport",
  "canslimAnalyze",
  "canslimHistory",
  "canslimReport",
  "wyckoffAnalyze",
  "wyckoffHistory",
  "wyckoffReport",
  "fundamentalAnalyze",
  "fundamentalHistory",
  "fundamentalReport",
] as const;

it.each([
  "src/server/strategies/chan/chan-report.ts",
  "src/server/strategies/chan/chan-report-schema.ts",
  "src/server/strategies/canslim/canslim-report.ts",
  "src/server/strategies/canslim/canslim-report-schema.ts",
  "src/server/strategies/canslim/canslim-method.ts",
  "src/server/strategies/canslim/canslim-prompt-evidence.ts",
  "src/server/strategies/canslim/canslim-dossier.ts",
  "src/server/strategies/wyckoff/wyckoff-report.ts",
  "src/server/strategies/wyckoff/wyckoff-report-schema.ts",
  "src/server/strategies/wyckoff/wyckoff-job.ts",
  "src/server/strategies/wyckoff/wyckoff-method.ts",
  "src/server/strategies/wyckoff/wyckoff-prompt-frames.ts",
  "src/server/strategies/wyckoff/wyckoff-frames.ts",
  "src/server/strategies/wyckoff/wyckoff-market.ts",
  "src/server/strategies/value/fundamental-report.ts",
  "src/server/strategies/value/fundamental-prompt.ts",
  "src/server/strategies/value/fundamental-dossier.ts",
  "src/server/strategies/value/valuation-method.ts",
  "src/server/research/research-history.ts",
])("removes unused legacy report implementation %s", (path) => {
  expect(existsSync(path)).toBe(false);
});

it.each(retired)(
  "removed research procedure %s cannot read or start work",
  async (name) => {
    const count = () =>
      sqlite().prepare("SELECT count(*) n FROM records").get();
    const before = count();
    const caller = appRouter.createCaller({
      headers: new Headers(),
    }) as unknown as Record<string, (input?: unknown) => Promise<unknown>>;
    expect(appRouter._def.procedures).not.toHaveProperty(name);
    await expect(
      caller[name]!({ snapshotId: "snapshot-fixture", question: "fixture" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(count()).toEqual(before);
  },
);

it("keeps current evidence, financial and chart procedures registered", () => {
  for (const name of [
    "analyze",
    "archivedReport",
    "financialQualityCreate",
    "financialQualityReport",
    "valuationSave",
    "czsc",
    "czscSchema",
    "breakout",
    "formulaScreen",
    "maBaseline",
    "dividendSchedule",
  ])
    expect(appRouter._def.procedures).toHaveProperty(name);
});
