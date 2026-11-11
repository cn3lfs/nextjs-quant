import {
  backtestRequestSchema,
  maBaselineInputSchema,
  type Bar,
} from "./model.js";
import {
  factorStrategySchema,
  factorStrategySignals,
  factorStrategyWarmup,
} from "trading-strategies";
import { runBacktest } from "./engine.js";
import { runMaBaseline, type MaBaselineResult } from "./ma-baseline.js";
import { z } from "zod";

/** Absence of strategy preserves the original SMA5/20 baseline contract. */
export const strategyExperimentInputSchema = backtestRequestSchema
  .extend({
    symbol: maBaselineInputSchema.innerType().shape.symbol,
    strategy: factorStrategySchema.optional(),
  })
  .refine((v) => v.start <= v.end, "开始日期不能晚于结束日期");
export type StrategyExperimentInput = z.infer<
  typeof strategyExperimentInputSchema
>;
export function strategyExperimentWarmup(input: StrategyExperimentInput) {
  return input.strategy ? factorStrategyWarmup(input.strategy) : 20;
}
export type StrategyExperimentResult = Omit<
  MaBaselineResult,
  "input" | "strategy"
> & {
  input: StrategyExperimentInput;
  strategy: { period: "5m"; fast?: number; slow?: number };
};
export function runStrategyExperiment(
  raw: StrategyExperimentInput,
  bars: readonly Bar[],
  progress: (done: number, total: number) => void = () => {},
): StrategyExperimentResult {
  const input = strategyExperimentInputSchema.parse(raw);
  const { strategy, ...request } = input;
  if (!strategy) return { ...runMaBaseline(request, bars, progress), input };
  const result = runBacktest(
    request,
    bars,
    factorStrategySignals(bars, strategy),
    {
      evidence: "ohlcv-conservative-experiment-1：非历史交易状态认证",
      minimumBuy: 100,
      buyStep: 100,
      maximumOrder: 100000000,
      limitUp: null,
      limitDown: null,
      tradable: true,
    },
    progress,
  );
  return {
    ...result,
    input,
    strategy: { period: "5m" },
    assumptions: [
      "技术因子按冻结五分钟行情计算；周期单位为根。退出优先，退出证据缺失时不入场；条件持续满足可再次发出请求，账户不加仓。",
      "递推因子以冻结预热起点初始化；相同冻结输入可复现，不宣称等同全历史递推值。",
      "收盘确认，下一根 open；沪深主板、只做多、100 股整手、T+1，受阻退出保留，期末不虚构平仓。",
      "未还原完整历史交易状态、排队和公司行动；固定实验费用，未认证成交容量；仅作规则自检。",
    ],
  };
}
