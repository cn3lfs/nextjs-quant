import { expect, it } from "vitest";
import { analyzeBreakout } from "trading-strategies/research/breakout/breakout";
import validBreakout from "../../fixtures/breakout-valid.json";
import falseBreakout from "../../fixtures/breakout-false.json";
import { candle } from "../../../packages/trading-strategies/tests/ohlc-fixtures";
import {
  czscEffectiveSettings,
  czscOverrides,
  type CzscConfigSchema,
} from "~/lib/chart/czsc-settings";
import {
  breakoutAnalysisOptionsFromSettings,
  breakoutChartSettingsSchema,
  breakoutFilterFromSettings,
  defaultBreakoutChartSettings,
  defaultPatternBreakoutChartSettings,
  patternBreakoutChartSettingsSchema,
} from "~/lib/chart/overlay-settings";
import {
  chartCzscDefaults,
  migrateCzscSettings,
  migrateLegacy,
} from "~/lib/stores/czsc-settings-store";

const schema: CzscConfigSchema = {
  fields: [
    {
      key: "stroke.rule",
      label: "笔算法",
      layer: 0,
      kind: 0,
      defaultValue: 0,
      defaultFloat: 0,
      minFloat: 0,
      maxFloat: 0,
    },
    {
      key: "stroke.gap",
      label: "笔中缺口",
      layer: 0,
      kind: 0,
      defaultValue: 0,
      defaultFloat: 0,
      minFloat: 0,
      maxFloat: 0,
    },
    {
      key: "stroke.gapThreshold",
      label: "大缺口阈值",
      layer: 0,
      kind: 1,
      defaultValue: 0,
      defaultFloat: 0.02,
      minFloat: 0,
      maxFloat: 1,
    },
  ],
  choices: [],
  rules: [
    {
      whenField: "stroke.rule",
      whenValue: 4,
      field: "stroke.gap",
      onlyValue: 0,
      reason: "分型笔没有跨度门槛",
    },
    {
      whenField: "stroke.gap",
      whenValue: 0,
      field: "stroke.gapThreshold",
      onlyValue: -1,
      reason: "不处理缺口时阈值不适用",
    },
  ],
};

it("dependency rules fix or drop inapplicable fields before the DLL sees them", () => {
  // Fractal strokes force gap=none, which in turn makes the threshold not applicable.
  expect(
    czscEffectiveSettings(schema, {
      "stroke.rule": 4,
      "stroke.gap": 2,
      "stroke.gapThreshold": 0.05,
    }),
  ).toEqual({ "stroke.rule": 4, "stroke.gap": 0 });
  expect(
    czscEffectiveSettings(schema, {
      "stroke.gap": 2,
      "stroke.gapThreshold": 0.05,
    }),
  ).toEqual({ "stroke.gap": 2, "stroke.gapThreshold": 0.05 });
  // Without a schema yet the values pass through unchanged.
  expect(czscEffectiveSettings(undefined, { "stroke.gap": 1 })).toEqual({
    "stroke.gap": 1,
  });
});

it("settings split into analysis config and display projection; unknown keys are ignored", () => {
  expect(
    czscOverrides({
      "stroke.rule": 3,
      "segment.method": 2,
      "segment.startBreak": 1,
      "center.strokeFormation": 1,
      "projection.segmentBoundary": 2,
      "outputs.events": 1,
      bogus: 9,
    }),
  ).toEqual({
    config: {
      strokeRule: 3,
      segmentMethod: 2,
      segmentStartBreak: 1,
      centerStrokeFormation: 1,
    },
    projection: { segmentBoundary: 2 },
  });
});

const defaultChartVisibility = {
  showStroke: true,
  showSegment: true,
  showSegmentCenters: false,
  showSegmentSignals: false,
};

it("defaults CZSC charts to the TDX Preset 2 settings", () => {
  expect(chartCzscDefaults).toEqual({
    "stroke.rule": 1,
    "stroke.endpoint": 2,
    "segment.startBreak": 1,
    "center.strokeFormation": 1,
    "projection.centerBox": 0,
  });
  expect(migrateLegacy({})).toEqual({
    values: chartCzscDefaults,
    ...defaultChartVisibility,
  });
  expect(migrateLegacy({ stroke: 0, centerMode: 0 })).toEqual({
    values: {
      ...chartCzscDefaults,
      "stroke.rule": 0,
      "center.strokeFormation": 0,
    },
    ...defaultChartVisibility,
  });
});

