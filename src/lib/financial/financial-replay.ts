import { z } from "zod";
import { financialIsoDate, financialSymbol } from "./local-financial";

/** Annual financial replay is a rule self-check, never a validated strategy result. */
export const financialReplayPresets = ["magic-formula", "f-score"] as const;
export type FinancialReplayPreset = (typeof financialReplayPresets)[number];
export const financialReplayCostScenarios = [
  "zero-cost",
  "base",
  "double-cost",
] as const;
export type FinancialReplayCostScenario =
  (typeof financialReplayCostScenarios)[number];

export const financialReplayLimits = {
  symbols: 8000,
  years: 20,
  initial: 1e12,
} as const;

export const financialReplayInput = z
  .object({
    symbols: z.array(financialSymbol).min(1).max(financialReplayLimits.symbols),
    firstYear: z.number().int().min(1991).max(2100),
    lastYear: z.number().int().min(1991).max(2100),
    endDate: financialIsoDate,
    initial: z.number().finite().positive().max(financialReplayLimits.initial),
    costScenario: z.enum(financialReplayCostScenarios).default("base"),
    preset: z.enum(financialReplayPresets).default("magic-formula"),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.lastYear < input.firstYear)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastYear"],
        message: "结束年度早于开始年度",
      });
    else if (input.lastYear - input.firstYear + 1 > financialReplayLimits.years)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["lastYear"],
        message: `年度区间最多${financialReplayLimits.years}年`,
      });
    if (new Set(input.symbols).size !== input.symbols.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["symbols"],
        message: "证券池包含重复证券",
      });
    if (input.endDate < `${input.lastYear}-01-01`)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["endDate"],
        message: "结束日期必须覆盖最后年度的首个交易日",
      });
  });
export type FinancialReplayInput = z.infer<typeof financialReplayInput>;

/** Stable order is part of the frozen pool identity, never the user's input order. */
export function normalizeFinancialReplayInput(
  input: FinancialReplayInput,
): FinancialReplayInput {
  return { ...input, symbols: [...input.symbols].sort() };
}

export type FinancialReplaySelection = {
  positions: readonly { symbol: string; weight: number }[];
  cashWeight: number;
};
export type FinancialReplayYearSignal = {
  asOf: string;
  executeAt: string;
  hash: string;
  counts: {
    total: number;
    annualReport: number;
    fScoreComplete: number;
    magicEligible: number;
  };
  /**
   * Fact completeness, independent of whether the economics pass. A complete
   * rule with zero selected names is a legitimate cash year; missing facts are
   * not. `magic` counts rows whose enterprise value, invested capital and EBIT
   * inputs are all known and whose industry identity is not unknown.
   */
  complete?: {
    annualReport: number;
    fScore: number;
    magic: number;
  };
  selections: {
    fScore: FinancialReplaySelection;
    magicFormula: FinancialReplaySelection;
  };
  issues?: readonly { filename: string; reason: string }[];
};

export type FinancialReplayYearStatus = {
  year: number;
  asOf: string;
  executeAt: string;
  hash: string;
  status: "ready" | "blocked";
  reason: string | null;
  counts: FinancialReplayYearSignal["counts"];
  /** Null when the new annual model did not declare completeness. */
  complete: {
    annualReport: number;
    fScore: number;
    magic: number;
  } | null;
  positions: number;
  cashWeight: number | null;
};

export type FinancialReplayTarget = {
  strategyId: string;
  date: string;
  availableAt: string;
  sourceHash: string;
  targets: Record<string, number>;
};

const selectionOf = (
  year: FinancialReplayYearSignal,
  preset: FinancialReplayPreset,
) =>
  preset === "f-score" ? year.selections.fScore : year.selections.magicFormula;

const legacyCompleteness = (year: FinancialReplayYearSignal) => ({
  annualReport: year.counts.annualReport,
  fScore: year.counts.fScoreComplete,
  magic: year.counts.magicEligible,
});

/** A blocked year never becomes an all-cash success: missing facts are
 * evidence failure. A complete rule with zero qualified names stays a valid
 * cash year because the rule itself rejected every candidate. The legacy
 * fallback exists only for reading old CLI inputs, never new qualification. */
