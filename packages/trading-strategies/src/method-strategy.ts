import {
  strategyObjectSchema,
  type StrategyObjectInput,
} from "./strategy-object.js";

/** A binding names an exact supported engineering variant, never the entire
 * source theory. Other method rows remain available in the reference library.
 */
export const methodStrategyBindings = {
  CH03: {
    rule: "chan-third-buy",
    variant: "native-v22-first-confirmation-fixed-5-bars",
    reason: "串行CZSC已确认三买工程版本；完整原文和其他缠论方法仍为参考",
  },
} as const;
export function strategyForMethod(
  methodId: string,
  settings: Pick<
    StrategyObjectInput,
    "id" | "market" | "universe" | "sizing" | "sleeve"
  > & { firstIndex: number },
) {
  if (methodId !== "CH03")
    throw new Error(
      "Method is reference-only: no exact strategy-object binding",
    );
  const { firstIndex, ...fields } = settings;
  return strategyObjectSchema.parse({
    ...fields,
    version: 1,
    period: "day",
    entry: { kind: "chan-third-buy", firstIndex },
    // The source rule exits at close when index-entryIndex >= 5, then fills
    // at the next open. The execution-day bar is the first completed bar.
    exit: { maxBars: 6 },
  });
}
