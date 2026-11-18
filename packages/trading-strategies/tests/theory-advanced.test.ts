import { expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  createTheoryAdvancedRule,
  theoryAdvancedIds,
} from "../src/theory-advanced.js";
const empty = { entry: 0, entryIndex: 0 };
function path(nodes: [number, number][], length = 170): Bar[] {
  return Array.from({ length }, (_, i) => {
    const right = nodes.findIndex((n) => n[0] >= i);
    let value = nodes[0]![1];
    if (right < 0) value = nodes.at(-1)![1];
    else if (right > 0) {
      const [a, x] = nodes[right - 1]!,
        [b, y] = nodes[right]!;
      value = x + ((y - x) * (i - a)) / (b - a);
    }
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: value,
      high: value + 0.2,
      low: value - 0.2,
      close: value,
      volume: 1000,
      amount: value * 1000,
    };
  });
}
const signal = (id: string, bars: Bar[], i: number) =>
  createTheoryAdvancedRule(id, bars)!(i, empty).enter;
const fixtures: [string, [number, number][], number][] = [
  [
    "theory-head-shoulders-bottom",
    [
      [0, 110],
      [60, 110],
      [75, 100],
      [85, 110],
      [95, 90],
      [105, 110],
      [115, 101],
      [118, 105],
      [120, 112],
    ],
    120,
  ],
  [
    "theory-falling-wedge",
    [
      [0, 110],
      [60, 110],
      [70, 120],
      [80, 100],
      [90, 112],
      [100, 96],
      [103, 100],
      [106, 108],
    ],
    106,
  ],
  [
    "theory-cup-handle",
    [
      [0, 90],
      [50, 90],
      [70, 120],
      [85, 95],
      [100, 96],
      [110, 120],
      [120, 114],
      [123, 117],
      [125, 120],
      [126, 123],
    ],
    126,
  ],
  [
    "theory-obv-divergence",
    [
      [0, 100],
      [60, 100],
      [70, 105],
      [80, 90],
      [90, 110],
      [100, 88],
      [103, 95],
      [106, 112],
    ],
    106,
  ],
];
it.each(fixtures)(
  "%s confirms only after visible pivots and neckline break",
  (id, nodes, index) => {
    const bars = path(nodes);
    if (id === "theory-obv-divergence")
      for (let i = 81; i <= 100; i++) bars[i]!.volume = i <= 90 ? 5000 : 100;
    expect(signal(id, bars, index), id).toBe(true);
    // A close below the already fixed neckline cannot be reported as a breakout.
    const failed = structuredClone(bars);
    failed[index]!.close = failed[index - 1]!.close;
    failed[index]!.open = failed[index]!.close;
    failed[index]!.low = Math.min(
      failed[index]!.low,
      failed[index]!.close - 0.2,
    );
    expect(signal(id, failed, index)).toBe(false);
    expect(signal(id, bars, index - 4)).toBe(false);
  },
);
it.each(["theory-month-anchor-reclaim", "theory-rolling-vwap-reclaim"])(
  "%s uses only completed price-volume observations",
  (id) => {
    const bars = path([
      [0, 90],
      [90, 130],
      [99, 118],
      [100, 131],
      [169, 131],
    ]);
    expect(signal(id, bars, 100)).toBe(true);
    const failed = structuredClone(bars);
    Object.assign(failed[100]!, { open: 117, close: 117, high: 118, low: 116 });
    expect(signal(id, failed, 100)).toBe(false);
  },
);
it.each(theoryAdvancedIds)(
  "%s keeps full-history and prefix decisions identical and times out actual holdings",
  (id) => {
    const bars = path([
      [0, 100],
      [70, 110],
      [80, 100],
      [90, 108],
      [100, 95],
      [110, 120],
      [125, 112],
      [140, 125],
    ]);
    const rule = createTheoryAdvancedRule(id, bars)!;
    for (let i = 70; i < 160; i++)
      expect(rule(i, empty)).toEqual(
        createTheoryAdvancedRule(id, bars.slice(0, i + 1))!(i, empty),
      );
    expect(
      rule(160, { entry: 110, entryIndex: 110, signalIndex: 109 }).exit,
    ).toBe(true);
    expect(rule(160, empty).exit).toBe(false);
  },
);
it("rejects missing volume rather than manufacturing a weighted price", () => {
  const bars = path([
    [0, 90],
    [90, 130],
    [99, 118],
    [100, 131],
  ]);
  bars[95]!.volume = 0;
  expect(signal("theory-rolling-vwap-reclaim", bars, 100)).toBe(false);
});
