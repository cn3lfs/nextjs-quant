import { expect, it } from "vitest";
import {
  theoryDefinitions,
  theoryStrategy,
  prepareStrategy,
  evaluateStrategy,
  studyWarmup,
} from "../src/index.js";
const bars = Array.from({ length: 340 }, (_, i) => {
  const close = 100 + Math.sin(i / 3) * 3 + i / 100;
  return {
    date: new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
    amount: 100000,
  };
});
it("all theory factories use the same evaluator in both market objects and unified catalogue", () => {
  for (const definition of theoryDefinitions) {
    for (const market of ["cn-equity", "crypto"] as const) {
      const strategy = theoryStrategy(definition.id, market, [
        market === "crypto" ? "BTCUSDT" : "sh600000",
      ]);
      const prepared = prepareStrategy(strategy, bars);
      for (const i of [studyWarmup(definition.id), 320, 339]) {
        const position = {
          entry: 101,
          entryIndex: i - 12,
          signalIndex: i - 13,
        };
        const pure = evaluateStrategy(
          { strategyId: definition.id },
          { asOf: bars[i]!.date, bars, index: i, position },
        );
        expect(pure.kind).toBe("signal");
        if (pure.kind !== "signal") throw new Error("Wrong output");
        const actual = prepared.evaluate(i, position);
        expect(actual.exit).toBe(pure.exit);
        expect(actual.entry).toBe(pure.exit ? false : pure.enter);
      }
    }
  }
});
