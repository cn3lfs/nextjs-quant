import type { Bar } from "trading-strategy-core/bars";

export type FormulaRuntime = {
  evaluate(
    expression: string,
    bars: readonly Bar[],
    parameters?: Readonly<Record<string, number>>,
  ): {
    outputs: readonly { name: string; values: readonly (number | null)[] }[];
  };
  inspectOriginal(
    expression: string,
    parameters?: Readonly<Record<string, number>>,
  ): { runnable: boolean; reason: string | null };
};

export function requireFormulaRuntime(
  runtime: FormulaRuntime | undefined,
): FormulaRuntime {
  if (!runtime)
    throw new Error("该策略需要显式提供公式解释器，不可将缺失执行器视为零信号");
  return runtime;
}