it("pre-v20 persisted chart settings migrate to schema keys", () => {
  expect(
    migrateLegacy({
      stroke: 3,
      strokeEnd: 1,
      segment: 1,
      segmentEnd: 2,
      centerMode: 1,
      box: "extended",
      showStroke: false,
    }),
  ).toEqual({
    values: {
      "stroke.rule": 3,
      "segment.startBreak": 1,
      "segment.method": 1,
      "projection.segmentBoundary": 2,
      "center.strokeFormation": 1,
      "projection.centerBox": 1,
    },
    ...defaultChartVisibility,
    showStroke: false,
  });
});

it.each([1, 2])(
  "v%d fills missing CZSC defaults and preserves saved settings without mutation",
  (version) => {
    const empty = Object.freeze({ values: Object.freeze({}) });
    expect(migrateCzscSettings(empty, version)).toEqual({
      values: chartCzscDefaults,
      ...defaultChartVisibility,
    });
    const saved = Object.freeze({
      values: Object.freeze({
        "stroke.rule": 0,
        "center.strokeFormation": 0,
        "projection.centerBox": 1,
      }),
      showStroke: false,
      showSegment: false,
      showSegmentCenters: true,
      showSegmentSignals: true,
    });
    const migrated = migrateCzscSettings(saved, version);
    expect(migrated).toEqual({
      ...saved,
      values: { ...chartCzscDefaults, ...saved.values },
    });
    expect(migrated.values).not.toBe(saved.values);
  },
);

it("v21 retires the old first endpoint without reinterpreting saved settings", () => {
  const saved = {
    values: {
      "stroke.endpoint": 1,
      "stroke.gap": 2,
      "projection.centerBox": 1,
    },
    showStroke: false,
    showSegment: true,
  };
  const { ["stroke.endpoint"]: _endpoint, ...defaults } = chartCzscDefaults;
  expect(migrateCzscSettings(saved, 1)).toEqual({
    ...defaultChartVisibility,
    ...saved,
    values: { ...defaults, "stroke.gap": 2, "projection.centerBox": 1 },
  });
  for (const endpoint of [0, 2]) {
    const state = { ...saved, values: { "stroke.endpoint": endpoint } };
    expect(migrateCzscSettings(state, 1)).toEqual({
      ...defaultChartVisibility,
      ...state,
      values: { ...chartCzscDefaults, ...state.values },
    });
  }
  expect(migrateCzscSettings(saved, 2)).toEqual({
    ...defaultChartVisibility,
    ...saved,
    values: { ...chartCzscDefaults, ...saved.values },
  });
  expect(saved.values["stroke.endpoint"]).toBe(1);
});

it("defaults and validates double-breakout chart parameters", () => {
  const defaults = {
    trendMode: "trendline-or-ma20",
    levelMode: "structural",
    direction: "both",
    volumeRatioThreshold: 1.5,
    minIndicatorVotes: 2,
    minScore: 3,
    minTouches: 2,
    requireLargeBody: false,
  };
  expect(breakoutChartSettingsSchema.parse({})).toEqual(defaults);
  expect(defaultBreakoutChartSettings).toEqual(defaults);
  for (const invalid of [
    { trendMode: "ema" },
    { levelMode: "round" },
    { direction: "up" },
    { volumeRatioThreshold: 0.49 },
    { volumeRatioThreshold: 10.01 },
    { minIndicatorVotes: 5 },
    { minIndicatorVotes: 1.5 },
    { minScore: 6 },
    { minTouches: 1 },
    { minTouches: 2.5 },
    { requireLargeBody: "true" },
  ])
    expect(breakoutChartSettingsSchema.safeParse(invalid).success).toBe(false);
});

it("defaults and validates pattern-breakout chart parameters", () => {
  const defaults = {
    kinds: [
      "head-shoulders-bottom",
      "head-shoulders-top",
      "box",
      "triangle",
      "wedge",
    ],
    direction: "both",
    minVolumeRatio: 1,
    minScore: 3,
    showAllGeometry: false,
  };
  expect(patternBreakoutChartSettingsSchema.parse({})).toEqual(defaults);
  expect(defaultPatternBreakoutChartSettings).toEqual(defaults);
  const custom = {
    kinds: ["triangle"],
    direction: "short",
    minVolumeRatio: 0,
    minScore: 5,
    showAllGeometry: true,
  };
  expect(patternBreakoutChartSettingsSchema.parse(custom)).toEqual(custom);
  for (const invalid of [
    { kinds: [] },
    { kinds: ["flag"] },
    { direction: "down" },
    { minVolumeRatio: -0.1 },
    { minVolumeRatio: 10.1 },
    { minScore: 0 },
    { minScore: 3.5 },
    { showAllGeometry: 1 },
  ])
    expect(patternBreakoutChartSettingsSchema.safeParse(invalid).success).toBe(
      false,
    );
});

