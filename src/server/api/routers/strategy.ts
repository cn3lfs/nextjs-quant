import { readArchiveRecord } from "../../db/archive-records";
import { analyzeCzsc, czscConfigSchema } from "../../strategies/chan/czsc";
import { czscSettingsSchema } from "~/lib/chart/czsc-settings";
import {
  breakoutChartSettingsSchema,
  patternBreakoutChartSettingsSchema,
} from "~/lib/chart/overlay-settings";
import { analyzeBreakout } from "trading-strategies/research/breakout/breakout";
import { analyzePatternBreakouts } from "trading-strategies";
import { completedBarFilter } from "~/lib/completed-bars";
import { financialGrowth } from "../../strategies/value/financial-growth";
import { financialQualityJob } from "../../strategies/value/financial-quality";
import { financialQualityHistory } from "~/server/db/financial-quality-history";
import { valuationScenarioSchema } from "trading-strategies/research/factors/valuation-scenario";
import { saveValuationScenario } from "../../strategies/value/valuation-scenario";
import { valuationScenarioHistory } from "~/server/db/valuation-scenario-history";
import { z } from "zod";
import { type Channel } from "~/lib/domain";
import { symbolSchema } from "trading-strategies/research/contracts/security";
import { readRecordSnapshot } from "../../db";
import { createTRPCRouter, capabilityProcedure as p } from "../trpc";
function storedSnapshot(id: string) {
  return (
    readArchiveRecord("snapshot", id) ?? readArchiveRecord("chart-snapshot", id)
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
      ({ input }) => readArchiveRecord("financial-quality", input) ?? null,
    ),
  financialGrowthReport: p("financial", "read")
    .input(z.string().regex(/^financial-quality-[a-f0-9]{64}$/))
    .query(({ input }) => {
      const archive = readArchiveRecord("financial-quality", input);
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
      ({ input }) => readArchiveRecord("valuation-scenario", input) ?? null,
    ),
  breakout: p("breakout", "compute")
    .input(
      z.object({
        snapshotId: z.string().min(1),
        chartSnapshot: z.boolean().default(false),
        options: breakoutChartSettingsSchema
          .pick({
            trendMode: true,
            levelMode: true,
            volumeRatioThreshold: true,
            minIndicatorVotes: true,
          })
          .partial()
          .optional(),
      }),
    )
    .query(({ input }) => {
      const source = storedSnapshot(input.snapshotId);
      if (!source || !Array.isArray(source.bars))
        throw new Error("行情快照不存在");
      if (input.chartSnapshot) {
        if (!source.id.startsWith("chart-snapshot-"))
          throw new Error("图表快照不匹配");
        return analyzeBreakout(source.bars, 0, true, input.options);
      }
      if (source.period !== "day") throw new Error("双突破仅支持日线");
      const completed = completedBarFilter("day", Date.now());
      return analyzeBreakout(
        source.bars.filter((b) => completed(b.date)),
        0,
        false,
        input.options,
      );
    }),
  patternBreakout: p("breakout", "compute")
    .input(
      z.object({
        snapshotId: z.string().min(1),
        chartSnapshot: z.boolean().default(false),
        options: patternBreakoutChartSettingsSchema
          .omit({ showAllGeometry: true })
          .partial()
          .extend({ cooldownBars: z.number().int().min(0).max(60).optional() })
          .optional(),
      }),
    )
    .query(({ input }) => {
      const source = storedSnapshot(input.snapshotId);
      if (!source || !Array.isArray(source.bars))
        throw new Error("行情快照不存在");
      const chartOptions = {
        ...input.options,
        minScore: input.options?.minScore ?? 3,
        dedupPerBar: true,
        cooldownBars: input.options?.cooldownBars ?? 10,
      };
      if (input.chartSnapshot) {
        if (!source.id.startsWith("chart-snapshot-"))
          throw new Error("图表快照不匹配");
        const forming = new Set(source.barStore?.formingDates);
        return analyzePatternBreakouts(
          forming.size
            ? source.bars.filter((b) => !forming.has(b.date))
            : source.bars,
          chartOptions,
        );
      }
      const completed = completedBarFilter(source.period, Date.now());
      return analyzePatternBreakouts(
        source.bars.filter((b) => completed(b.date)),
        chartOptions,
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
        true,
        undefined,
        false,
        1,
        false,
        input.settings,
        true,
      );
    }),
  czscSchema: p("nativeChart", "read").query(() => czscConfigSchema()),
  channels: p("notifications", "read").query(() =>
    readRecordSnapshot("channel", (rows: Iterable<Channel>) => [...rows]),
  ),
});
