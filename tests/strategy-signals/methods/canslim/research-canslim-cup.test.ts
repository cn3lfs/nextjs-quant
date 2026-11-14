import { researchFormulaRuntime } from "~/lib/research/technical/research-formula-runtime";
import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import {
  canslimCupIds,
  canslimCupShape,
} from "trading-strategies/research/canslim/research-canslim-strategies";
import { researchCanslimCupPoint } from "trading-strategies/research/canslim/research-canslim-cup";
import { researchCanslimPriorityPoint } from "trading-strategies/research/canslim/research-canslim-priority";
import { canslimCup } from "trading-strategies/research/canslim/canslim-cup";
import { researchRuleSeries } from "trading-strategies/research/composition/research-rule-series";

function fixture(shape: "U" | "W" | "V"): Bar[] {
  return Array.from({ length: 138 }, (_, index) => {
    const i = index - 70;
    let high =
      i < 0
        ? 95
        : i < 4
          ? 97 + i
          : i <= 43
            ? 80 + 20 * ((i - 23) / 20) ** 2
            : i < 50
              ? 98
              : 103;
    if (shape === "W" && i >= 4 && i <= 43) {
      const knots = [
        [3, 100],
        [13, 80],
        [23, 92],
        [33, 80],
        [43, 100],
      ] as const;
      const right = knots.findIndex(([j]) => j >= i),
        a = knots[right - 1]!,
        b = knots[right]!;
      high = a[1] + ((b[1] - a[1]) * (i - a[0])) / (b[0] - a[0]);
    }
    if (shape === "V" && i >= 4 && i <= 43)
      high = i === 23 ? 80 : 95 + 5 * ((i - 23) / 20) ** 2;
    return {
      date: new Date(Date.UTC(2024, 0, index + 1)).toISOString().slice(0, 10),
      high,
      low: i > 50 ? 101 : i > 43 && i < 50 ? 95 : high - 1,
      open: high - 0.5,
      close: high - 0.2,
      volume: i <= 43 ? 100 : i < 50 ? 50 - (i - 44) * 5 : 200,
      amount: 1000000,
    };
  });
}
it("total scoring accepts six, rejects five, and records failed strict conditions", () => {
  const bars = fixture("V").slice(0, 121);
  for (const bar of bars.slice(114, 120)) bar.volume = 100;
  const six = researchCanslimCupPoint("U", bars, "score-total");
  expect(six).toMatchObject({
    entry: true,
    qualification: "five-part-total-at-least-six",
    candidate: {
      shape: "V",
      points: 6,
      scoreComponents: {
        shape: 1,
        depth: 2,
        handle: 2,
        volume: 0,
        duration: 1,
      },
      hardChecks: {
        recognizedShape: false,
        contracting: false,
        volumeBelow80: false,
      },
    },
  });
  expect(researchCanslimCupPoint("V", bars).entry).toBe(false);
  const scaled = bars.map((bar) => ({ ...bar, volume: bar.volume * 1e305 }));
  expect(researchCanslimCupPoint("U", scaled, "score-total")).toMatchObject({
    entry: true,
    candidate: { points: 6, scoreComponents: six.candidate!.scoreComponents },
  });
  bars[118]!.low = 92;
  expect(researchCanslimCupPoint("U", bars, "score-total").entry).toBe(false);
  const snapshot = {
    id: "fixture",
    hash: "fixture",
    symbol: "sh600000",
    source: "fixture",
    createdAt: 0,
    period: "day" as const,
    adjustment: "none" as const,
    bars,
  };
  const result = canslimCup(
    snapshot,
    Date.parse(`${bars[120]!.date}T07:06:00Z`),
    "score-total",
  );
  if (!result.applicable) throw Error("invalid fixture");
  expect(result.version).toBe("canslim-cup-score-total-1");
  expect(result.candidates[0]).toMatchObject({
    points: 5,
    qualified: false,
    scoreComponents: { handle: 1 },
  });
});

it("total scoring keeps 60 and 80 percent volume boundaries strictly below", () => {
  for (const [volume, points] of [
    [59.99, 2],
    [60, 1],
    [79.99, 1],
    [80, 0],
  ] as const) {
    const bars = fixture("U").slice(0, 121);
    for (const bar of bars.slice(114, 120)) bar.volume = volume;
    const candidate = researchCanslimCupPoint(
      "U",
      bars,
      "score-total",
    ).candidate;
    expect(candidate).toMatchObject({
      scoreComponents: { volume: points },
      points: 8 + points,
    });
  }
});

