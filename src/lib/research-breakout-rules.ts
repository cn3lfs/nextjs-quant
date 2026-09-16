import { swingSystemBoundary } from "./research-swing-system";
import {
  swingCoreIds,
  isSwingCore,
  swingCoreDefinition,
} from "./research-swing-core";
import type { Bar } from "./domain";
import type { BreakoutPoint } from "../server/breakout";
export const legacyBreakoutRuleIds = [
  "breakout-down-exit",
  "breakout-reverse-line-exit",
  "breakout-touch-3",
  "breakout-span-20",
  "breakout-large-body",
] as const;
export const breakoutRuleIds = [
  ...legacyBreakoutRuleIds,
  ...swingCoreIds,
  "sw-system-combined",
] as const;
export type BreakoutRuleId = (typeof breakoutRuleIds)[number];
type LegacyBreakoutRuleId = (typeof legacyBreakoutRuleIds)[number];
export function isBreakoutRule(id: string): id is BreakoutRuleId {
  return (breakoutRuleIds as readonly string[]).includes(id);
}
const descriptions: Record<LegacyBreakoutRuleId, [string, string]> = {
  "breakout-down-exit": [
    "双突破 · 反向三要素退出",
    "阴实体跌破上升趋势线、支撑位且量比≥1.5才退出；不要求辅助指标或反转蜡烛通过。",
  ],
  "breakout-reverse-line-exit": [
    "双突破 · 反向趋势线退出",
    "阴实体收盘首次跌破当时上升趋势线退出，不额外要求支撑位和量能。",
  ],
  "breakout-touch-3": [
    "双突破 · 三触点过滤",
    "在三要素基础上要求下降趋势线至少3次已确认触及，反向趋势线突破退出。",
  ],
  "breakout-span-20": [
    "双突破 · 二十日趋势线",
    "在三要素基础上要求最近两锚点间隔至少20根交易日线，反向趋势线突破退出。",
  ],
  "breakout-large-body": [
    "双突破 · 放量长实体",
    "在三要素基础上要求阳实体/开盘≥3%、实体/全幅≥60%，反向趋势线突破退出；实体阈值是公开工程定义。",
  ],
};
function definition(id: BreakoutRuleId) {
  if (id === "sw-system-combined")
    return {
      label: "波段 · 双突破五辅助与完整市场过滤",
      family: "波段",
      signal: "technical" as const,
      version: "sw-system-combined-engineering-1",
      sources: [
        "swing-trader/references/trading-system.md",
        "swing-trader/references/technical-indicators.md",
      ],
      description: swingSystemBoundary,
    };
  if (isSwingCore(id)) return swingCoreDefinition(id);
  return {
    label: descriptions[id][0],
    family: "波段",
    signal: "technical" as const,
    version: `${id}-1`,
    sources: [
      "swing-trader/references/trading-system.md",
      "swing-trader/references/technical-indicators.md",
    ],
    description: `复用原双突破诊断的三要素入场：阳实体首次突破下降趋势线及压力位，成交量至少前20根均量1.5倍。${descriptions[id][1]}辅助指标未知不替代三要素判断；缺线或价位按对应条件未知，不造确认。趋势线和价位沿用现有60根结构与距离排序，不冒充原文来源优先、角度或分级仓位。收盘确认后下一可成交开盘执行，反向意图受阻后保留，独立卖出规则、最长持有和组合风控有效；不裸卖空。公司行动证明覆盖研究期及前60根。`,
  };
}
export const breakoutRuleStrategies = Object.fromEntries(
  breakoutRuleIds.map((id) => [id, definition(id)]),
) as Record<BreakoutRuleId, ReturnType<typeof definition>>;
export function breakoutRuleDecision(
  id: LegacyBreakoutRuleId,
  point: BreakoutPoint,
  bar: Bar,
) {
  const valid =
    point.missing.length === 0 &&
    [bar.open, bar.high, bar.low, bar.close, bar.volume].every(
      (value) => Number.isFinite(value) && value > 0,
    ) &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close) &&
    bar.high > bar.low;
  const core = (side: BreakoutPoint["long"]) =>
    [side.checks.trend, side.checks.level, side.checks.volume].every(
      (v) => v === "是",
    );
  const line = point.long.line;
  const span = line ? line.anchors[1].index - line.anchors[0].index : null;
  const body = Math.abs(bar.close - bar.open),
    range = bar.high - bar.low;
  const quality =
    id === "breakout-touch-3"
      ? !!line && line.touches >= 3
      : id === "breakout-span-20"
        ? span !== null && span >= 20
        : id === "breakout-large-body"
          ? bar.close > bar.open &&
            body / bar.open >= 0.03 &&
            range > 0 &&
            body / range >= 0.6
          : true;
  const exit =
    valid &&
    (id === "breakout-down-exit"
      ? core(point.short)
      : point.short.checks.trend === "是");
  return {
    date: point.date,
    entry: valid && !exit && core(point.long) && quality,
    exit,
    reason: valid ? null : point.missing.join("；") || "当根OHLC或成交量无效",
    values: { close: point.close },
    breakout: {
      long: point.long,
      short: point.short,
      span,
      quality,
      bodyFraction: body / bar.open,
      bodyRange: range > 0 ? body / range : null,
    },
  };
}
export type BreakoutRulePoint = ReturnType<typeof breakoutRuleDecision>;
