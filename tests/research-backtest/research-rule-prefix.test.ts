import { describe, expect, it } from "vitest";
import { researchFormulaRuntime } from "~/lib/research/technical/research-formula-runtime";
import { researchStrategyIds } from "~/lib/research/specs/research-strategies";
import {
  isChanFiveMinute,
  isChanZhongyin,
} from "trading-strategies/research/chan/research-chan-native";
import {
  isResearchRule,
  researchRuleSeries,
} from "trading-strategies/research/composition/research-rule-series";

// Extracted unchanged pure-rule observations from the retired adapter contract.
// Native/legacy adapters are not claimed to be executable by this registry test.
describe.each(researchStrategyIds.filter(isResearchRule))(
  "pure rule prefix: %s",
  (id) => {
    const count = isChanFiveMinute(id)
      ? 7
      : id.startsWith("canslim-high") ||
          id.startsWith("sepa-") ||
          id.endsWith("window120")
        ? 370
        : 85;
    const bars = Array.from({ length: count }, (_, i) => {
      const close = 100 + i * 0.03 + Math.sin(i / 3) * 4;
      return {
        date: new Date(Date.UTC(2023, 0, i + 1)).toISOString().slice(0, 10),
        open: close - 0.2,
        close,
        high: close + 1,
        low: close - 1,
        volume: 1000 + (i % 7) * 300,
        amount: close * 1000,
      };
    });
    if (isChanZhongyin(id) || isChanFiveMinute(id))
      for (const bar of bars) bar.date = bar.date.replace("2023-", "2020-");
    const calculate = (input: typeof bars) =>
      researchRuleSeries(
        id,
        input,
        undefined,
        undefined,
        undefined,
        researchFormulaRuntime,
      );
    it("full historical prefix agrees at every research observation", () => {
      const full = calculate(bars);
      expect(full).toHaveLength(bars.length);
      for (let end = bars.length - 4; end <= bars.length; end++)
        expect(calculate(bars.slice(0, end))).toEqual(full.slice(0, end));
    });
    it("appending extreme future observations never changes past outputs", () => {
      const future = [
        ...bars,
        {
          ...bars.at(-1)!,
          date: "2026-01-01",
          open: 10000,
          close: 10000,
          high: 11000,
          low: 9000,
        },
      ];
      expect(calculate(future).slice(0, bars.length)).toEqual(calculate(bars));
    });
    it.each(["missing", "zero-volume", "invalid-ohlc"])(
      "does not fabricate entry on %s observation",
      (kind) => {
        const changed = structuredClone(bars);
        const target = changed.at(-1)!.date;
        if (kind === "missing") changed.pop();
        else if (kind === "zero-volume") changed.at(-1)!.volume = 0;
        else changed.at(-1)!.high = changed.at(-1)!.low - 1;
        expect(
          calculate(changed).filter(
            (point) => point.date === target && point.entry,
          ),
        ).toEqual([]);
      },
    );
  },
);
