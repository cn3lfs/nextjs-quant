/** All pre-foundation strategies remain readable, but cannot start new work. */
import { maBaselineId } from "quant-backtest";
export { maBaselineId };
export const deprecatedStrategyMessage =
  "该策略已弃用，仅保留历史结果与证据。请使用回测页的双均线基线。";

export const deprecatedStrategyOperations = new Set([
  "backtest",
  "walkForward",
  "screen",
  "formulaScreen",
  "breakout",
  "strategyResearchCreate",
  "strategyResearchRetry",
  "intradayRun",
  "wyckoffAnalyze",
  "chanAnalyze",
  "canslimAnalyze",
  "fundamentalAnalyze",
]);
export const legacyAutomaticStrategiesEnabled = false;

export function strategyLifecycle(id: string) {
  return id === maBaselineId ? ("active" as const) : ("deprecated" as const);
}

export function assertActiveStrategy(id: string) {
  if (strategyLifecycle(id) === "deprecated")
    throw new Error(deprecatedStrategyMessage);
}

/** Kept separate from recorded names, hashes and historical signal versions. */
export function deprecatedStrategyLabel(label: string) {
  return `${label}（已弃用）`;
}
