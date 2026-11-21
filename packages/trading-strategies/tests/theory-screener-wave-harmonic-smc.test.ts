import { expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  createWaveHarmonicSmcFamilyScreener as prepare,
  waveHarmonicSmcSpecs as specs,
} from "../src/screener/wave-harmonic-smc.js";

type Candle = [open: number, high: number, low: number, close: number];
function history(changes: Record<number, Candle>, trend = false): Bar[] {
  return Array.from({ length: 81 }, (_, i) => {
    const mid = trend ? 86 + i * 0.2 : 100;
    const [open, high, low, close] = changes[i] ?? [mid, mid + 1, mid - 1, mid];
    return {
      open,
      high,
      low,
      close,
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      amount: 10000,
      volume: i === 80 ? 150 : 100,
    };
  });
}
const turn: Candle = [101, 105, 100, 104];
const fixtures: {
  name: string;
  method: number;
  bars: Bar[];
  pivot: number;
  stop?: number;
  target?: number;
}[] = [
  {
    name: "hammer",
    method: 0,
    bars: history({ 79: [100, 101, 95, 100.8], 80: turn }),
    pivot: 101,
    stop: 94.05,
  },
  {
    name: "engulfing",
    method: 0,
    bars: history({
      76: [103, 104, 102, 103],
      77: [102, 103, 100, 101],
      78: [101, 102, 98, 99],
      79: [98.5, 102, 98, 101.5],
      80: turn,
    }),
    pivot: 102,
    stop: 97.02,
  },
  {
    name: "morning star",
    method: 0,
    bars: history({
      78: [103, 104, 98, 99],
      79: [99, 100, 98.8, 99],
      80: turn,
    }),
    pivot: 100,
  },
  {
    name: "rising three",
    method: 1,
    bars: history({ 77: [99, 105, 98, 104], 80: [103, 107, 102, 106] }, true),
    pivot: 105,
    stop: 98,
  },
  {
    name: "gap",
    method: 1,
    bars: history({ 79: [105, 106, 104, 105], 80: [106, 108, 105, 107] }, true),
    pivot: 106,
  },
  {
    name: "H1",
    method: 2,
    bars: history(
      {
        77: [104, 106, 103, 105],
        78: [103, 105, 102, 104],
        79: [102, 104, 101, 103],
        80: [103, 106, 102, 105],
      },
      true,
    ),
    pivot: 104,
  },
  {
    name: "H2",
    method: 2,
    bars: history(
      {
        75: [104, 106, 103, 105],
        76: [103, 105, 102, 104],
        77: [104, 107, 103, 106],
        78: [103, 105, 102, 104],
        79: [102, 104, 101, 103],
        80: [103, 106, 102, 105],
      },
      true,
    ),
    pivot: 104,
  },
  {
    name: "one-box breakout",
    method: 3,
    bars: history({
      75: [101, 106, 100, 105],
      76: [104, 105, 99, 100],
      77: [100, 106, 100, 104],
      78: [104, 106, 103, 105],
      79: [105, 106, 104, 105],
      80: [106, 107.5, 105, 107],
    }),
    pivot: 106,
    stop: 101.5,
  },
  {
    name: "wave three",
    method: 4,
    bars: history({
      63: [100, 101, 90, 100],
      68: [100, 110, 99, 100],
      73: [100, 101, 98, 100],
      80: [101, 112, 100, 111],
    }),
    pivot: 110,
    stop: 98,
    target: 130.36,
  },
  {
    name: "golden pocket",
    method: 5,
    bars: history({
      63: [100, 101, 90, 100],
      68: [100, 110, 99, 100],
      79: [100, 101, 99, 100],
      80: turn,
    }),
    pivot: 100,
    stop: 97.64 * 0.99,
    target: 115.44,
  },
  {
    name: "Gartley local D",
    method: 6,
    bars: history({
      55: [100, 101, 90, 100],
      60: [100, 110, 99, 100],
      65: [100, 101, 98, 100],
      70: [100, 106, 99, 100],
      79: [96, 98, 94, 96],
      80: turn,
    }),
    pivot: 98,
    stop: 94 * 0.98,
  },
  {
    name: "fair value gap",
    method: 7,
    bars: history({
      74: [104, 109, 103, 108],
      75: [107, 109, 106, 108],
      76: [107, 109, 106, 108],
      77: [107, 109, 106, 108],
      78: [107, 109, 106, 108],
      79: [104, 105, 102, 104],
      80: [105, 108, 104, 107],
    }),
    pivot: 105,
    stop: 101 * 0.985,
  },
  {
    name: "order block",
    method: 7,
    bars: history({
      73: [100, 101, 96, 98],
      74: [100, 108, 99, 107],
      79: [99, 100, 98, 99],
      80: turn,
    }),
    pivot: 100,
    stop: 96 * 0.985,
  },
];
it.each(fixtures)(
  "recognizes $name only from available bars",
  ({ method, bars, pivot, stop, target, name }) => {
    const at = (input: Bar[]) =>
      prepare({ bars: input })
        .at(80)
        .find((m) => m.methodId === specs[method]!.id);
    const m = at(bars);
    expect(m).toBeDefined();
    expect(m!.pivotPrice).toBeCloseTo(pivot);
    if (stop !== undefined) expect(m!.stopPrice).toBeCloseTo(stop);
    if (target !== undefined) expect(m!.targetPrice).toBeCloseTo(target);
    expect(m!.rewardMultiple).toBeGreaterThan(0);
    expect(m!.volumeRatio).toBe(1.5);
    expect(m!.score).toBeGreaterThanOrEqual(1);
    expect(m!.score).toBeLessThanOrEqual(5);
    if (name === "H1" || name === "H2") expect(m!.summary).toContain(name);
    expect(
      m!.geometry.lines.every(
        (l) => l.points.length >= 2 && l.points.every((p) => p.index <= 80),
      ),
    ).toBe(true);
    expect(
      at([
        ...bars,
        ...history({})
          .slice(0, 10)
          .map((b, i) => ({
            ...b,
            date: `2021-01-${String(i + 1).padStart(2, "0")}`,
          })),
      ]),
    ).toEqual(m);
  },
);
it("exposes all methods on empty history and rejects flat or unavailable signals", () => {
  expect(prepare({ bars: [] }).specs).toBe(specs);
  expect(new Set(specs.map((s) => s.id)).size).toBe(8);
  expect(prepare({ bars: [] }).at(0)).toEqual([]);
  const flat = prepare({ bars: history({}) });
  for (const i of [-1, 24, 80, 81]) expect(flat.at(i)).toEqual([]);
});
it("rejects a filled imbalance and an Elliott breakout beyond the extension target", () => {
  const gap = fixtures.find((f) => f.name === "fair value gap")!;
  const bars = gap.bars.map((b, i) => (i === 76 ? { ...b, low: 98 } : b));
  expect(
    prepare({ bars })
      .at(80)
      .some((m) => m.theoryId === "F06.09"),
  ).toBe(false);
  const rally = fixtures
    .find((f) => f.method === 4)!
    .bars.map((b, i) => (i === 80 ? { ...b, high: 140, close: 139 } : b));
  expect(
    prepare({ bars: rally })
      .at(80)
      .some((m) => m.theoryId === "F06.01"),
  ).toBe(false);
});

