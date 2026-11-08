import {
  strategyExperimentInputSchema,
  type StrategyExperimentInput,
  type FactorStrategyInput,
} from "./strategy-experiment";
import { defaultBacktestCosts } from "./backtest-costs";

export const costFields = [
  ["commissionBps", "佣金（万分之）"],
  ["minimumCommission", "最低佣金（元）"],
  ["sellTaxBps", "卖出税费（万分之）"],
  ["slippageBps", "单边滑点（万分之）"],
] as const;
export type CostField = (typeof costFields)[number][0];
export type MaDraft = {
  strategy?: FactorStrategyInput;
  symbol: string;
  start: string;
  end: string;
  initial: string;
  costs: Record<CostField, string>;
};
export type ReportTab = "overview" | "evaluation" | "activity" | "evidence";
export type OrderFilter = "all" | "filled" | "rejected" | "pending";
export const orderStatusLabels = {
  all: "全部订单",
  filled: "已成交",
  rejected: "已拒绝",
  pending: "待执行",
} as const;
export function jobStatusLabel(status: string) {
  const labels: Record<string, string> = {
    queued: "排队中",
    running: "运行中",
    completed: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[status] ?? status;
}
export function draftFromInput(input: StrategyExperimentInput): MaDraft {
  return {
    ...(input.strategy ? { strategy: input.strategy } : {}),
    symbol: input.symbol,
    start: input.start,
    end: input.end,
    initial: String(input.initial),
    costs: {
      commissionBps: String(input.costs.commissionBps),
      minimumCommission: String(input.costs.minimumCommission),
      sellTaxBps: String(input.costs.sellTaxBps),
      slippageBps: String(input.costs.slippageBps),
    },
  };
}
export function initialMaDraft(symbol: string, end: string): MaDraft {
  return draftFromInput({
    symbol,
    start: "",
    end,
    initial: 100000,
    costs: defaultBacktestCosts,
  });
}
export function parseMaDraft(
  draft: MaDraft,
):
  | { input: StrategyExperimentInput; error: null }
  | { input: null; error: string } {
  if (!/^(sh60|sz00)\d{4}$/.test(draft.symbol))
    return {
      input: null,
      error: "请输入沪深主板代码，例如 sz000001 或 sh600000。",
    };
  if (!draft.start || !draft.end)
    return { input: null, error: "先读取本地覆盖，或填写开始和结束日期。" };
  if (draft.start > draft.end)
    return { input: null, error: "开始日期不能晚于结束日期。" };
  if (
    !draft.initial.trim() ||
    !Number.isFinite(Number(draft.initial)) ||
    Number(draft.initial) < 1000 ||
    Number(draft.initial) > 1e9
  )
    return { input: null, error: "初始资金须为 1,000 至 1,000,000,000 元。" };
  const costs = { ...defaultBacktestCosts };
  for (const [key, label] of costFields) {
    const value = Number(draft.costs[key]);
    const maximum = key === "minimumCommission" ? 10000 : 1000;
    if (
      !draft.costs[key].trim() ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > maximum
    )
      return { input: null, error: `${label}须填写 0 至 ${maximum} 的数字。` };
    costs[key] = value;
  }
  const parsed = strategyExperimentInputSchema.safeParse({
    ...(draft.strategy ? { strategy: draft.strategy } : {}),
    symbol: draft.symbol,
    start: draft.start,
    end: draft.end,
    initial: Number(draft.initial),
    costs,
  });
  if (!parsed.success)
    return {
      input: null,
      error: parsed.error.issues[0]?.message ?? "实验配置无效。",
    };
  return { input: parsed.data, error: null };
}
export function draftMatchesInput(
  draft: MaDraft,
  input: StrategyExperimentInput,
) {
  const parsed = parseMaDraft(draft);
  return (
    parsed.input !== null &&
    JSON.stringify(parsed.input) ===
      JSON.stringify(strategyExperimentInputSchema.parse(input))
  );
}
