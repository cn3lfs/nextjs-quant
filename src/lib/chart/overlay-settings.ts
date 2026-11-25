import { z } from "zod";
import {
  patternBreakoutKinds,
  type PatternBreakoutKind,
} from "trading-strategies";
import type {
  BreakoutAnalysisOptions,
  DoubleBreakoutFilter,
} from "trading-strategies/research/breakout/breakout";

const direction = z.enum(["both", "long", "short"]).default("both");
export const breakoutChartSettingsSchema = z.object({
  trendMode: z
    .enum(["trendline-or-ma20", "trendline", "ma20"])
    .default("trendline-or-ma20"),
  levelMode: z.enum(["structural", "all"]).default("structural"),
  direction,
  volumeRatioThreshold: z.number().finite().min(0.5).max(10).default(1.5),
  minIndicatorVotes: z.number().int().min(0).max(4).default(2),
  minScore: z.number().int().min(0).max(5).default(3),
  minTouches: z.number().int().min(2).max(10).default(2),
  requireLargeBody: z.boolean().default(false),
});
export type BreakoutChartSettings = z.infer<typeof breakoutChartSettingsSchema>;
export const defaultBreakoutChartSettings = breakoutChartSettingsSchema.parse(
  {},
);

export const patternBreakoutChartSettingsSchema = z.object({
  kinds: z
    .array(z.enum(patternBreakoutKinds))
    .min(1)
    .default([...patternBreakoutKinds]),
  direction,
  minVolumeRatio: z.number().finite().min(0).max(10).default(1),
  minScore: z.number().int().min(1).max(5).default(3),
  showAllGeometry: z.boolean().default(false),
});
export type PatternBreakoutChartSettings = z.infer<
  typeof patternBreakoutChartSettingsSchema
>;
export const defaultPatternBreakoutChartSettings =
  patternBreakoutChartSettingsSchema.parse({});

export const patternBreakoutKindLabels: Record<PatternBreakoutKind, string> = {
  "head-shoulders-bottom": "头肩底",
  "head-shoulders-top": "头肩顶",
  box: "水平箱体",
  triangle: "三角形",
  wedge: "楔形",
};

export function breakoutFilterFromSettings(
  settings: BreakoutChartSettings,
): DoubleBreakoutFilter {
  const {
    direction,
    minScore,
    minTouches,
    requireLargeBody,
    volumeRatioThreshold,
  } = settings;
  return {
    direction,
    minScore,
    minTouches,
    requireLargeBody,
    minVolumeRatio: volumeRatioThreshold,
  };
}

export function breakoutAnalysisOptionsFromSettings(
  settings: BreakoutChartSettings,
): BreakoutAnalysisOptions {
  const { trendMode, levelMode, volumeRatioThreshold, minIndicatorVotes } =
    settings;
  return { trendMode, levelMode, volumeRatioThreshold, minIndicatorVotes };
}
