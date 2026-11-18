import { describe, expect, it } from "vitest";
import type { Bar } from "trading-strategy-core/bars";
import {
  createTheoryStructureRule,
  theoryStructureDefinitions,
} from "../src/theory-structure";
const flat = (n = 220): Bar[] =>
  Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: 100,
    close: 100,
    high: 101,
    low: 99,
    volume: 1000,
    amount: 100000,
  }));
const empty = { entry: 0, entryIndex: 0 };
function set(bars: Bar[], index: number, change: Partial<Bar>) {
  bars[index] = { ...bars[index]!, ...change };
}

describe("confirmed structure research proxies", () => {
  it("detects a volume-confirmed VCP contraction and rejects an expanding final pullback", () => {
    const bars = flat().map((b) => ({
      ...b,
      open: 110,
      close: 110,
      high: 111,
      low: 109,
    }));
    set(bars, 100, { high: 120 });
    set(bars, 110, { low: 90 });
    set(bars, 120, { high: 115 });
    set(bars, 130, { low: 100 });
    for (let i = 120; i <= 130; i++) set(bars, i, { volume: 100 });
    set(bars, 140, {
      open: 110,
      close: 117,
      high: 118,
      low: 110,
      volume: 2000,
    });
    expect(
      createTheoryStructureRule("theory-vcp-close", bars)!(140, empty).enter,
    ).toBe(true);
    set(bars, 130, { low: 85 });
    expect(
      createTheoryStructureRule("theory-vcp-close", bars)!(140, empty).enter,
    ).toBe(false);
  });
  it("detects flag continuation only after a meaningful pole and consolidation", () => {
    const bars = flat();
    for (let i = 81; i <= 90; i++) {
      const close = 100 + (i - 80) * 2;
      set(bars, i, { open: close, close, high: close + 0.5, low: close - 0.5 });
    }
    for (let i = 91; i <= 100; i++)
      set(bars, i, { open: 119, close: 119, high: 120, low: 118 });
    set(bars, 101, { open: 120, close: 122, high: 123, low: 119 });
    expect(
      createTheoryStructureRule("theory-flag-close", bars)!(101, empty).enter,
    ).toBe(true);
  });
  it("enters the daily stage proxy after its average warmup, then exits below that average", () => {
    const bars = flat(240).map((b, i) => {
      const close = 100 + 2 * i;
      return { ...b, open: close, close, high: close + 1, low: close - 1 };
    });
    const rule = createTheoryStructureRule("theory-stage150", bars)!;
    expect(rule(168, empty).enter).toBe(false);
    expect(rule(169, empty).enter).toBe(true);
    const changed = bars.map((b) => ({ ...b }));
    set(changed, 180, { open: 100, close: 100, high: 101, low: 99 });
    expect(
      createTheoryStructureRule("theory-stage150", changed)!(180, {
        entry: 440,
        entryIndex: 170,
        signalIndex: 169,
      }).exit,
    ).toBe(true);
  });
  it("detects a high flat base breakout with volume rather than low-price range alone", () => {
    const bars = flat();
    for (let i = 0; i <= 120; i++) {
      const close = 50 + (i * 50) / 120;
      set(bars, i, { open: close, close, high: close + 1, low: close - 1 });
    }
    set(bars, 149, {
      open: 100,
      close: 103,
      high: 104,
      low: 100,
      volume: 2000,
    });
    expect(
      createTheoryStructureRule("theory-flat-base", bars)!(149, empty).enter,
    ).toBe(true);
  });
  it("separately exercises trendline and triangle breaks after their anchors confirm", () => {
    const line = flat();
    set(line, 100, { high: 120 });
    set(line, 110, { low: 90 });
    set(line, 120, { high: 115 });
    set(line, 130, { low: 95 });
    set(line, 136, { close: 112, high: 113 });
    expect(
      createTheoryStructureRule("theory-trendline-close", line)!(136, empty)
        .enter,
    ).toBe(true);
    const triangle = flat();
    set(triangle, 100, { low: 90 });
    set(triangle, 110, { high: 115 });
    set(triangle, 120, { low: 95 });
    set(triangle, 130, { high: 110 });
    set(triangle, 136, { close: 109, high: 110 });
    expect(
      createTheoryStructureRule("theory-triangle-close", triangle)!(136, empty)
        .enter,
    ).toBe(true);
  });
  it("arms a confirmed 50% retracement only after its high endpoint is known", () => {
    const bars = flat();
    set(bars, 100, { low: 90 });
    set(bars, 110, { high: 120 });
    set(bars, 120, { open: 106, low: 104.5, close: 107, high: 108 });
    set(bars, 123, { open: 107, low: 106, close: 109, high: 110 });
    const rule = createTheoryStructureRule("theory-fib-reclaim", bars)!;
    expect(rule(120, empty).enter).toBe(false);
    expect(rule(123, empty).enter).toBe(true);
  });
  it("seals the Darvas proxy top and bottom before a volume-confirmed break", () => {
    const bars = flat();
    set(bars, 100, { open: 108, high: 110, close: 108, low: 107 });
    for (let i = 106; i < 125; i++)
      set(bars, i, { open: 105, high: 106, close: 105, low: 104 });
    set(bars, 125, {
      open: 108,
      high: 113,
      close: 112,
      low: 107,
      volume: 2000,
    });
    const rule = createTheoryStructureRule("theory-darvas-close", bars)!;
    expect(rule(106, empty).enter).toBe(false);
    expect(rule(125, empty).enter).toBe(true);
  });
  it("does not backdate a double bottom to its second low; confirmation and neck break are both required", () => {
    const bars = flat();
    set(bars, 100, { low: 90 });
    set(bars, 110, { high: 110 });
    set(bars, 120, { low: 91 });
    set(bars, 130, { open: 100, low: 99, high: 113, close: 112 });
    const rule = createTheoryStructureRule("theory-double-bottom", bars)!;
    for (let i = 120; i < 130; i++) expect(rule(i, empty).enter).toBe(false);
    expect(rule(130, empty).enter).toBe(true);
    // Replacing the neckline break with an inside close removes the entry.
    set(bars, 130, { high: 109, close: 108 });
    expect(
      createTheoryStructureRule("theory-double-bottom", bars)!(130, empty)
        .enter,
    ).toBe(false);
  });
  it("rejects an undercut second bottom beyond the frozen tolerance", () => {
    const bars = flat();
    set(bars, 100, { low: 90 });
    set(bars, 110, { high: 110 });
    set(bars, 120, { low: 80 });
    set(bars, 130, { high: 113, close: 112 });
    expect(
      createTheoryStructureRule("theory-double-bottom", bars)!(130, empty)
        .enter,
    ).toBe(false);
  });
  it("requires higher confirmed highs and lows, then exits a broken frozen structure", () => {
    const bars = flat();
    set(bars, 100, { low: 90 });
    set(bars, 110, { high: 110 });
    set(bars, 120, { low: 95 });
    set(bars, 130, { high: 115 });
    set(bars, 140, { high: 118, close: 117 });
    set(bars, 142, { open: 94, high: 95, low: 92, close: 93 });
    const rule = createTheoryStructureRule("theory-swing-breakout", bars)!;
    expect(rule(133, empty).enter).toBe(false);
    expect(rule(140, empty).enter).toBe(true);
    expect(
      rule(142, { entry: 117, entryIndex: 141, signalIndex: 140 }).exit,
    ).toBe(true);
  });
  it("keeps a flat market inactive for every proxy", () => {
    const bars = flat();
    for (const d of theoryStructureDefinitions) {
      const rule = createTheoryStructureRule(d.id, bars)!;
      expect(
        Array.from(
          { length: bars.length },
          (_, i) => rule(i, empty).enter,
        ).some(Boolean),
        d.id,
      ).toBe(false);
    }
  });
  it("uses delayed confirmation and remains identical under prefix construction and repeated reads", () => {
    const bars = flat(260).map((b, i) => {
      const close = 100 + i * 0.03 + Math.sin(i / 4) * 5;
      return {
        ...b,
        open: close,
        close,
        high: close + 1,
        low: close - 1,
        volume: 1000 + (i % 11) * 50,
      };
    });
    for (const d of theoryStructureDefinitions) {
      const full = createTheoryStructureRule(d.id, bars)!;
      for (let i = 180; i < 250; i += 3) {
        const prefix = createTheoryStructureRule(d.id, bars.slice(0, i + 1))!;
        const p = { entry: 100, entryIndex: 179, signalIndex: 178 };
        expect(full(i, p), `${d.id} at ${i}`).toEqual(prefix(i, p));
        full(i - 2, p);
        expect(full(i, p)).toEqual(prefix(i, p));
      }
    }
  });
  it("does not admit unknown strategy ids", () => {
    expect(createTheoryStructureRule("missing", flat())).toBeNull();
  });
});