it("an unclassified bottom can score zero without bypassing upper-half geometry", () => {
  const bars = fixture("V").slice(0, 121);
  for (let i = 91; i <= 95; i++)
    Object.assign(bars[i]!, { high: 80, low: 79, open: 79.5, close: 79.8 });
  expect(researchCanslimCupPoint("U", bars, "score-total")).toMatchObject({
    entry: true,
    candidate: {
      shape: "unclassified",
      scoreComponents: { shape: 0 },
      points: 7,
    },
  });
  bars[118]!.low = 89.5;
  expect(researchCanslimCupPoint("U", bars, "score-total").entry).toBe(false);
});

it.each(["U", "W"] as const)(
  "%s right-rim rule accepts inclusive 95/100 percent and rejects higher rims before entry",
  (shape) => {
    const withRight = (right: number) => {
      const bars = fixture(shape);
      for (let i = 104; i <= 113; i++) {
        const high = bars[i]!.high + ((right - 100) * (i - 103)) / 10;
        Object.assign(bars[i]!, {
          high,
          low: high - 1,
          open: high - 0.5,
          close: high - 0.2,
        });
      }
      for (let i = 114; i <= 119; i++)
        Object.assign(bars[i]!, {
          high: right - 2,
          low: right - 5,
          open: right - 2.5,
          close: right - 2.2,
        });
      for (let i = 120; i < bars.length; i++)
        Object.assign(bars[i]!, {
          high: right * 1.03,
          low: right * (i === 120 ? 0.99 : 1.01),
          open: right * 1.02,
          close: right * 1.028,
        });
      return bars;
    };
    for (const [right, allowed] of [
      [94.99, false],
      [95, true],
      [100, true],
      [100.01, false],
      [105, false],
      [105.01, false],
    ] as const) {
      const bars = withRight(right);
      const prefix = bars.slice(0, 121);
      const base = researchCanslimCupPoint(shape, prefix);
      expect(base).toEqual(
        researchCanslimCupPoint(shape, prefix, "strict", "symmetric"),
      );
      if (right >= 95 && right <= 105) expect(base.entry).toBe(true);
      const restricted = researchCanslimCupPoint(
        shape,
        prefix,
        "strict",
        "not-higher",
      );
      expect(restricted.entry).toBe(allowed);
      expect(restricted.rimRule).toBe("right-not-higher-than-left");
      const direct =
        shape === "U"
          ? "canslim-cup-u-right-not-higher"
          : "canslim-cup-w-right-not-higher";
      const held =
        shape === "U"
          ? "canslim-cup-u-right-not-higher-hold3"
          : "canslim-cup-w-right-not-higher-hold3";
      for (const strategy of [direct, held] as const) {
        const points = researchRuleSeries(
          strategy,
          bars,
          undefined,
          undefined,
          undefined,
          researchFormulaRuntime,
        );
        const index = strategy.endsWith("-hold3") ? 123 : 120;
        expect(points.filter((p) => p.entry).map((p) => p.date)).toEqual(
          allowed ? [bars[index]!.date] : [],
        );
        if (allowed)
          expect(points[index]).toMatchObject({
            candidate: { pivot: right },
            historyStart: bars[70]!.date,
          });
        expect(
          researchRuleSeries(
            strategy,
            bars.slice(0, index + 1),
            undefined,
            undefined,
            undefined,
            researchFormulaRuntime,
          ),
        ).toEqual(points.slice(0, index + 1));
      }
    }
  },
);

