import type { z } from "zod";
import {
  formulaDraftSchema,
  formulaPrompt,
  type FormulaDraft,
} from "~/lib/formula/formula-from-text";
import { validateScreenFormula } from "~/lib/formula/formula-screen";
import {
  FormulaError,
  type FormulaIssue,
} from "~/lib/formula/tdx-formula-syntax";
import { researchModel, structured } from "../research/research";

type Complete = (
  prompt: string,
  schema: z.ZodType<FormulaDraft>,
) => Promise<{ data: FormulaDraft; tokens: number }>;

export type FormulaFromText =
  | (FormulaDraft & { ok: true; tokens: number; attempts: number })
  | {
      ok: false;
      tokens: number;
      attempts: number;
      source: string;
      issues: FormulaIssue[];
      unsupported: string[];
    };

/**
 * Natural-language request → checked selection formula. The model only drafts
 * formula text; the same validation used on save/launch decides, and a draft
 * that still fails after one repair round is returned with its issues rather
 * than run or guessed at. Nothing executes until the user launches it.
 */
export async function formulaFromText(
  request: string,
  signal?: AbortSignal,
  complete: Complete = (prompt, schema) =>
    structured(prompt, schema, researchModel(false), signal),
): Promise<FormulaFromText> {
  let tokens = 0,
    issues: FormulaIssue[] = [],
    previous: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const { data, tokens: used } = await complete(
      formulaPrompt(request, issues, previous),
      formulaDraftSchema,
    );
    tokens += used;
    // A model that finds nothing expressible may answer with an empty formula;
    // that is the documented "select nothing" formula, not a failure.
    if (!data.source) data.source = "0;";
    try {
      validateScreenFormula({ name: "一句话选股", source: data.source });
      return { ...data, ok: true, tokens, attempts: attempt };
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      issues = error.issues;
      previous = data.source;
      if (attempt === 2)
        return {
          ok: false,
          tokens,
          attempts: attempt,
          source: data.source,
          issues,
          unsupported: data.unsupported,
        };
    }
  }
  throw new Error("unreachable");
}
