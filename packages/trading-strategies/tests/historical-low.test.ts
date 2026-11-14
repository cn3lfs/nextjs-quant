import { describe, expect, it } from "vitest";
import {
  historicalLowSeries,
  researchCandidates,
  prepareStrategy,
  lowZoneCycles,
  type LowZoneFact,
} from "../src/index.js";
import type { Bar } from "trading-strategy-core/bars";

function history(): Bar[] {
  return Array.from({ length: 2200 }, (_, i) => {
    const close = i < 2199 ? 100 + i / 100 : 25;
    return {
      date: new Date(Date.UTC(2010, 0, 1 + i)).toISOString().slice(0, 10),
      open: close,
      high: close,
      low: close,
      close,
      volume: 1000,
      amount: close * 1000,
    };
  });
}
describe("independent historical low detector", () => {
  it("requires five calendar years and labels all missing corroborators", () => {
    const bars = history(),
      rows = historicalLowSeries(bars);
    expect(rows[1000]!.depth).toBeNull();
    // Last close ranks 1/2200 and draws down 25/121.98 - 1 < -60%.
    expect(rows.at(-1)!.price.value).toBeCloseTo(1 / 2200, 12);
    expect(rows.at(-1)!.drawdown.value).toBeCloseTo(25 / 121.98 - 1, 12);
    expect(rows.at(-1)!.depth).toBe(3);
    expect(rows.at(-1)!.targetShare).toBe(0.4);
    expect(rows.at(-1)!.confidence).toBe("price-only");
    expect(rows.at(-1)!.pe.value).toBeNull();
    expect(rows.at(-1)!.temperature.confidence).toBe("missing");
  });
  it("consumes only date-matched PIT facts, corroborates low values and vetoes high temperature", () => {
    const bars = history();
    const facts: LowZoneFact[] = bars.slice(-80).map((b, i) => ({
      date: b.date,
      availableAt: b.date,
      pe: 100 - i,
      pb: 10 - i / 10,
      temperature: 10,
      confidence: "approximate",
      source: "PIT fixture",
    }));
    const row = historicalLowSeries(bars, {}, facts).at(-1)!;
    expect(row.confidence).toBe("corroborated");
    expect(row.depth).toBe(3);
    expect(row.pe.confidence).toBe("approximate");
    const high = facts.map((f, i) =>
      i === facts.length - 1 ? { ...f, temperature: 80 } : f,
    );
    expect(historicalLowSeries(bars, {}, high).at(-1)!.depth).toBe(0);
    expect(() =>
      historicalLowSeries(bars, {}, [
        { ...facts.at(-1)!, availableAt: "2099-01-01" },
      ]),
    ).toThrow("non-causal");
  });
  it("future prices/facts cannot change historical triggers; recovery exits independently", () => {
    const bars = history();
    const next = {
      ...bars.at(-1)!,
      date: new Date(Date.parse(bars.at(-1)!.date) + 86400000)
        .toISOString()
        .slice(0, 10),
      open: 130,
      high: 130,
      low: 130,
      close: 130,
    };
    const prefix = historicalLowSeries(bars);
    const extended = historicalLowSeries([...bars, next]);
    expect(extended.slice(0, -1)).toEqual(prefix);
    expect(extended.at(-1)!.recovery).toBe(true);
    expect(lowZoneCycles(extended)).toEqual([
      {
        start: bars.at(-1)!.date,
        end: next.date,
        complete: true,
        stages: [{ date: bars.at(-1)!.date, depth: 3, share: 0.4 }],
      },
    ]);
    const candidate = researchCandidates(
      ["sh600001", "sz000001"],
      "cn-equity",
    ).find((c) => c.family === "historical-low")!;
    const evaluated = prepareStrategy(candidate.strategy, [...bars, next]);
    expect(evaluated.evaluate(bars.length - 1).entry).toBe(true);
    expect(evaluated.evaluate(bars.length).exit).toBe(true);
    expect(() => historicalLowSeries([...bars, bars[0]!])).toThrow("history");
  });
  it("registers all requested sleeves and native timeframes with three exit variants", () => {
    const equity = researchCandidates(["sh600001", "sz000001"], "cn-equity");
    expect(new Set(equity.map((c) => c.family))).toEqual(
      new Set([
        "rps-multi",
        "double-breakout",
        "chan-third-buy",
        "formula-ma",
        "formula-range",
        "formula-pullback",
        "historical-low",
      ]),
    );
    for (const family of new Set(equity.map((c) => c.family)))
      expect(
        equity.filter((c) => c.family === family).map((c) => c.variant),
      ).toEqual(["atr", "trailing", "time"]);
    const crypto = researchCandidates(["BTCUSDT", "ETHUSDT"], "crypto");
    expect(new Set(crypto.map((c) => c.strategy.period))).toEqual(
      new Set(["4h", "day", "15m", "1h"]),
    );
    expect(new Set(crypto.map((c) => c.strategy.sleeve))).toEqual(
      new Set(["swing", "breakout"]),
    );
    for (const candidate of [...equity, ...crypto])
      expect(() => prepareStrategy(candidate.strategy, [])).not.toThrow();
    expect(() => researchCandidates([], "crypto")).toThrow("empty");
  });
});
