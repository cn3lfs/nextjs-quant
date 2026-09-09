import { describe, expect, it } from "vitest";
import type { Bar } from "~/lib/domain";
import { ma, ema, macd, kdj, rsi, boll } from "~/lib/indicators";
const bars = (closes: number[]): Bar[] =>
  closes.map((close, i) => ({
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 100,
    amount: 1000,
  }));
const rising = bars(Array.from({ length: 20 }, (_, i) => i + 2));
const all = (b: readonly Bar[]) => [
  ma(b),
  ema(b),
  macd(b),
  kdj(b),
  rsi(b),
  boll(b),
];
describe("M1 hand-calculable fixtures (8–30 bars)", () => {
  it("MA uses complete windows", () => {
    // closes 2..21: MA5 at index 4 = (2+3+4+5+6)/5 = 4; MA20 = 23/2.
    expect(ma(rising, 5).slice(0, 5)).toEqual([null, null, null, null, 4]);
    expect(ma(rising)[19]).toBe(11.5);
  });
  it("EMA seeds immediately and recurses", () => {
    // EMA3: 2; (2*3+2*2)/4=2.5; (2*4+2*2.5)/4=3.25.
    expect(ema(rising, 3).slice(0, 3)).toEqual([2, 2.5, 3.25]);
  });
  it("MACD uses full DIF history and doubled histogram", () => {
    // Second bar: EMA12=2+2/13, EMA26=2+2/27; DIF=28/351;
    // DEA=DIF*2/10; histogram=2*(DIF-DEA)=224/1755.
    const out = macd(rising);
    expect(out[0]).toEqual({ dif: 0, dea: 0, macd: 0 });
    expect(out[1]!.dif).toBeCloseTo(28 / 351, 12);
    expect(out[1]!.dea).toBeCloseTo(28 / 1755, 12);
    expect(out[1]!.macd).toBeCloseTo(224 / 1755, 12);
  });
  it("KDJ seeds from first RSV, then applies two SMA stages", () => {
    const input = bars(Array(10).fill(10));
    input[9]!.close = 10.5;
    // First RSV=(10-9)/(11-9)*100=50; next RSV=75;
    // K=(75+2*50)/3=175/3; D=(175/3+100)/3=475/9; J=625/9.
    const out = kdj(input);
    expect(out.slice(0, 8).every((v) => v.k === null && v.rsv === null)).toBe(
      true,
    );
    expect(out[8]).toEqual({ rsv: 50, k: 50, d: 50, j: 50 });
    expect(out[9]!.k).toBeCloseTo(175 / 3, 12);
    expect(out[9]!.d).toBeCloseTo(475 / 9, 12);
    expect(out[9]!.j).toBeCloseTo(625 / 9, 12);
  });
  it("RSI uses Wilder smoothing and real previous close", () => {
    const out = rsi(bars([10, 12, 11, 11, 11, 11, 11, 11]));
    // First delta +2 => 100. Next -1: SMA(up) = 2*(N-1)/N,
    // SMA(abs)=(1+2*(N-1))/N; ratio = 100*(2N-2)/(2N-1).
    expect(out[0]).toEqual({ rsi6: null, rsi12: null, rsi24: null });
    expect(out[1]).toEqual({ rsi6: 100, rsi12: 100, rsi24: 100 });
    expect(out[2]!.rsi6).toBeCloseTo(1000 / 11, 12);
    expect(out[2]!.rsi12).toBeCloseTo(2200 / 23, 12);
    expect(out[2]!.rsi24).toBeCloseTo(4600 / 47, 12);
  });
  it("BOLL uses sample variance, not population variance", () => {
    // 2..21: mean=11.5; squared deviations sum=665; sample variance=665/19=35.
    expect(
      boll(rising)
        .slice(0, 19)
        .every((v) => v.mid === null),
    ).toBe(true);
    expect(boll(rising)[19]).toEqual({
      mid: 11.5,
      upper: 11.5 + 2 * Math.sqrt(35),
      lower: 11.5 - 2 * Math.sqrt(35),
    });
    expect(boll(rising)[19]!.upper).not.toBeCloseTo(
      11.5 + 2 * Math.sqrt(665 / 20),
      2,
    );
  });
});
it("handles empty, single-bar and short histories without invented values", () => {
  expect(all([])).toEqual([[], [], [], [], [], []]);
  const one = bars([10]);
  expect(ma(one)).toEqual([null]);
  expect(ema(one)).toEqual([10]);
  expect(macd(one)).toEqual([{ dif: 0, dea: 0, macd: 0 }]);
  expect(kdj(one)).toEqual([{ rsv: null, k: null, d: null, j: null }]);
  expect(rsi(one)).toEqual([{ rsi6: null, rsi12: null, rsi24: null }]);
  expect(boll(one)).toEqual([{ mid: null, upper: null, lower: null }]);
});
it("includes zero-volume bars; flat prices yield no RSI or initial KDJ seed", () => {
  expect(all(rising.map((b) => ({ ...b, volume: 0, amount: 0 })))).toEqual(
    all(rising),
  );
  const flat = bars(Array(20).fill(10)).map((b) => ({
    ...b,
    high: 10,
    low: 10,
    volume: 0,
  }));
  expect(
    kdj(flat).every((v) => v.rsv === null && v.k === null && v.d === null),
  ).toBe(true);
  expect(
    rsi(flat).every(
      (v) => v.rsi6 === null && v.rsi12 === null && v.rsi24 === null,
    ),
  ).toBe(true);
  expect(boll(flat)[19]).toEqual({ mid: 10, upper: 10, lower: 10 });
});
it("KDJ holds both states over zero range and resumes without reseeding", () => {
  const input = bars(Array(19).fill(10));
  for (let i = 9; i < 18; i++) Object.assign(input[i]!, { high: 10, low: 10 });
  Object.assign(input[18]!, { high: 12, low: 10, close: 12 });
  const out = kdj(input);
  expect(out[17]).toEqual({ rsv: null, k: 50, d: 50, j: 50 });
  // Resume RSV=100: K=(100+100)/3, D=(200/3+100)/3; not 100/100.
  expect(out[18]!.k).toBeCloseTo(200 / 3, 12);
  expect(out[18]!.d).toBeCloseTo(500 / 9, 12);
});
it("invalid samples hold recursive state and contaminate full windows only", () => {
  const input = bars([10, 12, NaN, 14, 16, 17, 18, 19]);
  expect(ema(input, 3).slice(0, 5)).toEqual([10, 11, 11, 12.5, 14.25]);
  expect(macd(input)[2]).toEqual(macd(input)[1]);
  expect(rsi(input)[2]).toEqual(rsi(input)[1]);
  expect(rsi(input)[3]).toEqual(rsi(input)[1]);
  expect(ma(input, 2).slice(1, 5)).toEqual([11, null, null, 15]);
  expect(boll(input, 2)[2]).toEqual({ mid: null, upper: null, lower: null });
  const invalid = bars([Infinity]);
  expect(ema(invalid)).toEqual([null]);
  expect(macd(invalid)).toEqual([{ dif: null, dea: null, macd: null }]);
});
it("is deterministic, immutable and does not use future bars", () => {
  const input = Object.freeze(rising.map((b) => Object.freeze({ ...b })));
  expect(all(input)).toEqual(all(input));
  all(input.slice(0, 10)).forEach((line, i) =>
    expect(line).toEqual(all(input)[i]!.slice(0, 10)),
  );
});
it("rejects invalid parameters instead of returning NaN", () => {
  for (const n of [0, -1, 1.5, NaN, Infinity]) {
    expect(() => ma(rising, n)).toThrow(RangeError);
    expect(() => ema(rising, n)).toThrow(RangeError);
  }
  expect(() => boll(rising, 1)).toThrow(RangeError);
  expect(() => boll(rising, 20, -1)).toThrow(RangeError);
});
