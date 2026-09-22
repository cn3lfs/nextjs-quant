import { describe, expect, it } from "vitest";
import type { Bar } from "../src/lib/domain";
import {
  analyzeBreakout,
  type BreakoutPoint,
  type TrendLine,
} from "../src/server/strategies/breakout/breakout";
import {
  researchSwingCoreSeries,
  selectSwingLevel,
  swingGapLevels,
  swingLineAngle,
  swingStrengthFraction,
  type SwingCoreEvidence,
  type SwingLevel,
} from "../src/lib/research-swing-core";
const bars = (n = 125): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2022, 0, i + 1)).toISOString().slice(0, 10),
    open: 99,
    high: 101,
    low: 98,
    close: 100,
    volume: 100,
    amount: 10000,
  }));
function fixture() {
  const b = bars();
  const p = analyzeBreakout(b, 0).points;
  const i = 120;
  b[i] = { ...b[i]!, open: 100, low: 99, close: 104, high: 105, volume: 150 };
  p[i] = {
    ...p[i]!,
    volume20: 100,
    volumeRatio: 1.5,
    missing: [],
    long: structuredClone(p[i]!.long),
  };
  p[i]!.long.checks = {
    trend: "是",
    level: "是",
    volume: "是",
    indicators: "是",
    candle: "否",
  };
  p[i]!.long.keyLevel = {
    price: 102,
    source: "swing-high",
    index: 110,
    confirmedAt: b[113]!.date,
  };
  p[i]!.long.line = {
    direction: "long",
    anchors: [
      {
        index: 100,
        date: b[100]!.date,
        confirmedAt: b[103]!.date,
        kind: "high",
        price: 110,
      },
      {
        index: 110,
        date: b[110]!.date,
        confirmedAt: b[113]!.date,
        kind: "high",
        price: 105,
      },
    ],
    slope: -0.5,
    touches: 3,
    confirmedAt: b[113]!.date,
    value: 100,
  };
  p[i]!.long.indicatorVotes = { MACD: "是", KDJ: "是", RSI: "是", BOLL: "否" };
  p[i]!.levels = [p[i]!.long.keyLevel!];
  return { b, p, i };
}
it("keeps current-20 and previous-20 volume denominators distinct at 1.5", () => {
  const { b, p, i } = fixture();
  expect(researchSwingCoreSeries("sw-double-prior20", b, p)[i]!.entry).toBe(
    true,
  );
  expect(researchSwingCoreSeries("sw-double-current20", b, p)[i]!.entry).toBe(
    false,
  );
  b[i]!.volume = 160;
  expect(researchSwingCoreSeries("sw-double-current20", b, p)[i]!.entry).toBe(
    true,
  );
});
it("counts four explicit votes, never diagnostic score or candle", () => {
  const { b, p, i } = fixture();
  const point = p[i]!;
  expect(swingStrengthFraction(point)).toBe(1);
  point.long.indicatorVotes.RSI = "否";
  point.long.score = 5;
  expect(researchSwingCoreSeries("sw-double-strength", b, p)[i]).toMatchObject({
    entry: true,
    entryFraction: 0.5,
  });
  point.long.indicatorVotes.KDJ = "否";
  expect(swingStrengthFraction(point)).toBe(0);
  point.long.indicatorVotes.BOLL = "未知";
  expect(researchSwingCoreSeries("sw-double-strength", b, p)[i]).toMatchObject({
    entry: false,
    reason: "四辅助指标未全可用",
  });
});
it("computes visual angles only with an explicit valid scale and includes endpoints", () => {
  const { b, p, i } = fixture();
  const line = p[i]!.long.line!;
  expect(swingLineAngle(line)).toBeNull();
  const scale = { mode: "linear" as const, pixelsPerPrice: 2, pixelsPerBar: 1 };
  expect(swingLineAngle(line, scale)).toBe(45);
  for (const degrees of [30, 45, 60]) {
    const slope = Math.tan((degrees * Math.PI) / 180);
    const l = { ...line, slope };
    expect(swingLineAngle(l, { ...scale, pixelsPerPrice: 1 })).toBeCloseTo(
      degrees,
    );
  }
  const evidence: SwingCoreEvidence[] = [
    {
      date: b[i]!.date,
      availableDate: b[i]!.date,
      source: "fixed chart",
      chart: scale,
    },
  ];
  expect(
    researchSwingCoreSeries("sw-line-angle-chart", b, p, undefined, evidence)[
      i
    ]!.entry,
  ).toBe(true);
  evidence[0]!.chart!.pixelsPerPrice = 0.01;
  expect(
    researchSwingCoreSeries("sw-line-angle-chart", b, p, undefined, evidence)[
      i
    ]!.entry,
  ).toBe(false);
  expect(
    researchSwingCoreSeries("sw-line-angle-chart", b, p)[i]!.reason,
  ).toContain("pixelsPerPrice");
  line.slope = -1.1;
  expect(researchSwingCoreSeries("sw-line-angle-percent", b, p)[i]!.entry).toBe(
    true,
  );
});
it.each(["sw-double-retest-next", "sw-weak-retest5"] as const)(
  "%s freezes candidate before first entry and cancels failed/late retests",
  (id) => {
    const { b, p, i } = fixture();
    if (id === "sw-weak-retest5") {
      p[i]!.long.checks.volume = "否";
      b[i]!.volume = 120;
    }
    b[i + 1] = {
      ...b[i + 1]!,
      open: 102,
      low: 102,
      high: 104,
      close: 103,
      volume: 150,
    };
    let s = researchSwingCoreSeries(id, b, p);
    expect(s[i]).toMatchObject({ entry: false, swing: { state: "candidate" } });
    expect(s[i + 1]).toMatchObject({
      entry: true,
      swing: { state: "confirmed", frozen: { level: { price: 102 } } },
    });
    b[i + 1]!.close = 101;
    b[i + 1]!.low = 100;
    s = researchSwingCoreSeries(id, b, p);
    expect(s[i + 1]!.entry).toBe(false);
    expect(s[i + 1]!.swing.state).toBe("cancelled");
  },
);
it("weak retest requires candidate-frozen volume and expires after five calendar sessions", () => {
  const { b, p, i } = fixture();
  p[i]!.long.checks.volume = "否";
  b[i + 1] = {
    ...b[i + 1]!,
    open: 103,
    low: 102,
    high: 105,
    close: 104,
    volume: 149,
  };
  expect(researchSwingCoreSeries("sw-weak-retest5", b, p)[i + 1]!.entry).toBe(
    false,
  );
  b[i + 1]!.volume = 150;
  expect(researchSwingCoreSeries("sw-weak-retest5", b, p)[i + 1]!.entry).toBe(
    true,
  );
  const calendar = b.map((v) => v.date);
  calendar.splice(i + 1, 0, "2022-05-01a");
  expect(
    researchSwingCoreSeries("sw-weak-retest5", b, p, calendar)[i + 1]!.swing
      .state,
  ).toBe("cancelled");
});
const level = (
  price: number,
  source: SwingLevel["source"],
  index = 5,
): SwingLevel => ({ price, source, index, confirmedAt: "2022-01-09" });
it("direction-specific six sources, strength priority and stable tie breaking", () => {
  const candidates = [
    level(120, "swing-high"),
    level(103, "platform-high"),
    level(101, "round"),
    level(102, "volume-bull-close"),
    level(104, "volume-bear-close"),
    level(105, "ma120"),
  ];
  expect(
    selectSwingLevel(candidates, 100, "2022-01-10", "long", "priority")!.price,
  ).toBe(120);
  expect(
    selectSwingLevel(candidates, 100, "2022-01-10", "long", "distance", false)!
      .price,
  ).toBe(101);
  expect(
    selectSwingLevel(candidates, 100, "2022-01-10", "long", "body")!.source,
  ).toBe("volume-bear-close");
  expect(
    selectSwingLevel(candidates, 110, "2022-01-10", "short", "body")!.source,
  ).toBe("volume-bull-close");
  expect(
    selectSwingLevel(
      [level(101, "ma20")],
      100,
      "2022-01-10",
      "long",
      "average",
    ),
  ).toBeNull();
  expect(
    selectSwingLevel(
      [level(101, "ma120")],
      110,
      "2022-01-10",
      "short",
      "average",
    ),
  ).toBeNull();
  expect(
    selectSwingLevel(candidates, 100, "2022-01-09", "long", "priority"),
  ).toBeNull();
});
it.each([
  ["sw-level-swing", "swing-high"],
  ["sw-level-platform", "platform-high"],
  ["sw-level-body", "volume-bear-close"],
  ["sw-level-round", "round"],
  ["sw-level-average", "ma60"],
] as const)(
  "%s has executable source-specific entry and rejection",
  (id, source) => {
    const { b, p, i } = fixture();
    p[i]!.levels = [level(102, source) as BreakoutPoint["levels"][number]];
    expect(researchSwingCoreSeries(id, b, p)[i]!.entry).toBe(true);
    p[i]!.levels[0]!.price = 105;
    b[i]!.close = 99;
    expect(researchSwingCoreSeries(id, b, p)[i]!.entry).toBe(false);
  },
);
it("gap edges disappear only after full fill; missing corporate proof blocks source combinations", () => {
  const b = bars(10);
  b[4] = { ...b[4]!, open: 104, close: 105, low: 103, high: 106 };
  for (let j = 5; j < 10; j++) b[j] = { ...b[4]!, date: b[j]!.date, low: 102 };
  expect(
    swingGapLevels(b, 8)
      .filter((l) => l.index === 4)
      .map((l) => l.price),
  ).toEqual([103, 101]);
  b[7]!.low = 101;
  expect(swingGapLevels(b, 8).filter((l) => l.index === 4)).toEqual([]);
  const f = fixture();
  for (const id of [
    "sw-level-gap",
    "sw-level-priority",
    "sw-level-distance",
    "sw-level-role-retest",
  ] as const)
    expect(researchSwingCoreSeries(id, f.b, f.p)[f.i]!.reason).toContain(
      "无公司行动证明",
    );
});
it("role change retains original source strength and waits for retest", () => {
  const { b, p, i } = fixture();
  const evidence = b.map((v) => ({
    date: v.date,
    availableDate: v.date,
    source: "corporate fixture",
    noActions: { start: b[0]!.date, end: v.date, complete: true },
  }));
  b[i + 1] = { ...b[i + 1]!, open: 102, close: 103, high: 104, low: 102 };
  const s = researchSwingCoreSeries(
    "sw-level-role-retest",
    b,
    p,
    undefined,
    evidence,
  );
  expect(s[i]).toMatchObject({
    entry: false,
    swing: { state: "candidate", sourceRank: 0 },
  });
  expect(s[i + 1]).toMatchObject({
    entry: true,
    swing: {
      state: "confirmed",
      sourceRank: 0,
      frozen: { date: b[i]!.date, level: { source: "swing-high" } },
    },
  });
});
it("gap-specific and source-priority variants execute on proved historical gaps and reject future proof", () => {
  const { b, p, i } = fixture();
  for (let j = i - 4; j < i; j++)
    b[j] = { ...b[j]!, open: 103, low: 103, close: 104, high: 105 };
  b[i] = { ...b[i]!, open: 104, low: 103, close: 106, high: 107 };
  // A downward historical gap above the previous close remains resistance.
  b[i - 6] = { ...b[i - 6]!, open: 110, low: 108, close: 109, high: 111 };
  b[i - 5] = { ...b[i - 5]!, open: 103, low: 102, close: 104, high: 105 };
  p[i]!.levels = [
    {
      price: 106,
      source: "swing-high",
      index: i - 10,
      confirmedAt: b[i - 7]!.date,
    },
  ];
  const e: SwingCoreEvidence[] = [
    {
      date: b[i]!.date,
      availableDate: b[i]!.date,
      source: "actions fixture",
      noActions: { start: b[0]!.date, end: b[i]!.date, complete: true },
    },
  ];
  expect(
    researchSwingCoreSeries("sw-level-gap", b, p, undefined, e)[i]!.entry,
  ).toBe(false);
  b[i]!.close = 109;
  b[i]!.high = 110;
  expect(
    researchSwingCoreSeries("sw-level-gap", b, p, undefined, e)[i]!.entry,
  ).toBe(true);
  expect(
    researchSwingCoreSeries("sw-level-priority", b, p, undefined, e)[i]!.swing
      .longLevel!.source,
  ).toBe("swing-high");
  e[0]!.availableDate = "2099-01-01";
  expect(
    researchSwingCoreSeries("sw-level-gap", b, p, undefined, e)[i]!.reason,
  ).toContain("待数据");
});

it.each([30, 60])(
  "angle filter includes %s degrees at floating point boundary",
  (degrees) => {
    const { b, p, i } = fixture();
    p[i]!.long.line!.slope = -Math.tan((degrees * Math.PI) / 180);
    const e: SwingCoreEvidence[] = [
      {
        date: b[i]!.date,
        availableDate: b[i]!.date,
        source: "linear fixture",
        chart: { mode: "linear", pixelsPerPrice: 1, pixelsPerBar: 1 },
      },
    ];
    expect(
      researchSwingCoreSeries("sw-line-angle-chart", b, p, undefined, e)[i]!
        .entry,
    ).toBe(true);
  },
);
