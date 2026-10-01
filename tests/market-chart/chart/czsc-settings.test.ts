import { expect, it } from "vitest";
import {
  czscEffectiveSettings,
  czscOverrides,
  type CzscConfigSchema,
} from "~/lib/chart/czsc-settings";
import { migrateLegacy } from "~/lib/stores/czsc-settings-store";

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
      "center.strokeFormation": 1,
      "projection.segmentBoundary": 2,
      "outputs.events": 1,
      bogus: 9,
    }),
  ).toEqual({
    config: { strokeRule: 3, centerStrokeFormation: 1 },
    projection: { segmentBoundary: 2 },
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
      "stroke.endpoint": 1,
      "segment.method": 1,
      "projection.segmentBoundary": 2,
      "center.strokeFormation": 1,
      "projection.centerBox": 1,
    },
    showStroke: false,
    showSegment: true,
  });
  // An empty legacy state keeps the chart's own default: boxes end at the first three members.
  expect(migrateLegacy({}).values).toEqual({ "projection.centerBox": 0 });
});
