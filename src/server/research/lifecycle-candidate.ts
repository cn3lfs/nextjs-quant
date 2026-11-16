import { isDeepStrictEqual } from "node:util";
import type { PortfolioRequest } from "quant-backtest";
import {
  strategyObjectSchema,
  type StrategyObjectInput,
  type MarketLowZoneConfig,
} from "trading-strategies";
import { AlertRepository } from "../db/alert-repository";
import { forwardDefinitionHash } from "../db/forward-reference-repository";
import type { ScoreboardRow } from "./validation-model";

export type LifecycleExecutionPolicy = Pick<
  PortfolioRequest,
  "initial" | "sleeves" | "costs"
>;
export type LifecycleCandidateContext = {
  inputHash: string;
  resultHash: string;
  buildHash: string;
  configHash: string;
  manifestPath: string;
  sourceKey: "cn-day" | "crypto-day" | "crypto-4h";
  universeSymbols: string[];
  rawUniverse?: { symbols: string[]; source: string; hash: string };
  detector?: MarketLowZoneConfig;
};
export type LifecycleCandidateSource = {
  strategy: StrategyObjectInput;
  definitionHash: string;
  row: ScoreboardRow;
  executionPolicy: LifecycleExecutionPolicy;
  sourceContext: LifecycleCandidateContext;
};
const key = (id: string, version: number) =>
  `lifecycle-candidate-source:${id}:${version}`;
export function readLifecycleCandidateSource(
  strategy: StrategyObjectInput,
  repo = new AlertRepository(),
) {
  const value = repo.records.read<LifecycleCandidateSource>(
    key(strategy.id, strategy.version),
  );
  if (!value) return null;
  if (
    value.definitionHash !== forwardDefinitionHash(strategy) ||
    !isDeepStrictEqual(
      strategyObjectSchema.parse(value.strategy),
      strategyObjectSchema.parse(strategy),
    )
  )
    throw new Error("同版本L3仓位来源与策略定义不一致");
  return value;
}
export function freezeLifecycleCandidateSource(
  value: LifecycleCandidateSource,
  repo = new AlertRepository(),
) {
  if (
    value.definitionHash !== forwardDefinitionHash(value.strategy) ||
    !(value.executionPolicy.initial > 0) ||
    !value.executionPolicy.costs ||
    !value.executionPolicy.sleeves.length ||
    !value.sourceContext.universeSymbols.length
  )
    throw new Error("Incomplete frozen lifecycle execution policy");
  return repo.atomic(() => {
    const prior = readLifecycleCandidateSource(value.strategy, repo);
    if (prior && !isDeepStrictEqual(prior, value))
      throw new Error("该版本已冻结另一L3执行来源；不能覆盖");
    if (!prior)
      repo.records.save(
        "lifecycle-candidate-source",
        key(value.strategy.id, value.strategy.version),
        value,
      );
    return prior ?? value;
  });
}