it.each(["U", "W", "V"] as const)(
  "priority scoring combines disjoint two/one-point %s handles with frozen confirmation",
  (shape) => {
    for (const grade of [1, 2]) {
      const bars = fixture(shape);
      if (grade === 1)
        for (let i = 114; i < 120; i++)
          Object.assign(bars[i]!, { low: 92, volume: 30 });
      const prefix = bars.slice(0, 121);
      const strict = researchCanslimPriorityPoint(prefix);
      expect(strict).toEqual(researchCanslimPriorityPoint(prefix, "strict"));
      const scored = researchCanslimPriorityPoint(prefix, "scored-handles");
      expect(scored).toMatchObject({
        entry: true,
        historyStart: bars[0]!.date,
        candidate: {
          family: "cup",
          shape,
          high: 100,
          handleQualification: grade === 1 ? "steady-half" : "shrinking-third",
        },
      });
      if (shape === "V" || grade === 1)
        expect(strict.candidate?.family).not.toBe("cup");
      for (const strategy of [
        "canslim-priority-scored-handles",
        "canslim-priority-scored-handles-hold3",
      ] as const) {
        const points = researchRuleSeries(
          strategy,
          bars,
          undefined,
          undefined,
          undefined,
          researchFormulaRuntime,
        );
        const date = strategy.endsWith("-hold3") ? 123 : 120;
        expect(points.filter((p) => p.entry).map((p) => p.date)).toEqual([
          bars[date]!.date,
        ]);
        expect(points[date]).toMatchObject({
          historyStart: bars[0]!.date,
          candidate: scored.candidate,
        });
        expect(
          researchRuleSeries(
            strategy,
            bars.slice(0, date + 1),
            undefined,
            undefined,
            undefined,
            researchFormulaRuntime,
          ),
        ).toEqual(points.slice(0, date + 1));
      }
      prefix[120]!.close = 100.5;
      prefix[120]!.low = 100;
      expect(
        researchCanslimPriorityPoint(prefix, "scored-handles"),
      ).toMatchObject({ entry: false, candidate: { family: "cup", shape } });
    }
  },
);

it("scoring priority retains handle and volume gates even with a passing total", () => {
  const bars = fixture("V").slice(0, 121);
  bars[118]!.low = 92;
  expect(
    researchCanslimPriorityPoint(bars, "scored-handles").candidate?.family,
  ).not.toBe("cup");
  for (let i = 114; i < 120; i++)
    Object.assign(bars[i]!, { low: 92, volume: 30 });
  expect(researchCanslimPriorityPoint(bars, "scored-handles").entry).toBe(true);
  bars[120]!.volume = 1;
  expect(researchCanslimPriorityPoint(bars, "scored-handles")).toMatchObject({
    entry: false,
    candidate: { family: "cup" },
  });
});
it("V scoring uses the same geometric calculation while strict reports keep rejecting V", () => {
  const bars = fixture("V").slice(0, 121);
  const snapshot = {
    id: "fixture",
    hash: "fixture",
    symbol: "sh600000",
    source: "fixture",
    createdAt: 0,
    period: "day" as const,
    adjustment: "none" as const,
    bars,
  };
  const cutoff = Date.parse(`${bars.at(-1)!.date}T07:06:00Z`);
  const strict = canslimCup(snapshot, cutoff);
  const scoring = canslimCup(snapshot, cutoff, "v-score");
  expect(strict).toEqual(canslimCup(snapshot, cutoff, "strict"));
  if (!strict.applicable || !scoring.applicable) throw Error("invalid fixture");
  expect(strict.version).toBe("canslim-cup-2");
  expect(scoring.version).toBe("canslim-cup-v-score-1");
  expect(strict.candidates[0]).toMatchObject({
    shape: "V",
    points: 8,
    qualified: false,
  });
  expect(scoring.candidates[0]).toEqual({
    ...strict.candidates[0],
    qualified: true,
  });
  expect(researchCanslimCupPoint("V", bars)).toMatchObject({
    entry: true,
    qualification: "v-score-with-strict-handle",
    historyStart: bars[70]!.date,
    candidate: { shape: "V", points: 8 },
  });
  for (const shape of ["U", "W"] as const)
    expect(researchCanslimCupPoint(shape, bars).entry).toBe(false);
});

it("V's passing total score cannot bypass the strict handle-depth limit", () => {
  const bars = fixture("V").slice(0, 121);
  bars[118]!.low = 92;
  const result = canslimCup(
    {
      id: "fixture",
      hash: "fixture",
      symbol: "sh600000",
      period: "day",
      adjustment: "none",
      bars,
    },
    Date.parse(`${bars.at(-1)!.date}T07:06:00Z`),
    "v-score",
  );
  if (!result.applicable) throw Error("invalid fixture");
  expect(result.candidates[0]).toMatchObject({
    shape: "V",
    points: 7,
    qualified: false,
  });
  expect(researchCanslimCupPoint("V", bars)).toMatchObject({
    entry: false,
    reason: null,
  });
});

it.each(["U", "W", "V"] as const)(
  "%s grade-one handles retain total score and do not alter strict qualification",
  (shape) => {
    const bars = fixture(shape).slice(0, 121);
    for (const bar of bars.slice(114, 120))
      Object.assign(bar, { low: 92, volume: 30 });
    const point = researchCanslimCupPoint(shape, bars, "half-handle");
    expect(point).toMatchObject({
      entry: true,
      qualification: "half-handle-score-1",
      historyStart: bars[70]!.date,
      candidate: {
        handlePoints: 1,
        steady: true,
        handleHalfVolumeRatio: 1,
        points: shape === "U" ? 9 : shape === "W" ? 8 : 7,
      },
    });
    expect(researchCanslimCupPoint(shape, bars).entry).toBe(false);
  },
);

