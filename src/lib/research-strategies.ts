import { z } from "zod";
import {
  canslimResearchIds,
  canslimResearchStrategies,
} from "./research-canslim-strategies";
import {
  breakoutRuleIds,
  breakoutRuleStrategies,
} from "./research-breakout-rules";
import { channelStrategies, channelIds } from "./research-channels";
import {
  continuationStrategies,
  continuationIds,
} from "./research-continuation";
import { candleStrategies, candleStrategyIds } from "./research-candles";
import {
  volumeSequenceStrategies,
  volumeSequenceIds,
} from "./research-volume-sequence";
import {
  volumeFailureStrategies,
  volumeFailureIds,
} from "./research-volume-failure";
import {
  volumeStructureStrategies,
  volumeStructureIds,
} from "./research-volume-structure";
import { volumeStrategies, volumeStrategyIds } from "./research-volume";
import {
  volumeContextStrategies,
  volumeContextIds,
} from "./research-volume-context";
import {
  volumeReversalStrategies,
  volumeReversalIds,
} from "./research-volume-reversals";
import {
  technicalStrategies,
  technicalStrategyIds,
} from "./research-technical";

// Only executable strategies belong here. Planned skill ideas stay in the
// inventory and cannot appear as working choices in the research form.
export const researchStrategyIds = [
  "dual-breakout",
  "czsc",
  "ma-cross",
  "dual-breakout-structure",
  ...technicalStrategyIds,
  ...volumeStrategyIds,
  ...volumeReversalIds,
  ...volumeContextIds,
  ...volumeStructureIds,
  ...volumeFailureIds,
  ...volumeSequenceIds,
  ...candleStrategyIds,
  ...continuationIds,
  ...channelIds,
  ...breakoutRuleIds,
  ...canslimResearchIds,
] as const;
export const researchStrategySchema = z.enum(researchStrategyIds);
export type ResearchStrategyId = z.infer<typeof researchStrategySchema>;
type ResearchStrategyDefinition = {
  label: string;
  family: string;
  signal: "dual-breakout" | "czsc" | "ma-cross" | "technical";
  version: string;
  description: string;
  sources: readonly string[];
};
export const researchStrategies: Record<
  ResearchStrategyId,
  ResearchStrategyDefinition
> = {
  ...technicalStrategies,
  ...volumeStrategies,
  ...volumeReversalStrategies,
  ...volumeContextStrategies,
  ...volumeStructureStrategies,
  ...volumeFailureStrategies,
  ...volumeSequenceStrategies,
  ...candleStrategies,
  ...continuationStrategies,
  ...channelStrategies,
  ...breakoutRuleStrategies,
  ...canslimResearchStrategies,
  "dual-breakout": {
    label: "双突破 · 固定持有",
    family: "波段",
    signal: "dual-breakout",
    version: "dual-breakout-1",
    description:
      "既有双突破信号；收盘确认后下一可成交开盘入场，固定交易日退出，期初资金均分。",
    sources: [
      "swing-trader/references/trading-system.md",
      "swing-trader/references/technical-indicators.md",
    ],
  },
  czsc: {
    label: "缠论 · 固定持有",
    family: "缠论",
    signal: "czsc",
    version: "czsc-research-1",
    description:
      "原生引擎逐前缀确认买点，按实际观察日记录；固定交易日退出，期初资金均分。",
    sources: ["chan-theory/references/05-trading-points.md"],
  },
  "ma-cross": {
    label: "双均线趋势 · 既有规则",
    family: "趋势",
    signal: "ma-cross",
    version: "ma-trend-research-1",
    description:
      "复用既有均线自检的趋势、收盘价、涨幅和量比条件；这是趋势持续匹配，不是只在金叉当天发信号。固定交易日退出。",
    sources: ["swing-trader/references/technical-indicators.md"],
  },
  "dual-breakout-structure": {
    label: "双突破 · 结构止损与风险仓位",
    family: "波段",
    signal: "dual-breakout",
    version: "dual-breakout-structure-1",
    description:
      "复用双突破，冻结信号日结构止损位；收盘失守后下一可成交开盘退出，到最长持有期也退出。按开盘已知资金与持仓前收估值、止损距离和预估双边费用控制单笔风险。",
    sources: [
      "swing-trader/references/trading-system.md",
      "stop-loss/references/position-sizing.md",
      "stop-loss/references/methods.md",
    ],
  },
};

export const researchRiskSchema = z
  .object({
    fraction: z.number().finite().min(0.001).max(0.1).default(0.01),
    maxWeight: z.number().finite().min(0.01).max(1).default(0.2),
  })
  .strict();

export function researchStrategyLabel(id: ResearchStrategyId) {
  return researchStrategies[id].label;
}
