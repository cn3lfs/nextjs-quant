import { describe, expect, it } from "vitest";
import { prepareStrategy, strategyObjectSchema } from "trading-strategies";
import type { Bar } from "trading-strategy-core/bars";
import { buildStrategy } from "../../../scripts/lib/backtest-diagnose/strategy-specs";

const symbol = "sh600000";
const bars: Bar[] = Array.from({ length: 320 }, (_, index) => {
  const close = index === 319 ? 32 : 30;
  const volume = index === 319 ? 2_000 : 1_000;
  return {
    date: new Date(Date.UTC(2024, 0, 1 + index)).toISOString().slice(0, 10),
    open: close,
    high: close + 0.2,
    low: close - 0.2,
    close,
    volume,
    amount: close * volume,
  };
});

const cases = [
  { key: "dual-ma", entryKind: "dual-ma", entry: true },
  { key: "turtle", entryKind: "study-rule", entry: true },
  { key: "rsi2", entryKind: "study-rule", entry: false },
  { key: "double-breakout", entryKind: "double-breakout", entry: false },
  { key: "formula", entryKind: "formula", entry: true },
  { key: "hold", entryKind: "constant", entry: true },
] as const;

describe.each(["single", "portfolio"] as const)(
  "%s strategy capability",
  (mode) => {
    it.each(cases)(
      "$key parses and evaluates on 320 valid daily bars",
      ({ key, entryKind, entry }) => {
        const symbols = mode === "single" ? [symbol] : [symbol, "sz000001"];
        const strategy = strategyObjectSchema.parse(
          buildStrategy(key, symbols, mode),
        );
        expect(strategy.entry.kind).toBe(entryKind);
        expect(strategy.universe).toMatchObject({ kind: "symbols", symbols });
        expect(strategy.sizing).toMatchObject(
          mode === "single"
            ? { kind: "weight", weight: 1 }
            : { kind: "equal", positions: 2 },
        );
        const decision = prepareStrategy(strategy, bars).evaluate(
          bars.length - 1,
        );
        // The final close crosses MA5/20, clears 20 prior highs on twice the usual
        // volume, and cannot be an oversold RSI2 entry or a two-line breakout.
        expect(decision.entry).toBe(entry);
      },
    );
  },
);

it.each(["ma", "breakout"] as const)(
  "rejects account-only study rule %s through prepareStrategy",
  (strategy) => {
    const accountOnly = strategyObjectSchema.parse({
      ...buildStrategy("hold", [symbol], "single"),
      entry: { kind: "study-rule", strategy, side: "entry" },
    });
    expect(() => prepareStrategy(accountOnly, bars)).toThrow(
      /account-only execution profile/i,
    );
  },
);
