import { expect, it } from "vitest";
import { wyckoffDailyProfile } from "../../../../src/lib/research/methods/wyckoff/research-wyckoff-profile";
import { researchWyckoffSeries } from "../../../../src/lib/research/methods/wyckoff/research-wyckoff";
import type { Bar } from "../../../../src/lib/domain";

function fixture(highVolume = true): Bar[] {
  return Array.from({ length: 92 }, (_, i) => {
    const close =
      i === 90
        ? 106
        : i === 91
          ? 106.5
          : 100 + 4 * Math.cos((Math.PI * (i - 50)) / 10);
    return {
      date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
      open: i === 90 ? 103 : close - 0.1,
      close,
      low: i === 90 ? 103 : i === 91 ? 104.5 : close - 0.5,
      high: i === 90 ? 107 : i === 91 ? 107 : close + 0.5,
      volume:
        i === 90 ? 5000 : (highVolume ? close > 103 : close < 97) ? 2000 : 100,
      amount: 10000,
    };
  });
}
it("daily-estimate is explicitly named, conserves volume and has deterministic ties", () => {
  const b = Array.from({ length: 20 }, (_, i) => ({
    ...fixture()[i]!,
    low: 10,
    high: 22,
    volume: 120,
  }));
  const p = wyckoffDailyProfile(b, 10, 22);
  expect(p.status).toBe("daily-uniform-estimate");
  expect(p.totalVolume).toBeCloseTo(2400, 8);
  expect(p.bins.map((b) => b.volume)).toEqual(Array(12).fill(200));
  expect(p.hvn).toEqual([0, 1, 2]);
  expect(p.poc).toBe(0);
  expect(wyckoffDailyProfile(b.slice(1), 10, 22).status).toBe("missing");
  b[0]!.high = 23;
  expect(wyckoffDailyProfile(b, 10, 22).status).toBe("missing");
});
it("WY18 filters JAC using only pre-candidate TR estimated HVN; low-area concentration rejects", () => {
  const b = fixture();
  const p = researchWyckoffSeries("wy-vp-daily-estimate", b).at(-1)!;
  expect(p.profile?.status).toBe("daily-uniform-estimate");
  expect(p.profile?.end).toBe(b[89]!.date);
  expect(p.entry).toBe(true);
  expect(p.profile!.hvn.some((i) => i >= 10)).toBe(true);
  expect(
    researchWyckoffSeries("wy-vp-daily-estimate", fixture(false)).at(-1)!.entry,
  ).toBe(false);
});