it("does not repeat a point-and-figure breakout as the same X column extends", () => {
  const bars = fixtures.find((f) => f.method === 3)!.bars;
  const next = { ...bars[80]!, date: "2020-03-22", high: 110, close: 109 };
  expect(
    prepare({ bars: [...bars, next] })
      .at(81)
      .some((m) => m.theoryId === "F05.13"),
  ).toBe(false);
});
it.each([
  ["Bat", 99, 92.4, 106],
  ["蝶形或螃蟹", 98, 84, 106],
  ["ABCD", 98, 96, 108],
] as const)("recognizes %s from a confirmed D", (name, B, D, C) => {
  const bars = history({
    55: [100, 101, 90, 100],
    60: [100, 110, 99, 100],
    ...Object.fromEntries(
      [62, 63, 64, 66, 67, 68].map((i) => [i, [100, 101, 99.5, 100] as Candle]),
    ),
    65: [100, 101, B, 100],
    70: [100, C, 99, 100],
    77: [100, 101, D, 100],
    80: turn,
  });
  const match = prepare({ bars })
    .at(80)
    .find((m) => m.theoryId === "F06.08");
  expect(match?.summary).toContain(name);
  expect(match?.geometry.lines[0]?.points.map((p) => p.index)).toEqual([
    55, 60, 65, 70, 77, 80,
  ]);
});
