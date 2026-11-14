import { sqlite as chartSqlite } from "../../db";
import { analyzeCzsc, czscConfigSchema } from "../../strategies/chan/czsc";
import { czscSettingsSchema } from "~/lib/chart/czsc-settings";
import { analyzeBreakout } from "trading-strategies/research/breakout/breakout";
import { completedBarFilter } from "~/lib/completed-bars";
import { financialGrowth } from "../../strategies/value/financial-growth";
import {
  financialQualityJob,
  financialQualityHistory,
  type FinancialQualityArchive,
} from "../../strategies/value/financial-quality";
import { valuationScenarioSchema } from "trading-strategies/research/factors/valuation-scenario";
import {
  saveValuationScenario,
  valuationScenarioHistory,
  type ValuationScenario,
} from "../../strategies/value/valuation-scenario";
import { z } from "zod";
import { type Snapshot, type Channel } from "~/lib/domain";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import { readRecordSnapshot } from "../../db";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
function recordOfKind<T>(kind: string, id: string): T | undefined {
  const row = chartSqlite()
    .prepare("SELECT payload FROM records WHERE kind=? AND id=?")
    .get(kind, id) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as T) : undefined;
}
function storedSnapshot(id: string) {
  return (
    recordOfKind<Snapshot>("snapshot", id) ??
    recordOfKind<Snapshot>("chart-snapshot", id)
  );
}
export const strategyRouter = createTRPCRouter({
  financialQualityCreate: p("financial", "compute")
    .input(symbolSchema)
    .mutation(({ input }) => financialQualityJob(input)),
  financialQualityHistory: p("financial", "read").query(() =>
    financialQualityHistory(),
  ),
  financialQualityReport: p("financial", "read")
    .input(z.string().regex(/^financial-quality-[a-f0-9]{64}$/))
    .query(
      ({ input }) =>
        recordOfKind<FinancialQualityArchive>("financial-quality", input) ??
        null,
    ),
  financialGrowthReport: p("financial", "read")
    .input(z.string().regex(/^financial-quality-[a-f0-9]{64}$/))
    .query(({ input }) => {
      const archive = recordOfKind<FinancialQualityArchive>(
        "financial-quality",
        input,
      );
      return archive ? financialGrowth(archive) : null;
    }),
  valuationSave: p("financial", "configure")
    .input(valuationScenarioSchema)
    .mutation(({ input }) => ({ id: saveValuationScenario(input).id })),
  valuationHistory: p("financial", "read").query(() =>
    valuationScenarioHistory(),
  ),
  valuationReport: p("financial", "read")
    .input(z.string().regex(/^valuation-scenario-[a-f0-9]{64}$/))
    .query(
      ({ input }) =>
        recordOfKind<ValuationScenario>("valuation-scenario", input) ?? null,
    ),
  breakout: p("breakout", "compute")
    .input(
      z.object({
        snapshotId: z.string().min(1),
        chartSnapshot: z.boolean().default(false),
      }),
    )
    .query(({ input }) => {
      const source = storedSnapshot(input.snapshotId);
      if (!source || !Array.isArray(source.bars))
        throw new Error("行情快照不存在");
      if (input.chartSnapshot) {
        if (!source.id.startsWith("chart-snapshot-"))
          throw new Error("图表快照不匹配");
        return analyzeBreakout(source.bars, 0, true);
      }
      if (source.period !== "day") throw new Error("双突破仅支持日线");
      const completed = completedBarFilter("day", Date.now());
      return analyzeBreakout(
        source.bars.filter((b) => completed(b.date)),
        0,
      );
    }),
  czsc: p("nativeChart", "compute")
    .input(
      z.object({
        snapshotId: z.string().min(1),
        chartSnapshot: z.boolean().default(false),
        settings: czscSettingsSchema.optional(),
      }),
    )
    .query(({ input }) => {
      const source = storedSnapshot(input.snapshotId);
      if (!source || !Array.isArray(source.bars))
        throw new Error("行情快照不存在");

      return analyzeCzsc(
        source.bars,
        false,
        undefined,
        false,
        undefined,
        false,
        input.settings,
      );
    }),
  czscSchema: p("nativeChart", "read").query(() => czscConfigSchema()),
  channels: p("notifications", "read").query(() =>
    readRecordSnapshot("channel", (rows: Iterable<Channel>) => [...rows]),
  ),
});
