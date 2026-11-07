import { describe, expect, it } from "vitest";
import type { Bar } from "../src/bars.js";
import { atr, boll, ema, kdj, ma, macd, obv, rsi } from "../src/indicators.js";
import {
  calculateFactor,
  factorCatalog,
  factorIds,
  qlibAlpha158Variants,
  resolveFactor,
  type FactorId,
} from "../src/factors/index.js";

function bars(closes: number[]): Bar[] {
  return closes.map((close, i) => ({
    date: `bar-${i}`,
    open: close - 0.25,
    high: close + 1,
    low: close - 1,
    close,
    volume: (i + 1) * 10,
    amount: (i + 1) * close * 10,
  }));
}
const fixture = bars(
  Array.from({ length: 270 }, (_, i) => 10 + i / 20 + Math.sin(i)),
).map((bar, i) => ({ ...bar, volume: 100 + 20 * Math.sin(i * 1.7) + (i % 7) }));
const values = (id: FactorId, period?: number, input = fixture) =>
  calculateFactor(input, {
    id,
    ...(period === undefined ? {} : { parameters: { period } }),
  }).values;

describe("modular factor catalog", () => {
  it("registers exact public subsets and standard Alpha158 variants except VWAP0", () => {
    expect(factorIds).toHaveLength(76);
    expect(new Set(factorIds).size).toBe(76);
    expect(
      factorCatalog
        .filter((f) => f.id.startsWith("alpha101-"))
        .map((f) => f.source?.originalName),
    ).toEqual(
      [6, 9, 12, 23, 24, 26, 35, 46, 49, 51, 53, 54, 101].map(
        (n) => `Alpha#${n}`,
      ),
    );
    expect(qlibAlpha158Variants).toHaveLength(157);
    expect(qlibAlpha158Variants.some((v) => v.name === "VWAP0")).toBe(false);
    expect(
      qlibAlpha158Variants
        .filter((v) => v.name.startsWith("ROC"))
        .map((v) => v.name),
    ).toEqual(["ROC5", "ROC10", "ROC20", "ROC30", "ROC60"]);
  });
  it("delegates existing indicators to the shared formulas", () => {
    expect(values("sma", 5)).toEqual(ma(fixture, 5));
    expect(values("ema", 5)).toEqual(ema(fixture, 5));
    expect(values("macd-dif")).toEqual(macd(fixture).map((v) => v.dif));
    expect(values("macd-dea")).toEqual(macd(fixture).map((v) => v.dea));
    expect(values("macd-macd")).toEqual(macd(fixture).map((v) => v.macd));
    expect(values("rsi", 14)).toEqual(
      rsi(fixture, [14, 14, 14]).map((v) => v.rsi6),
    );
    for (const line of ["k", "d", "j"] as const)
      expect(values(`kdj-${line}`)).toEqual(kdj(fixture).map((v) => v[line]));
    expect(values("atr")).toEqual(atr(fixture));
    expect(values("boll-upper")).toEqual(boll(fixture).map((v) => v.upper));
    expect(values("obv")).toEqual(obv(fixture));
  });
  it("uses prior-only volume and breakout baselines with independent expected values", () => {
    const input = bars([10, 12, 15, 18]);
    expect(values("roc", 2, input).slice(0, 3)).toEqual([null, null, 50]);
    expect(values("bias", 2, input)[1]).toBeCloseTo((12 / 11 - 1) * 100);
    expect(values("volume-ratio", 2, input)).toEqual([null, null, 2, 1.6]);
    expect(values("prior-high", 2, input)).toEqual([null, null, 13, 16]);
    expect(values("prior-low", 2, input)).toEqual([null, null, 9, 11]);
    expect(
      values(
        "volume-ratio",
        2,
        input.map((b) => ({ ...b, volume: 0 })),
      ),
    ).toEqual([null, null, null, null]);
    const invalid = structuredClone(input);
    invalid[0]!.close = NaN;
    expect(values("prior-high", 2, invalid)[2]).toBeNull();
  });
  it("matches hand-computed public features and preserves distinct ROC definitions", () => {
    const input = bars([10, 12, 15, 18]);
    expect(values("qlib-ROC", 2, input)[2]).toBeCloseTo(10 / 15);
    expect(values("qlib-MA", 2, input)[2]).toBeCloseTo(13.5 / 15);
    expect(values("qlib-STD", 2, input)[2]).toBeCloseTo(Math.sqrt(4.5) / 15);
    expect(values("qlib-RANK", 3, bars([10, 12, 12]))[2]).toBeCloseTo(2.5 / 3);
    expect(values("qlib-IMAX", 3, bars([10, 12, 12]))[2]).toBeCloseTo(2 / 3);
    expect(values("qlib-BETA", 3, bars([10, 12, 14]))[2]).toBeCloseTo(2 / 14);
    expect(values("qlib-RSQR", 3, bars([10, 12, 14]))[2]).toBeCloseTo(1);
    expect(values("qlib-RESI", 3, bars([10, 12, 14]))[2]).toBeCloseTo(0);
    expect(values("alpha101-12", undefined, input)[2]).toBe(-3);
    expect(values("alpha101-101", undefined, input)[0]).toBeCloseTo(
      0.25 / 2.001,
    );
    expect(values("alpha101-54", undefined, input)[0]).toBeCloseTo(
      -0.5 * (9.75 / 10) ** 5,
    );
  });
  it("rejects invalid inputs and cannot mutate input or see appended future bars", () => {
    expect(() => resolveFactor({ id: "unknown" as FactorId })).toThrow(
      "未知因子",
    );
    expect(() => resolveFactor({ id: "sma", parameters: { pe: 3 } })).toThrow(
      "不支持参数",
    );
    for (const period of [0, 1.5, 251, NaN, Infinity])
      expect(() =>
        resolveFactor({ id: "sma", parameters: { period } }),
      ).toThrow();
    expect(() =>
      resolveFactor({ id: "macd-dif", parameters: { fast: 26, slow: 12 } }),
    ).toThrow("快周期");
    const before = structuredClone(fixture);
    for (const id of factorIds) {
      const short = calculateFactor(fixture.slice(0, 240), { id });
      const full = calculateFactor(fixture, { id });
      expect(full.values.slice(0, 240), id).toEqual(short.values);
      expect(full.values.length, id).toBe(fixture.length);
      expect(
        full.values.some((v) => v !== null),
        id,
      ).toBe(true);
      expect(
        full.values.every((v) => v === null || Number.isFinite(v)),
        id,
      ).toBe(true);
    }
    expect(fixture).toEqual(before);
  });
});
