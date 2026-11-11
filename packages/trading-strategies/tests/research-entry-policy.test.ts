import { expect, it } from "vitest";
import fixture from "../../../tests/fixtures/breakout-valid.json";
import { analyzeBreakout } from "../src/research/breakout/breakout.js";
import {
  breakoutEntryIntent,
  legacyCzscQualifiedSignals,
} from "../src/research/technical/research-entry-policy.js";
import type { CzscResult } from "../src/research/chan/czsc.js";

const points = analyzeBreakout(fixture.bars, 0).points;
const index = points.findIndex((point) => point.long.status === "是");
const point = points[index]!,
  bar = fixture.bars[index]!,
  previous = fixture.bars[index - 1]!;
it("preserves the simple entry and optional 2R target while refusing zero-volume or negative signals", () => {
  expect(index).toBeGreaterThan(0);
  expect(
    breakoutEntryIntent(
      point,
      bar,
      previous,
      { strategy: "dual-breakout", stopDiagnosis: false },
      null,
    ),
  ).toEqual({ evidence: point.long });
  expect(
    breakoutEntryIntent(
      point,
      bar,
      previous,
      {
        strategy: "dual-breakout",
        stopDiagnosis: false,
        contextRisk: "sw-preflight",
      },
      null,
    )?.entryTarget,
  ).toBe(point.long.risk.target1?.price ?? null);
  expect(
    breakoutEntryIntent(
      point,
      { ...bar, volume: 0 },
      previous,
      { strategy: "dual-breakout", stopDiagnosis: false },
      null,
    ),
  ).toBeNull();
  const rejected = structuredClone(point);
  rejected.long.status = "否";
  expect(
    breakoutEntryIntent(
      rejected,
      bar,
      previous,
      { strategy: "dual-breakout", stopDiagnosis: false },
      null,
    ),
  ).toBeNull();
});
it("keeps structure-stop precedence and freezes the nearest confirmed lower swing for pullbacks", () => {
  const changed = structuredClone(point),
    template = point.levels[0]!;
  expect(template).toBeDefined();
  changed.levels = [
    {
      ...template,
      source: "swing-low",
      price: bar.close - 5,
      index: 10,
      confirmedAt: bar.date,
    },
    {
      ...template,
      source: "swing-low",
      price: bar.close - 3,
      index: 12,
      confirmedAt: "9999-01-01",
    },
    {
      ...template,
      source: "swing-low",
      price: bar.close - 4,
      index: 11,
      confirmedAt: bar.date,
    },
  ];
  const selected = breakoutEntryIntent(
    changed,
    bar,
    previous,
    {
      strategy: "dual-breakout-structure",
      stopDiagnosis: false,
      stopKind: "breakout-candle",
      riskScenario: "pullback",
      pyramidKind: "pullback-50-50",
    },
    null,
  )!;
  expect(selected.initialStop).toBe(bar.close - 4);
  expect(selected.pullbackLevel).toBe(
    point.long.keyLevel && point.long.line
      ? Math.max(point.long.keyLevel.price, point.long.line.value)
      : null,
  );
  expect(selected.evidence).toHaveProperty("stopLocation.price", bar.low);
  expect(changed.levels).toHaveLength(3);
});
it("keeps the legacy native profile separate from stricter confirmed-native admission", () => {
  const signals = [
    { index: 0, date: "2024-01-01", kind: 1, quality: 1 },
    { index: 1, date: "2024-01-02", kind: 2, quality: 2 },
    { index: 2, date: "2024-01-03", kind: 3, quality: 0 },
    { index: 3, date: "2024-01-04", kind: -1, quality: 1 },
  ];
  const result: CzscResult = {
    status: "structure",
    hash: "legacy-fixture",
    sourceCommit: "czsc-api-v4",
    families: [
      {
        config: 0,
        signals,
        points: [],
        centers: [],
        movements: [],
        divergences: [],
        qualities: [],
      },
    ],
  };
  expect(legacyCzscQualifiedSignals(result, 0)).toEqual(signals.slice(0, 2));
  expect(legacyCzscQualifiedSignals(result, 1100)).toEqual([]);
  expect(
    legacyCzscQualifiedSignals({ ...result, status: "no-structure" }, 0),
  ).toEqual([]);
});
