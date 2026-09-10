import { z } from "zod";
import { checkFormula } from "./tdx-formula-check";
import { FormulaError, parseFormula } from "./tdx-formula-syntax";
export const formulaSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(80),
  source: z.string().min(1).max(100000),
  parameters: z.record(z.number().finite()).default({}),
});
export type SavedFormula = z.infer<typeof formulaSchema> & {id: string; updatedAt: number};
export type ScreeningFormula = z.infer<typeof formulaSchema>;
/** The single output is the selection predicate; intermediates never select.
 * Validation is repeated on save, launch and inside the worker, before I/O.
 */
export function validateScreenFormula(input: unknown): ScreeningFormula {
  const formula = formulaSchema.parse(input);
  const program = parseFormula(formula.source);
  checkFormula(program, formula.parameters);
  const outputs = program.filter(s => s.output);
  if (outputs.length !== 1) throw new FormulaError([{line: outputs[1]?.line ?? 1, kind: "parameter", reason: "选股公式必须恰有一个输出；中间变量请用 :="}]);
  return formula;
}
