import { runBacktest } from "./engine.js";
import {
  maBaselineInputSchema,
  type MaBaselineInput,
  type Bar,
} from "./model.js";
import { maCrossStrategy } from "./strategies/ma-cross.js";

/** The first strategy is a composition of the engine's stable boundaries. */
export function runMaBaseline(
  raw: MaBaselineInput,
  bars: readonly Bar[],
  progress: (done: number, total: number) => void = () => {},
) {
  const input = maBaselineInputSchema.parse(raw);
  const result = runBacktest(
    input,
    bars,
    maCrossStrategy(bars),
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
    strategy: { fast: 5, slow: 20, period: "5m" as const },
    assumptions: [
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
export type MaBaselineResult = ReturnType<typeof runMaBaseline>;
