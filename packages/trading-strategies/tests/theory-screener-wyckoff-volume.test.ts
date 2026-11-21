import { expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  createWyckoffVolumeFamilyScreener as prepare,
  wyckoffVolumeSpecs,
} from "../src/screener/wyckoff-volume.js";

const candle = (
  open: number,
  high: number,
  low: number,
  close: number,
  volume = 100,
) => ({ open, high, low, close, volume });
const base = candle(100, 105, 95, 100);
function history(
  changes: Record<number, typeof base> = {},
  background = base,
): Bar[] {
  return Array.from({ length: 81 }, (_, i) => ({
    ...(changes[i] ?? background),
    amount: 1000,
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
  }));
}
function find(bars: Bar[], slug: string, i = 80) {
  return prepare({ bars })
    .at(i)
    .find((m) => m.methodId === "f08-" + slug);
}
const jump = candle(103, 108, 102, 107, 160);
const dip = candle(96, 98, 92, 96);
const turn = candle(96, 101, 95, 100);
const springId = "wyckoff-spring-test",
  sosId = "wyckoff-sos-jac",
  lpsId = "wyckoff-lps",
  utadId = "wyckoff-utad-sow";
const profileId = "volume-profile-poc",
  vwapId = "anchored-vwap-reclaim",
  divId = "volume-price-divergence";
const falling = candle(90, 92, 82, 90, 165);
const lpsChanges = {
  76: jump,
  77: candle(106, 107, 104, 105),
  78: candle(105, 106, 104, 105, 60),
  79: candle(105, 106, 104, 105),
  80: candle(106, 109, 105, 108),
};
const reclaim = candle(100, 107, 99, 106);
const obvDivergence = history({
  58: candle(99, 104, 92, 98),
  66: candle(102, 108, 98, 104, 300),
  73: candle(100, 102, 90, 100),
  80: candle(104, 110, 103, 109),
});
const noSupply = history({ 79: candle(100, 100.5, 99, 99.5, 50), 80: turn });
for (let i = 0; i < 40; i++)
  Object.assign(noSupply[i]!, candle(90, 92, 88, 90));
Object.assign(noSupply[80]!, candle(100, 103, 99, 102));
const cases: [string, string, Bar[], number, number, number][] = [
  ["spring", springId, history({ 79: dip, 80: turn }), 98, 92 * 0.99, 105],
  [
    "secondary test",
    springId,
    history({ 78: dip, 79: candle(97, 98, 95, 96, 50), 80: turn }),
    98,
    92 * 0.99,
    105,
  ],
  ["SOS", sosId, history({ 80: jump }), 105, 100, 120],
  ["LPS", lpsId, history(lpsChanges), 106, 105 * 0.97, 114],
  [
    "failed thrust",
    utadId,
    history({ 79: candle(103, 108, 100, 104), 80: candle(102, 103, 97, 98) }),
    100,
    108 * 1.01,
    85,
  ],
  [
    "ice breakdown",
    utadId,
    history({ 74: candle(103, 108, 100, 104), 80: candle(98, 99, 92, 93) }),
    95,
    108 * 1.01,
    82,
  ],
  ["no supply", "vsa-no-supply-test", noSupply, 100.5, 99, 109.5],
  [
    "stopping volume",
    "vsa-no-supply-test",
    history({ 79: falling, 80: candle(91, 96, 90, 94) }),
    92,
    82,
    124,
  ],
  ["OBV neckline", divId, obvDivergence, 108, 90, 147],
  [
    "VAH breakout",
    profileId,
    history({ 80: jump }),
    100.5,
    100.25 * 0.97,
    107 + 2 * (107 - 100.25 * 0.97),
  ],
  [
    "POC reclaim",
    profileId,
    history({ 79: candle(101, 102, 99, 100), 80: reclaim }),
    102,
    100.25 * 0.97,
    106 + 2 * (106 - 100.25 * 0.97),
  ],
];
it.each(cases)(
  "%s has causal levels and valid match fields",
  (_, id, bars, pivot, stop, target) => {
    const m = find(bars, id)!;
    expect(m.pivotPrice).toBeCloseTo(pivot);
    expect(m.stopPrice).toBeCloseTo(stop);
    expect(m.targetPrice).toBeCloseTo(target);
    expect(m.rewardMultiple).toBeCloseTo((target - m.close) / (m.close - stop));
    expect(m.volumeRatio).toBeGreaterThan(0);
    expect(m.score).toBeGreaterThanOrEqual(1);
    expect(m.score).toBeLessThanOrEqual(5);
    expect(m.summary).toMatch(/[一-龥]/);
    expect(
      m.geometry.lines.every(
        (l) => l.points.length >= 2 && l.points.every((p) => p.index <= 80),
      ),
    ).toBe(true);
    expect(find([...bars, ...history()], id)).toEqual(m);
  },
);

