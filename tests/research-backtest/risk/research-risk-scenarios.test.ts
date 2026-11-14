import { expect, it } from "vitest";
import { crowdedStop } from "trading-strategies/research/risk/research-risk-scenarios";
import { analyzeBreakout } from "trading-strategies/research/breakout/breakout";
const bars = Array.from({ length: 100 }, (_, i) => ({
  date: new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
  open: 100,
  close: 100,
  high: 101,
  low: 99,
  volume: 100000,
  amount: 10000000,
}));
const dates = bars.map((b) => b.date);
it.each(["round", "swing-low", "trend"] as const)(
  "%s preserves raw, .3 and .5 ATR cases and rejects future confirmation",
  (anchor) => {
    const point = analyzeBreakout(bars.slice(0, 66)).latest!;
    point.levels = [
      { price: 98, source: "round", index: 64, confirmedAt: dates[64]! },
      { price: 97, source: "swing-low", index: 60, confirmedAt: dates[63]! },
    ];
    const a = {
      index: 40,
      date: dates[40]!,
      confirmedAt: dates[43]!,
      price: 98,
      kind: "high" as const,
    };
    point.long.line = {
      direction: "long",
      anchors: [a, { ...a, index: 50, date: dates[50]! }],
      touches: 3,
      slope: 0,
      value: 96,
      confirmedAt: dates[53]!,
    };
    const raw = anchor === "round" ? 98 : anchor === "swing-low" ? 97 : 96;
    for (const multiple of [0, 0.3, 0.5] as const)
      expect(crowdedStop(point, anchor, 2, multiple)!.price).toBe(
        raw - 2 * multiple,
      );
    point.levels.forEach((l) => (l.confirmedAt = dates[99]!));
    point.long.line.confirmedAt = dates[99]!;
    expect(crowdedStop(point, anchor, 2, 0.3)).toBeNull();
  },
);
