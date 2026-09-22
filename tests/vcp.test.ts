import { expect, it } from "vitest";
import type { Snapshot } from "../src/lib/domain";
import { vcpFacts } from "../src/server/strategies/canslim/vcp";
function fixture(): Snapshot {
  const points = [
    [0, 90],
    [8, 100],
    [16, 80],
    [24, 95],
    [32, 85.5],
    [40, 92],
    [48, 87.4],
    [56, 91],
    [59, 90],
  ];
  const bars = Array.from({ length: 60 }, (_, i) => {
    const next = points.findIndex((p) => p[0]! >= i);
    const end = points[next]!,
      start = points[Math.max(0, next - 1)]!;
    const price =
      end[0] === start[0]
        ? end[1]!
        : start[1]! +
          ((end[1]! - start[1]!) * (i - start[0]!)) / (end[0]! - start[0]!);
    return {
      date: new Date(Date.UTC(2026, 0, i + 1)).toISOString().slice(0, 10),
      open: price,
      high: price,
      low: price,
      close: price,
      volume: i >= 55 ? 10 : 100,
      amount: 100,
    };
  });
  return {
    id: "fixture",
    hash: "fixture",
    createdAt: 0,
    symbol: "sh600519",
    period: "day",
    source: "tdx-local",
    adjustment: "none",
    bars,
  };
}
it("pairs confirmed contractions and preserves the three-bar confirmation delay", () => {
  const source = fixture(),
    facts = vcpFacts(source);
  expect(facts.applicable).toBe(true);
  expect(facts.contractions).toHaveLength(3);
  [20, 10, 5].forEach((depth, i) =>
    expect(facts.contractions![i]!.depthPercent).toBeCloseTo(depth),
  );
  expect(facts.checks).toMatchObject({
    minimumTwoContractions: true,
    shrinkingAtLeast30Percent: true,
    finalVolumeDry: true,
    consolidationVolumeVersusUptrend: null,
  });
  expect(facts.pivot).toMatchObject({
    date: source.bars[56]!.date,
    confirmedAt: source.bars[59]!.date,
    price: 91,
  });
  expect(
    facts.extrema!.every(
      (p) => p.confirmedAt === source.bars[p.index + 3]!.date,
    ),
  ).toBe(true);
});
it("ignores unconfirmed trailing peaks and quarantines ambiguous outside bars", () => {
  const source = fixture();
  source.bars[58]!.high = 200;
  expect(vcpFacts(source).extrema!.some((p) => p.index === 58)).toBe(false);
  source.bars[24]!.low = 1;
  const facts = vcpFacts(source);
  expect(facts.ambiguousDates).toContain(source.bars[24]!.date);
  expect(facts.extrema!.some((p) => p.index === 24)).toBe(false);
});
it("does not turn short data, intraday records, plateaus or zero volume into a confirmed pattern", () => {
  const source = fixture();
  expect(vcpFacts({ ...source, period: "5m" }).applicable).toBe(false);
  expect(
    vcpFacts({ ...source, bars: source.bars.slice(0, 59) }).applicable,
  ).toBe(false);
  source.bars.forEach((b) => {
    b.open = b.high = b.low = b.close = 100;
    b.volume = 0;
  });
  expect(vcpFacts(source)).toMatchObject({
    contractions: [],
    pivot: null,
    checks: {
      minimumTwoContractions: false,
      finalVolumeDry: null,
      shrinkingAtLeast30Percent: null,
    },
  });
});
it("does not bridge an ambiguous bar when pairing contractions, comparing sequences or finding a pivot", () => {
  const source = fixture();
  source.bars[28]!.high = 200;
  source.bars[28]!.low = 1;
  let facts = vcpFacts(source);
  expect(facts.contractions!.some((w) => w.start < 28 && w.end > 28)).toBe(
    false,
  );
  expect(facts.checks!.shrinkingAtLeast30Percent).toBeNull();
  source.bars[52]!.high = 200;
  source.bars[52]!.low = 1;
  facts = vcpFacts(source);
  expect(facts.pivot).toBeNull();
});
