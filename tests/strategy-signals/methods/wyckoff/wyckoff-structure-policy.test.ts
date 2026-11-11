import { expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import type {
  WyckoffPoint,
  WyckoffStructureInput,
} from "trading-strategies/research/wyckoff/research-wyckoff";
import {
  applyWyckoffStructurePolicy,
  wyckoffDualRelativeStrength,
  wyckoffScoreEntry,
  wyckoffWeeklyAlignment,
  wyckoffStructureWeeklyCount,
} from "trading-strategies/research/wyckoff/wyckoff-structure-policy";

const candle = (index: number, close: number): Bar => ({
  date: new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10),
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 100,
  amount: close * 100,
});
function setup() {
  const bars = [105, 106, 104, 111].map((close, index) => candle(index, close));
  const point: WyckoffPoint = {
    date: bars[3]!.date,
    entry: true,
    exit: false,
    reason: null,
    decision: "baseline",
    values: { close: 111, ma20: 105, meanVolume: 100 },
    structure: null,
    events: [
      {
        key: "jac",
        kind: "jac",
        candidateAt: bars[2]!.date,
        observedAt: bars[3]!.date,
        confirmedAt: bars[3]!.date,
        state: "confirmed",
        reason: "fixture",
        facts: {
          index: 3,
          rangeStart: 0,
          low: 100,
          high: 110,
          close: 111,
          volume: 100,
          meanVolume: 100,
          support: 100,
          resistance: 110,
          level: 1,
          trend: true,
          parentAt: null,
        },
      },
    ],
  };
  const assessment: NonNullable<WyckoffStructureInput["assessment"]> = {
    phase: "accumulation",
    quality: "single",
    tr: 70,
    vsa: 70,
    mtf: 70,
    rs: 70,
    market: 70,
    source: "frozen",
    availableAt: "2020-01-04T15:00:00+08:00",
  };
  return { bars, point, assessment };
}

it("52 completed weeks require two confirmed rising highs and lows beyond the latest ambiguity barrier", () => {
  expect(wyckoffStructureWeeklyCount).toBe(52);
  const weeks = Array.from({ length: 52 }, (_, index) =>
    candle(index, 100 + index + 10 * Math.sin((index * Math.PI) / 6)),
  );
  const facts = wyckoffWeeklyAlignment(weeks);
  expect(facts.aligned).toBe(true);
  expect(facts.highs.map((point) => point.index)).toEqual([27, 39]);
  expect(facts.lows.map((point) => point.index)).toEqual([33, 45]);
  expect(wyckoffWeeklyAlignment(weeks.slice(1)).aligned).toBe(false);
  Object.assign(weeks[35]!, { high: 1000, low: 1 });
  expect(wyckoffWeeklyAlignment(weeks).aligned).toBe(false);
  expect(wyckoffWeeklyAlignment([])).toEqual({
    highs: [],
    lows: [],
    aligned: false,
  });
});

it("dual RS requires both strictly positive existing ratio changes without replacing missing inputs", () => {
  expect(wyckoffDualRelativeStrength(1, 0.001)).toBe(true);
  for (const [industry, market] of [
    [0, 1],
    [1, 0],
    [-1, 2],
    [null, 2],
    [2, null],
  ] as const)
    expect(wyckoffDualRelativeStrength(industry, market)).toBe(false);
});

it("score entry reuses frozen TR targets and the exact stage, 70-score, payoff, stop and 60-day policies", () => {
  const f = setup(),
    before = structuredClone(f);
  const criterion = wyckoffScoreEntry(f.point, f.bars, 3, f.assessment);
  expect(criterion.pass).toBe(true);
  expect(criterion.scoreTarget).toMatchObject({
    status: "computed",
    targets: [120, 130, 140],
  });
  expect(criterion.scoreStop).toBe(99.9);
  expect(criterion.evidence).toMatchObject({
    value: 70,
    payoff: (140 - 111) / (111 - 99.9),
    assumedWinRate: 0.48,
  });
  const result = applyWyckoffStructurePolicy(
    "wy-score-half-kelly",
    f.point,
    undefined,
    criterion,
  );
  expect(result.entry).toBe(true);
  expect(result.ruleStop).toEqual({
    price: 99.9,
    days: 60,
    reason: "冻结TR下沿下方0.1%",
  });
  expect(result.targetPlan).toEqual(criterion.scoreTarget);
  expect(f).toEqual(before);
  expect(
    wyckoffScoreEntry(f.point, f.bars, 3, { ...f.assessment, tr: 69.99 }).pass,
  ).toBe(false);
  for (const phase of ["distribution", "markdown", "unknown"] as const)
    expect(
      wyckoffScoreEntry(f.point, f.bars, 3, { ...f.assessment, phase }).pass,
    ).toBe(false);
  f.bars[3]!.close = 120;
  expect(wyckoffScoreEntry(f.point, f.bars, 3, f.assessment).pass).toBe(false);
});

it("application evidence vetoes still defeat valid policies and absent JAC or invalid TR never becomes an entry", () => {
  const f = setup(),
    criterion = wyckoffScoreEntry(f.point, f.bars, 3, f.assessment);
  expect(
    applyWyckoffStructurePolicy("wy-score-half-kelly", f.point, undefined, {
      ...criterion,
      reason: "input revised",
    }).entry,
  ).toBe(false);
  expect(
    applyWyckoffStructurePolicy(
      "wy-score-half-kelly",
      { ...f.point, entry: false },
      undefined,
      criterion,
    ).entry,
  ).toBe(false);
  f.point.events = [];
  expect(wyckoffScoreEntry(f.point, f.bars, 3, f.assessment)).toMatchObject({
    pass: false,
    evidence: { value: 70 },
  });
  const broken = setup();
  broken.point.events[0]!.facts.resistance = 100;
  const missing = wyckoffScoreEntry(
    broken.point,
    broken.bars,
    3,
    broken.assessment,
  );
  expect(missing.pass).toBe(false);
  expect(missing.reason).toBeTruthy();
});