it("maps chart settings to the rendering filter and analysis parameters", () => {
  const settings = breakoutChartSettingsSchema.parse({
    trendMode: "ma20",
    levelMode: "all",
    direction: "short",
    volumeRatioThreshold: 2.5,
    minIndicatorVotes: 4,
    minScore: 5,
    minTouches: 3,
    requireLargeBody: true,
  });
  expect(breakoutFilterFromSettings(settings)).toEqual({
    direction: "short",
    minScore: 5,
    minTouches: 3,
    requireLargeBody: true,
    minVolumeRatio: 2.5,
  });
  expect(breakoutAnalysisOptionsFromSettings(settings)).toEqual({
    trendMode: "ma20",
    levelMode: "all",
    volumeRatioThreshold: 2.5,
    minIndicatorVotes: 4,
  });
});

it("uses MA20 across a real crossing when a trendline is unavailable", () => {
  const bars = Array.from({ length: 65 }, (_, i) => candle(i, 106));
  bars[63] = candle(63, 105);
  bars[64] = candle(64, 109, { open: 105, volume: 200 });
  const legacy = analyzeBreakout(bars).latest!.long;
  expect(legacy).toMatchObject({ line: null, checks: { trend: "未知" } });
  expect(legacy).not.toHaveProperty("trendSource");
  // The previous close 105 is below 105.95; the new close 109 is above 106.10.
  for (const trendMode of ["ma20", "trendline-or-ma20"] as const)
    expect(
      analyzeBreakout(bars, undefined, false, { trendMode }).latest!.long,
    ).toMatchObject({
      line: null,
      trendSource: "ma20",
      checks: { trend: "是" },
    });
});

it("prefers the existing line in hybrid mode and bypasses it in MA20 mode", () => {
  const bars = validBreakout.bars;
  const legacy = analyzeBreakout(bars);
  expect(analyzeBreakout(bars, undefined, false, {})).toEqual(legacy);
  const hybrid = analyzeBreakout(bars, undefined, false, {
    trendMode: "trendline-or-ma20",
  }).latest!.long;
  expect(hybrid).toMatchObject({
    trendSource: "trendline",
    checks: { trend: "是" },
  });
  expect(hybrid.line).not.toBeNull();
  expect(hybrid.line).toEqual(legacy.latest!.long.line);
  const ma20 = analyzeBreakout(bars, undefined, false, { trendMode: "ma20" })
    .latest!.long;
  expect(ma20).toMatchObject({
    line: null,
    trendSource: "ma20",
    checks: { trend: "否" },
  });
});

it.each([
  { source: "swing", resistance: 120, support: 90 },
  { source: "platform", resistance: 112, support: 108 },
])(
  "uses only directional $source levels in structural mode even with a closer round level",
  ({ source, resistance, support }) => {
    const bars = Array.from({ length: 65 }, (_, i) => candle(i, 106));
    if (source === "swing") {
      bars[19] = candle(19, 106, { high: resistance });
      bars[38] = candle(38, 106, { low: support });
      bars[63] = candle(63, 110);
    } else {
      for (let i = 54; i <= 63; i++)
        bars[i] = candle(i, 110, {
          high: resistance,
          low: support,
          volume: 50,
        });
    }
    bars[64] = candle(64, 113, { open: 110 });
    const all = analyzeBreakout(bars, undefined, false, {
      levelMode: "all",
    }).latest!;
    expect(all.long.keyLevel).toMatchObject({ price: 110, source: "round" });
    expect(all.short.keyLevel).toMatchObject({ price: 110, source: "round" });
    const structural = analyzeBreakout(bars, undefined, false, {
      levelMode: "structural",
    }).latest!;
    expect(structural.long.keyLevel).toMatchObject({
      price: resistance,
      source: `${source}-high`,
    });
    expect(structural.short.keyLevel).toMatchObject({
      price: support,
      source: `${source}-low`,
    });
  },
);

it("applies custom volume and indicator vote thresholds independently", () => {
  const bars = falseBreakout.bars;
  const legacy = analyzeBreakout(bars);
  expect(
    analyzeBreakout(bars, undefined, false, {
      volumeRatioThreshold: 1.5,
      minIndicatorVotes: 2,
    }),
  ).toEqual(legacy);
  expect(legacy.latest!.long.checks).toMatchObject({
    volume: "否",
    indicators: "否",
  });
  const volumeOnly = analyzeBreakout(bars, undefined, false, {
    volumeRatioThreshold: 1.1,
  }).latest!;
  expect(volumeOnly.long.checks).toMatchObject({
    volume: "是",
    indicators: "否",
  });
  const votesOnly = analyzeBreakout(bars, undefined, false, {
    minIndicatorVotes: 1,
  }).latest!;
  expect(votesOnly.long.checks).toMatchObject({
    volume: "否",
    indicators: "是",
  });
});