it("grade-one volume stability uses inclusive 90/110 percent boundaries and respects grade-two priority", () => {
  const bars = fixture("U").slice(0, 121);
  for (const bar of bars.slice(114, 120))
    Object.assign(bar, { low: 92, volume: 30 });
  for (const [second, expected] of [
    [26.9, false],
    [27, true],
    [30, true],
    [33, true],
    [33.1, false],
  ] as const) {
    for (const bar of bars.slice(117, 120)) bar.volume = second;
    expect(researchCanslimCupPoint("U", bars, "half-handle").entry).toBe(
      expected,
    );
  }
  for (const bar of bars.slice(114, 120))
    Object.assign(bar, { low: 95, volume: 30 });
  expect(researchCanslimCupPoint("U", bars, "half-handle").entry).toBe(true);
  for (const bar of bars.slice(117, 120)) bar.volume = 27;
  expect(researchCanslimCupPoint("U", bars, "half-handle").entry).toBe(false);
  expect(researchCanslimCupPoint("U", bars).entry).toBe(true);
});

it("half-depth equality is allowed when upper-half positioning independently passes", () => {
  const bars = fixture("U").slice(0, 121);
  for (let i = 70; i <= 113; i++) {
    const high =
      i < 74 ? 125 + i - 70 : i === 113 ? 132 : 97 + 31 * ((i - 93) / 20) ** 2;
    Object.assign(bars[i]!, {
      high,
      low: high - 1,
      open: high - 0.5,
      close: high - 0.2,
    });
  }
  for (const bar of bars.slice(114, 120))
    Object.assign(bar, {
      high: 130,
      low: 115.5,
      open: 129.5,
      close: 129.8,
      volume: 30,
    });
  Object.assign(bars[120]!, { high: 136, low: 134, open: 135.5, close: 135.8 });
  expect(researchCanslimCupPoint("U", bars, "half-handle")).toMatchObject({
    entry: true,
    candidate: {
      depthPercent: 25,
      handlePullbackPercent: 12.5,
      upperHalf: true,
    },
  });
  bars[118]!.low = 115.49;
  expect(researchCanslimCupPoint("U", bars, "half-handle").entry).toBe(false);
  expect(researchCanslimCupPoint("U", bars, "score-total")).toMatchObject({
    entry: true,
    candidate: {
      points: 8,
      scoreComponents: { handle: 0 },
      hardChecks: { upperHalf: true, handleThird: false },
    },
  });
});
function setup(strategy: (typeof canslimCupIds)[number]) {
  const bars = fixture(canslimCupShape(strategy));
  if (strategy.includes("-half-handle"))
    for (const bar of bars.slice(114, 120))
      Object.assign(bar, { low: 92, volume: 30 });
  return { bars };
}

it.each(["U", "W"] as const)(
  "%s preserves confirmed rims, shape and the left rim's earlier peers",
  (shape) => {
    const bars = fixture(shape);
    const point = researchCanslimCupPoint(shape, bars.slice(0, 121));
    expect(point).toMatchObject({
      entry: true,
      historyStart: bars[70]!.date,
      maxEntryPrice: 105,
      candidate: {
        shape,
        pivot: 100,
        high: 100,
        duration: 40,
        handleLength: 6,
        left: bars[73]!.date,
        right: bars[113]!.date,
        rightConfirmedAt: bars[116]!.date,
        points: shape === "U" ? 10 : 9,
      },
    });
    expect(
      researchCanslimCupPoint(shape === "U" ? "W" : "U", bars.slice(0, 121))
        .entry,
    ).toBe(false);
    expect(researchCanslimCupPoint(shape, bars.slice(0, 120)).entry).toBe(
      false,
    );
    const id = shape === "U" ? "canslim-cup-u" : "canslim-cup-w";
    const points = researchRuleSeries(
      id,
      bars,
      undefined,
      undefined,
      undefined,
      researchFormulaRuntime,
    );
    const future = structuredClone(bars);
    future[128]!.high = 1000;
    expect(
      researchRuleSeries(
        id,
        future,
        undefined,
        undefined,
        undefined,
        researchFormulaRuntime,
      ).slice(0, 128),
    ).toEqual(points.slice(0, 128));
  },
);