export function financialReplayYearStatus(
  year: FinancialReplayYearSignal,
  preset: FinancialReplayPreset,
  options: { legacy?: boolean } = {},
): FinancialReplayYearStatus {
  if (!(year.asOf < year.executeAt))
    throw new Error(`${year.asOf} 的年度信号不得在完成前执行`);
  if (!/^[a-f0-9]{64}$/i.test(year.hash))
    throw new Error("年度信号缺少内容哈希");
  const selection = selectionOf(year, preset),
    positions = selection.positions.length,
    complete =
      year.complete ?? (options.legacy ? legacyCompleteness(year) : null);
  let reason: string | null = null;
  if (!complete) reason = "该年度缺少完整事实声明，不能判定为全现金或阻断";
  else if (!year.counts.total)
    reason = "该年度证券池没有财务记录，不能以空目标代替证据";
  else if (!complete.annualReport)
    reason = "该年度没有可见的年度财报，不能生成年度目标";
  else if (preset === "f-score" && !complete.fScore)
    reason = "该年度没有任何完整九项F-score，不能把缺失事实当作全现金";
  else if (preset === "magic-formula" && !complete.magic)
    reason = "该年度没有任何完整魔法公式事实，不能把缺失事实当作全现金";
  return {
    year: Number(year.executeAt.slice(0, 4)),
    asOf: year.asOf,
    executeAt: year.executeAt,
    hash: year.hash,
    status: reason ? "blocked" : "ready",
    reason,
    counts: year.counts,
    complete,
    positions,
    cashWeight: reason ? null : selection.cashWeight,
  };
}

export function financialReplayBlockedReason(
  years: readonly FinancialReplayYearStatus[],
) {
  if (!years.length)
    return "年度信号为空：没有可验证的年度输入，不能作为全现金结果。";
  const blocked = years.filter((year) => year.status === "blocked");
  if (!blocked.length) return null;
  return `年度证据不足：${blocked
    .map((year) => `${year.year}年（${year.reason}）`)
    .join("；")}。未执行组合回放，不以空目标或现金曲线充当成功结果。`;
}

/** Completed prior-day allocations; the engine executes at the next legal open.
 * A ready year with no selected names is an intentional cash target ({}) and
 * liquidates omitted holdings; an empty year list is missing evidence. */
export function financialReplayTargets(
  years: readonly FinancialReplayYearSignal[],
  strategyId: string,
  preset: FinancialReplayPreset = "magic-formula",
  options: { legacy?: boolean } = {},
): FinancialReplayTarget[] {
  if (!years.length) throw new Error("年度信号为空，不能作为可执行目标");
  return years.map((year) => {
    const status = financialReplayYearStatus(year, preset, options);
    if (status.status === "blocked")
      throw new Error(`${year.asOf} 没有可执行目标；${status.reason}`);
    if (!/^[a-f0-9]{64}$/i.test(year.hash))
      throw new Error(`${year.asOf} 年度信号缺少内容哈希`);
    const selection = selectionOf(year, preset);
    const targets = Object.fromEntries(
      selection.positions.map((row) => [row.symbol, row.weight]),
    );
    if (Object.keys(targets).length !== selection.positions.length)
      throw new Error(`${year.asOf} 年度目标包含重复证券`);
    for (const [symbol, weight] of Object.entries(targets))
      if (!Number.isFinite(weight) || weight < 0 || weight > 1)
        throw new Error(`${year.asOf} ${symbol} 目标权重非法`);
    const total = Object.values(targets).reduce(
      (sum, weight) => sum + weight,
      0,
    );
    if (!Number.isFinite(total) || total > 1 + 1e-10)
      throw new Error(`${year.asOf} 年度目标权重超过100%`);
    return {
      strategyId,
      date: year.asOf,
      availableAt: year.asOf,
      sourceHash: year.hash,
      targets,
    };
  });
}

export const financialReplayStrategyIds = {
  "magic-formula": "financial-replay-magic-annual",
  "f-score": "financial-replay-fscore-annual",
} as const satisfies Record<FinancialReplayPreset, string>;

export const financialReplayBoundary =
  "规则自检：年度信号取自前一完成交易日财报，下一合法开盘执行；当前成分证券池、当前下载修订版财报、历史ST/IPO/排队与到账日未认证；未独立留出验证，不构成可信策略业绩。";

export function financialReplayCostMultiplier(
  scenario: FinancialReplayCostScenario,
) {
  return scenario === "zero-cost" ? 0 : scenario === "base" ? 1 : 2;
}
