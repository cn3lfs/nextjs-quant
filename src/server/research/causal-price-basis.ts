import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  adjustmentFactors,
  applyAdjustmentAtAnchor,
  parseGbbqFile,
  readStableLocalFile,
  resolveTdxRoot,
} from "tstdx/local";
import type { TdxXdxr } from "tstdx/wire";
import type { Bar } from "trading-strategy-core/bars";
import type { StrategyObjectInput } from "trading-strategies";
import { parseFormula } from "trading-strategies/formula/tdx-formula";
import { actionPrice } from "quant-backtest";
import { researchCorporateActions } from "./corporate-actions";

type FormulaExpression = ReturnType<typeof parseFormula>[number]["expr"];

/** Track the exponent of a common price multiplier in ordinary formula
 * expressions. Unsupported operations require causal prices. */
function formulaPricePower(
  expression: FormulaExpression,
  names: ReadonlyMap<string, number | undefined>,
): number | undefined {
  switch (expression.kind) {
    case "number":
    case "string":
      return 0;
    case "name":
      return names.get(expression.name);
    case "unary": {
      const value = formulaPricePower(expression.value, names);
      return expression.op === "NOT" && value !== undefined ? 0 : value;
    }
    case "binary": {
      const left = formulaPricePower(expression.left, names),
        right = formulaPricePower(expression.right, names);
      if (left === undefined || right === undefined) return undefined;
      switch (expression.op) {
        case "*":
          return left + right;
        case "/":
          return left - right;
        case "+":
        case "-":
          return left === right ? left : undefined;
        case "=":
        case "<>":
        case "!=":
        case ">":
        case ">=":
        case "<":
        case "<=":
          // Only dimensionless comparisons are scale-invariant. Comparing an
          // absolute price with MA(C,n) can flip under floating round-off after
          // a future ex-rights rescale.
          return left === 0 && right === 0 ? 0 : undefined;
        case "AND":
        case "OR":
          return 0;
        default:
          return undefined;
      }
    }
    case "call": {
      const [value, parameter] = expression.args.map((arg) =>
        formulaPricePower(arg, names),
      );
      if (value === undefined || parameter === undefined) return undefined;
      switch (expression.name) {
        case "MA":
        case "EMA":
        case "REF":
        case "HHV":
        case "LLV":
          return parameter === 0 ? value : undefined;
        case "CROSS":
          // Only cross dimensionless series; price-level crosses can flip
          // under a later ex-rights rescale.
          return value === 0 && parameter === 0 ? 0 : undefined;
        default:
          return undefined;
      }
    }
  }
}

function scaleIndependentFormula(
  rule: Extract<StrategyObjectInput["entry"], { kind: "formula" }>,
) {
  const names = new Map<string, number | undefined>([
    ...Object.keys(rule.parameters ?? {}).map(
      (name) => [name.toUpperCase(), 0] as const,
    ),
    ...["O", "H", "L", "C", "OPEN", "HIGH", "LOW", "CLOSE"].map(
      (name) => [name, 1] as const,
    ),
    ...["V", "VOL", "VOLUME", "AMOUNT", "RPS20", "RPS50", "RPS120"].map(
      (name) => [name, 0] as const,
    ),
  ]);
  return parseFormula(rule.source).every(({ name, output, expr }) => {
    const power = formulaPricePower(expr, names);
    if (name) names.set(name, power);
    return power !== undefined && (!output || power === 0);
  });
}

export function requiresCausalPriceBasis(strategy: StrategyObjectInput) {
  return (
    strategy.market === "cn-equity" &&
    [strategy.entry, strategy.exit.rule].some(
      (rule) =>
        rule?.kind === "double-breakout" ||
        rule?.kind === "factor" ||
        rule?.kind === "theory-screener" ||
        (rule?.kind === "formula" && !scaleIndependentFormula(rule)),
    )
  );
}

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type CausalPriceProof = {
  kind: "gbbq-first-raw-anchor-1";
  anchorDate: string;
  actionsSource: string;
  seriesHash: string;
};

export async function readResearchPriceActions(root: string) {
  const { body } = await readStableLocalFile(
    join(resolveTdxRoot(root), "T0002/hq_cache/gbbq"),
  );
  return parseGbbqFile(body);
}

/** Use only effective events at each bar and a fixed first raw observation. */
export function causalResearchPrices(
  raw: Bar[],
  events: readonly TdxXdxr[],
  actionsSource: string,
  sourceIssues: readonly unknown[],
) {
  if (!raw.length || !actionsSource || sourceIssues.length)
    throw new Error(
      "Missing or invalid GBBQ evidence for causal signal prices",
    );
  const first = raw[0]!.date,
    last = raw.at(-1)!.date;
  const effective = events
    .filter((event) => event.date > first && event.date <= last)
    .sort((a, b) => a.date.localeCompare(b.date));
  const actions = researchCorporateActions(
    effective,
    actionsSource,
    first,
    last,
  );
  let cursor = 0;
  for (let index = 1; index < raw.length; index++) {
    let reference = raw[index - 1]!.close;
    while (actions[cursor] && actions[cursor]!.date <= raw[index]!.date) {
      const action = actions[cursor++]!;
      reference = actionPrice(reference, action);
      if (
        (action.rightsPrice ?? 0) < 0 ||
        !Number.isFinite(reference) ||
        reference <= 0
      )
        throw new Error(`Invalid GBBQ ex-rights reference: ${action.date}`);
    }
  }
  const factors = adjustmentFactors(raw, effective);
  const bars = applyAdjustmentAtAnchor(raw, factors, {
    date: first,
    factor: 1,
  });
  if (
    bars.some(
      (bar) => ![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite),
    )
  )
    throw new Error("Invalid GBBQ causal signal prices");
  const proof: CausalPriceProof = {
    kind: "gbbq-first-raw-anchor-1",
    anchorDate: first,
    actionsSource,
    seriesHash: hash([raw, bars]),
  };
  return { bars, proof };
}

/**
 * Re-bind a frozen proof to a filtered raw/signal pair. Only the series hash
 * changes: the fixed first-raw anchor and its GBBQ source remain the evidence
 * that makes every later ratio reproducible. Returns null when the anchor bar
 * did not survive the filter, because a proof without its anchor cannot be
 * recomputed and must not be kept stale.
 */
export function refreshCausalPriceProof(
  proof: CausalPriceProof | undefined,
  raw: readonly Bar[],
  bars: readonly Bar[],
): CausalPriceProof | null {
  if (
    proof?.kind !== "gbbq-first-raw-anchor-1" ||
    !proof.actionsSource ||
    proof.anchorDate !== raw[0]?.date
  )
    return null;
  return { ...proof, seriesHash: hash([raw, bars]) };
}

export function hasCausalPriceProof(
  proof: CausalPriceProof | undefined,
  raw: readonly Bar[],
  bars: readonly Bar[],
) {
  return (
    proof?.kind === "gbbq-first-raw-anchor-1" &&
    !!proof.actionsSource &&
    raw.length > 0 &&
    proof.anchorDate === raw[0]!.date &&
    proof.seriesHash === hash([raw, bars])
  );
}

export const missingCausalPriceBasis =
  "绝对价格或无法证明尺度无关的规则需要逐 bar 因果因子或已验证的拆股复权序列；当前输入缺少该证据";

export class CausalPriceBasisError extends Error {}
