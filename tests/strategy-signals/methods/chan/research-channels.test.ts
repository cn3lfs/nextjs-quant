import { channelIds } from "trading-strategies/research/technical/research-channels";
import { expect, it } from "vitest";
import type { Bar } from "../../../../src/lib/domain";
import { priceChannel } from "../../../../src/lib/indicators";
import {
  researchChannelSeries,
  type ChannelId,
} from "trading-strategies/research/technical/research-channels";
const lengthOf = (id: ChannelId) => Number(id.split("-")[1]);
function put(
  bars: Bar[],
  i: number,
  open: number,
  close: number,
  high = Math.max(open, close) + 1,
  low = Math.min(open, close) - 1,
) {
  Object.assign(bars[i]!, { open, close, high, low });
}
function shape(bars: Bar[], id: ChannelId, end: number, down: boolean) {
  const n = lengthOf(id),
    start = end - n,
    flag = id.startsWith("flag");
  if (flag)
    for (let j = 0; j < 6; j++)
      put(bars, start - 6 + j, 99.8 + j * 2, 100 + j * 2);
  for (let j = 0; j < n; j++) {
    const high = flag ? 109.5 - j * 0.03 : 112 - (j * 3) / (n - 1),
      low = flag ? 107.5 - j * 0.03 : 100 + (j * 3) / (n - 1),
      close = (high + low) / 2;
    put(bars, start + j, close - 0.1, close, high, low);
  }
  put(bars, end, 111, 113, 114, 110);
  if (down) {
    if (flag)
      for (let i = start - 6; i <= end; i++) {
        const b = bars[i]!;
        Object.assign(b, {
          open: 200 - b.open,
          close: 200 - b.close,
          high: 200 - b.low,
          low: 200 - b.high,
        });
      }
    else put(bars, end, 100, 98, 101, 97);
  }
}
function fixture(id: ChannelId) {
  const bars = Array.from({ length: 151 }, (_, i) => ({
    date: new Date(Date.UTC(2024, 0, i + 1)).toISOString().slice(0, 10),
    open: 113.8,
    close: 114,
    high: 115,
    low: 113,
    volume: 10000,
    amount: 1140000,
  }));
  shape(bars, id, 90, false);
  shape(bars, id, 140, true);
  return bars;
}
it("fits outward lines with hand-computable widths, slopes and distributed touches", () => {
  const bars = fixture("triangle-15"),
    window = bars.slice(75, 90),
    copy = structuredClone(window),
    c = priceChannel(window)!;
  expect(c.upper.slope).toBeCloseTo(-3 / 14, 12);
  expect(c.lower.slope).toBeCloseTo(3 / 14, 12);
  expect(c.startWidth).toBeCloseTo(12, 10);
  expect(c.endWidth).toBeCloseTo(6, 10);
  expect(c.nextWidth).toBeCloseTo(6 - 6 / 14, 10);
  expect(c.wellFormed).toBe(true);
  expect(c.upper.touches).toHaveLength(15);
  expect(window).toEqual(copy);
  const sparse = structuredClone(window);
  sparse[7]!.high += 0.4;
  expect(priceChannel(sparse)!.wellFormed).toBe(false);
  const crossed = window.map((b, i) => ({
    ...b,
    open: 106,
    close: 106,
    high: 112 - i * 0.42,
    low: 100 + i * 0.42,
  }));
  expect(priceChannel(crossed)).toBeNull();
  const current = { ...bars[90]!, open: 106, close: 106, high: 107, low: 105 };
  expect(
    researchChannelSeries("triangle-15", [...crossed, current])[15],
  ).toMatchObject({ entry: false, exit: false, reason: null });
});
it("rejects weak poles, nonparallel flags and insufficient triangle convergence", () => {
  const weak = fixture("flag-10");
  for (let i = 74; i < 80; i++)
    put(weak, i, 104 + (i - 74) * 0.2, 104.1 + (i - 74) * 0.2);
  expect(researchChannelSeries("flag-10", weak)[90]!.entry).toBe(false);
  const flag = fixture("flag-10");
  for (let j = 0; j < 10; j++) {
    const b = flag[80 + j]!;
    b.low = 107.5 - j * 0.15;
  }
  expect(researchChannelSeries("flag-10", flag)[90]!.entry).toBe(false);
  const triangle = fixture("triangle-15");
  for (let j = 0; j < 15; j++) {
    const b = triangle[75 + j]!;
    b.high = 112 - j * 0.01;
    b.low = 100 + j * 0.01;
  }
  expect(researchChannelSeries("triangle-15", triangle)[90]!.entry).toBe(false);
  const touch = fixture("triangle-15"),
    line = researchChannelSeries("triangle-15", touch)[90]!.channel.geometry!
      .upper.next;
  put(touch, 90, line - 0.1, line, line + 1, line - 1);
  expect(researchChannelSeries("triangle-15", touch)[90]!.entry).toBe(false);
});
it("rejects missing or invalid pole/consolidation data and never creates a one-price channel", () => {
  for (const [i, change] of [
    [75, { volume: 0 }],
    [85, { high: NaN }],
    [90, { open: 113, close: 113, high: 113, low: 113 }],
  ] as const) {
    const bars = fixture("flag-10");
    Object.assign(bars[i]!, change);
    expect(researchChannelSeries("flag-10", bars)[90]).toMatchObject({
      entry: false,
      exit: false,
      reason: expect.any(String),
    });
  }
  expect(
    priceChannel(
      fixture("flag-10")
        .slice(80, 90)
        .map((b) => ({ ...b, open: 1, close: 1, high: 1, low: 1 })),
    ),
  ).toBeNull();
});
it.each(channelIds)("%s calculates a causal pre-break channel", (id) => {
  const bars = fixture(id),
    series = researchChannelSeries(id, bars);
  expect(series[90]!.entry).toBe(true);
  expect(series[89]!.entry).toBe(false);
  expect(series[140]!.exit).toBe(true);
  expect(series[90]!.channel.end).toBe(bars[89]!.date);
  expect(series[90]!.ruleStop!.price).toBe(
    series[90]!.channel.geometry!.lower.next,
  );
  expect(researchChannelSeries(id, bars.slice(0, 91))).toEqual(
    series.slice(0, 91),
  );
  const changed = structuredClone(bars);
  changed[90]!.high = 10000;
  expect(researchChannelSeries(id, changed)[90]!.channel).toEqual(
    series[90]!.channel,
  );
});