it("does not impose a new upper bound on the handle or truncate an older valid cup", () => {
  const input = fixture("U");
  const long = [
    ...input.slice(0, 120),
    ...Array.from({ length: 200 }, (_, i) => ({
      ...input[119]!,
      volume: 30 - i / 20,
    })),
    input[120]!,
  ].map((b, i) => ({
    ...b,
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
  }));
  expect(researchCanslimCupPoint("U", long)).toMatchObject({
    entry: true,
    historyStart: long[70]!.date,
    candidate: { duration: 40, handleLength: 206 },
  });
});

it("rejects deep handles, missing volume and prices outside the breakout interval", () => {
  for (const mode of [
    "deep",
    "zero",
    "low-volume",
    "early-price",
    "late-price",
  ]) {
    const bars = fixture("U").slice(0, 121);
    if (mode === "deep") bars[118]!.low = 80;
    if (mode === "zero") bars[120]!.volume = 0;
    if (mode === "low-volume") bars[120]!.volume = 1;
    if (mode === "early-price")
      Object.assign(bars[120]!, { close: 101, low: 100 });
    if (mode === "late-price")
      Object.assign(bars[120]!, { close: 106, high: 106 });
    expect(researchCanslimCupPoint("U", bars).entry).toBe(false);
  }
});

it.each([
  "canslim-cup-u-hold3",
  "canslim-cup-w-hold3",
  "canslim-cup-v-score-hold3",
  "canslim-cup-u-half-handle-hold3",
  "canslim-cup-w-half-handle-hold3",
  "canslim-cup-v-half-handle-hold3",
] as const)(
  "%s freezes the original historical window through three-day confirmation",
  (id) => {
    const bars = setup(id).bars,
      calendar = bars.map((b) => b.date);
    const run = (input = bars) =>
      researchRuleSeries(
        id,
        input,
        calendar,
        undefined,
        undefined,
        researchFormulaRuntime,
      );
    const points = run();
    expect(points.filter((p) => p.entry).map((p) => p.date)).toEqual([
      bars[123]!.date,
    ]);
    expect(points[123]).toMatchObject({
      historyStart: bars[70]!.date,
      hold: {
        breakoutDate: bars[120]!.date,
        confirmationDate: bars[123]!.date,
      },
      candidate: { left: bars[73]!.date, pivot: 100 },
    });
    expect(run(bars.filter((_, i) => i !== 122)).some((p) => p.entry)).toBe(
      false,
    );
    bars[122]!.low = 99.99;
    expect(run().some((p) => p.entry)).toBe(false);
  },
);

it("120-bar variants require the complete window, reuse geometry and ignore older bars", () => {
  for (const shape of ["U", "W"] as const) {
    const id =
      shape === "U" ? "canslim-cup-u-window120" : "canslim-cup-w-window120";
    const bars = fixture(shape);
    const points = researchRuleSeries(
      id,
      bars,
      undefined,
      undefined,
      undefined,
      researchFormulaRuntime,
    );
    expect(points.slice(0, 119).every((p) => !p.entry)).toBe(true);
    expect(points[120]).toMatchObject({ entry: true, candidate: { shape } });
    expect(points[120]).toEqual(
      researchCanslimCupPoint(shape, bars.slice(1, 121)),
    );
    expect(
      researchRuleSeries(
        id,
        bars.slice(0, 121),
        undefined,
        undefined,
        undefined,
        researchFormulaRuntime,
      ),
    ).toEqual(points.slice(0, 121));
    const changed = structuredClone(bars);
    changed[0]!.high = 99999;
    expect(
      researchRuleSeries(
        id,
        changed,
        undefined,
        undefined,
        undefined,
        researchFormulaRuntime,
      )[120],
    ).toEqual(points[120]);
    const short = bars.slice(2, 121);
    expect(
      researchRuleSeries(
        id,
        short,
        undefined,
        undefined,
        undefined,
        researchFormulaRuntime,
      ).at(-1),
    ).toMatchObject({
      entry: false,
      reason: "120根观察窗口未满",
    });
    const noVolume = structuredClone(bars);
    noVolume[120]!.volume = 1;
    expect(
      researchRuleSeries(
        id,
        noVolume,
        undefined,
        undefined,
        undefined,
        researchFormulaRuntime,
      )[120]!.entry,
    ).toBe(false);
  }
});
