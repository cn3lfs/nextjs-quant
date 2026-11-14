import { z } from "zod";
import {
  factorStrategySchema,
  factorStrategyWarmup,
  factorStrategySignals,
  maCrossStrategy,
} from "trading-strategies";
import {
  backtestRequestSchema,
  maBaselineInputSchema,
  type BacktestRequest,
  type Bar,
  type SignalSeries,
} from "./model.js";
import { validateFiveMinuteFeed, baselineBarOpenTime } from "./data-feed.js";
import { type ExecutionRules } from "./execution.js";
import { EquityAnalyzer } from "./analyzers.js";
import { engineVersion, maBaselineBuildHash } from "./identity.js";
import { runPortfolio } from "./portfolio-engine.js";

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

/** Input/result projection for the existing five-minute page. Execution is
 * exclusively the portfolio engine, including the legacy raw-signal fixture seam.
 */
export function replaySignalSeries(
  raw: BacktestRequest,
  bars: readonly Bar[],
  signals: SignalSeries,
  rules: ExecutionRules,
  progress?: (done: number, total: number) => void,
) {
  const input = backtestRequestSchema.parse(raw);
  if (
    !signals.id ||
    !Number.isInteger(signals.warmupBars) ||
    signals.warmupBars < 0 ||
    signals.values.length !== bars.length ||
    signals.values.some((v) => v !== -1 && v !== 0 && v !== 1)
  )
    throw new Error("策略信号、长度或预热声明非法");
  validateFiveMinuteFeed(input, bars, signals.warmupBars);
  const result = runPortfolio(
    {
      market: "cn-equity",
      initial: input.initial,
      start: input.start,
      end: input.end,
      costs: input.costs,
      calendar: bars.map((b) => b.date),
      instruments: [
        {
          symbol: input.symbol,
          market: "cn-equity",
          bars,
          signalBars: bars,
          execution: {
            evidence: rules.evidence,
            minimum: rules.minimumBuy,
            step: rules.buyStep,
            maximum: rules.maximumOrder,
            limitUp: rules.limitUp,
            limitDown: rules.limitDown,
            tradable: rules.tradable,
          },
          external: {
            signals: bars.map((b, i) => ({
              id: signals.id,
              date: b.date,
              availableAt: b.date,
              entry: signals.values[i] === 1,
              exit: signals.values[i] === -1,
            })),
          },
        },
      ],
      strategies: [
        {
          id: signals.id,
          version: 1,
          market: "cn-equity",
          period: "5m",
          universe: { kind: "symbols", symbols: [input.symbol] },
          entry: { kind: "external", id: signals.id, side: "entry" },
          exit: { rule: { kind: "external", id: signals.id, side: "exit" } },
          sizing: { kind: "weight", weight: 1 },
          sleeve: "main",
        },
      ],
      sleeves: [{ id: "main", share: 1, riskPerTrade: 1, maxPositions: 1 }],
    },
    progress,
  );
  const analyzer = new EquityAnalyzer(input.initial);
  for (const row of result.curve)
    analyzer.observe(row.date.slice(0, 10), row.equity);
  return {
    engineVersion,
    engineHash: maBaselineBuildHash,
    strategyId: signals.id,
    quality: "rule-check-only" as const,
    input,
    cash: result.curve.at(-1)!.cash,
    shares: result.positions.reduce((n, p) => n + p.quantity, 0),
    evaluated: result.curve.length,
    totalReturn: analyzer.totalReturn,
    maxDrawdown: analyzer.maxDrawdown,
    equity: analyzer.equity,
    orders: result.orders.map(
      ({ id, side, signalAt, status, attempts, reason }) => ({
        id,
        side,
        signalAt,
        status,
        attempts,
        reason,
      }),
    ),
    fills: result.fills.map((f) => ({
      orderId: f.orderId,
      side: f.side,
      signalAt: f.signalAt,
      barEnd: f.date,
      executedAt: baselineBarOpenTime(f.date),
      price: f.price,
      shares: f.quantity,
      fee: f.fee,
      cashAfter: f.cashAfter,
      sharesAfter: f.holdingAfter,
    })),
  };
}
export type BacktestResult = ReturnType<typeof replaySignalSeries>;

export function replayFiveMinute(
  raw: StrategyExperimentInput,
  bars: readonly Bar[],
  progress?: (done: number, total: number) => void,
  signalBars: readonly Bar[] = bars,
) {
  const input = strategyExperimentInputSchema.parse(raw);
  const { strategy, ...request } = input;
  if (
    signalBars.length !== bars.length ||
    signalBars.some((b, i) => b.date !== bars[i]!.date)
  )
    throw new Error("信号与原价行情未对齐");
  const signals = strategy
    ? factorStrategySignals(signalBars, strategy)
    : maCrossStrategy(signalBars);
  const result = replaySignalSeries(
    request,
    bars,
    signals,
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
    strategy: strategy
      ? { period: "5m" as const }
      : { fast: 5, slow: 20, period: "5m" as const },
    assumptions: strategy
      ? [
          "技术因子按冻结五分钟行情计算；周期单位为根。退出优先，退出证据缺失时不入场；条件持续满足可再次发出请求，账户不加仓。",
          "递推因子以冻结预热起点初始化；相同冻结输入可复现，不宣称等同全历史递推值。",
          "收盘确认，下一根 open；沪深主板、只做多、100 股整手、T+1，受阻退出保留，期末不虚构平仓。",
          "未还原完整历史交易状态、排队和公司行动；固定实验费用，未认证成交容量；仅作规则自检。",
        ]
      : [
          "SMA5/20 真实交叉，收盘确认后最早下一根 open 成交；不沿用旧 ma-cross 的涨幅、量比或持续匹配条件。",
          "沪深主板、只做多、100 股整手、不加仓、T+1；受阻退出保留，买入失败不自动追单。",
          "五分钟时间戳为右端，成交时间为下一根区间起点；期末持仓按收盘估值，不虚构卖出。",
          "成交量和 high/low 仅作事后保守过滤；历史停牌、ST/IPO 涨跌停和排队未还原，估算非零量不能证明可成交。",
          "不复权；检测到公司行动的输入须拒绝，缺记录不代表无事件；本结果只用于规则自检。",
          "佣金、最低佣金、卖出税费、滑点为固定实验参数；过户费及历史费率变化未还原。",
          "净值按日末显示；最大回撤在逐根五分钟估值上计算，含初始本金。",
        ],
  };
}
export type MaBaselineResult = ReturnType<typeof replayFiveMinute>;
export type StrategyExperimentResult = MaBaselineResult;
