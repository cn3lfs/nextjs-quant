import type { FormulaRuntime } from "trading-strategies/research/contracts/formula-runtime";
import { evaluateFormula } from "trading-strategies/formula/tdx-formula";

/** Binds the existing interpreted DSL; strategy packages never import its app graph. */
export const researchFormulaRuntime: FormulaRuntime = {
  evaluate: evaluateFormula,
  inspectOriginal(expression, parameters) {
    try {
      evaluateFormula(expression, [], parameters);
      return { runnable: true, reason: null };
    } catch (error) {
      return {
        runnable: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  },
};