it.each([
  ["high", 150],
  ["low", 100],
] as const)(
  "computes each %s anchored cost from its inclusive volume weights",
  (side, volume) => {
    const bars = history({
      24: candle(100, 108, 95, 100),
      31: candle(100, 105, 92, 100),
      79: candle(99, 101, 98, 99),
      80: { ...reclaim, volume },
    });
    const m = find(bars, vwapId)!;
    const start = side === "high" ? 24 : 31;
    const points = m.geometry.lines[0]!.points;
    expect(points.map((p) => p.index)).toEqual(
      Array.from({ length: 81 - start }, (_, j) => start + j),
    );
    let cost = 0,
      shares = 0;
    for (const p of points) {
      const b = bars[p.index]!;
      shares += b.volume;
      cost += ((b.high + b.low + b.close) / 3) * b.volume;
      expect(p.price).toBeCloseTo(cost / shares);
    }
    expect(m.pivotPrice).toBeCloseTo(cost / shares);
    expect(m.rewardMultiple).toBeCloseTo(2.5);
  },
);

it("uses CMF and MFI together when OBV is flat at both lows", () => {
  const bars = history({}, candle(100, 106, 99, 100));
  Object.assign(bars[54]!, candle(100, 110, 99, 100));
  Object.assign(bars[58]!, candle(100, 105, 95, 100));
  for (let j = 59; j <= 80; j++)
    Object.assign(bars[j]!, candle(100, 101, 96, 100));
  Object.assign(bars[65]!, candle(100, 109, 96, 100));
  Object.assign(bars[72]!, candle(100, 108, 96, 100));
  Object.assign(bars[73]!, candle(100, 108, 94, 100, 10));
  Object.assign(bars[80]!, candle(105, 111, 104, 110));
  expect(find(bars, divId)?.pivotPrice).toBe(109);
  Object.assign(bars[73]!, candle(100, 101, 93, 100, 400));
  expect(find(bars, divId)).toBeUndefined();
});

it("reclaims the moving average and previous high below the divergence neckline", () => {
  const bars = obvDivergence.map((b) => ({ ...b }));
  Object.assign(bars[79]!, candle(99, 101, 96, 98));
  Object.assign(bars[80]!, candle(100, 104, 98, 103));
  expect(find(bars, divId)?.pivotPrice).toBe(101);
  expect(find(bars, divId, 75)).toBeUndefined();
});

it("expands the 70% value area toward the larger adjacent volume", () => {
  const bars = history({}, candle(100, 110, 90, 100));
  for (let i = 20; i < 41; i++)
    Object.assign(bars[i]!, candle(103, 110, 90, 103));
  for (let i = 41; i < 49; i++)
    Object.assign(bars[i]!, candle(97, 110, 90, 97));
  Object.assign(bars[80]!, jump);
  const m = find(bars, profileId)!;
  expect(m.geometry.lines.map((l) => [l.kind, l.points[0]!.price])).toEqual([
    ["neckline", 100.5],
    ["upper", 102],
    ["lower", 100],
  ]);
});

it("rejects weak breakouts, breached pullbacks, stale divergence and invalid data", () => {
  expect(
    find(history({ 80: { ...jump, volume: 149 } }), sosId),
  ).toBeUndefined();
  expect(
    find(history({ ...lpsChanges, 78: candle(105, 106, 102, 105, 60) }), lpsId),
  ).toBeUndefined();
  const stale = [
    ...obvDivergence.slice(0, 80),
    ...history().slice(0, 15),
    obvDivergence[80]!,
  ].map((b, i) => ({ ...b, date: String(1000 + i) }));
  expect(find(stale, divId, 95)).toBeUndefined();
  expect(
    find(history({ 79: { ...dip, volume: 0 }, 80: turn }), springId),
  ).toBeUndefined();
});
it("publishes eight specs on empty input and respects unavailable history", () => {
  expect(new Set(wyckoffVolumeSpecs.map((s) => s.id)).size).toBe(8);
  const empty = prepare({ bars: [] });
  expect(empty.specs).toBe(wyckoffVolumeSpecs);
  expect(empty.at(0)).toEqual([]);
  const family = prepare({ bars: history() });
  for (const i of [-1, 28, 81, NaN, 41.5]) expect(family.at(i)).toEqual([]);
});
