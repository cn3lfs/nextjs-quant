import type { Bar } from "./domain";
import { ma, macd, rsi } from "./indicators";
import {
  candleStrategyIds,
  candleStrategies,
  researchCandleSeries,
} from "./research-candles";
import {
  continuationIds,
  continuationStrategies,
  researchContinuationSeries,
} from "./research-continuation";
import {
  channelIds,
  channelStrategies,
  researchChannelSeries,
} from "./research-channels";

export const patternCombinationIds = [
  "sw-reversal-confirmed",
  "sw-continuation-confirmed",
] as const;
export type PatternCombinationId = (typeof patternCombinationIds)[number];
export function isPatternCombination(id: string): id is PatternCombinationId {
  return (patternCombinationIds as readonly string[]).includes(id);
}
// Source-named shapes retain their existing, independently tested geometry.
export const patternCriteria = [
  ...candleStrategyIds.map((id) => ({
    id,
    method: "SW04",
    group: "reversal",
    criterion: candleStrategies[id].description,
    engineering: true,
  })),
  ...continuationIds.map((id) => ({
    id,
    method: "SW05",
    group: "three-methods",
    criterion: continuationStrategies[id].description,
    engineering: true,
  })),
  ...channelIds.map((id) => ({
    id,
    method: "SW05",
    group: "channel",
    criterion: channelStrategies[id].description,
    engineering: true,
  })),
] as const;
export const patternCombinationBoundary =
  "工程组合v1：十种反转蜡烛复用三根背景方向和既有严格几何；持续形态复用5/6/7根三法、10/15/20根旗形、15/20/30根收敛三角。反转要求形态前三根背景，持续要求既有旗杆/通道。任一多头形态且当日量≥前20根均量1.5倍、DIF>DEA、RSI6>50、收盘>MA5才入场；任一对应空头形态无须量能或指标确认即退出，同日退出优先。每个形态保留具名证据，不以计票替代几何。通道下沿取当日触发候选中最高有效线（并列按ID），冻结三根保护；其余形态以观察日最低价冻结三根保护。收盘确认下一可成交开盘执行，最长持有期仍有效。所有阈值及组合属工程定义，不等于完整波段市场与账户体系；无公司行动证据须覆盖全部输入历史。";
export function patternCombinationDefinition(id: PatternCombinationId) {
  return {
    label:
      id === "sw-reversal-confirmed"
        ? "反转形态 · 量能指标组合"
        : "持续形态 · 量能指标组合",
    family: "波段形态组合",
    signal: "technical" as const,
    version: `${id}-engineering-1`,
    description: patternCombinationBoundary,
    sources: ["swing-trader/references/trading-system.md"],
  };
}
export function patternConfirmation(input: {
  bullish: boolean;
  bearish: boolean;
  volume: number;
  averageVolume: number;
  close: number;
  ma5: number | null;
  dif: number | null;
  dea: number | null;
  rsi6: number | null;
}) {
  const ready =
    Object.values(input).every(
      (v) =>
        typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)),
    ) &&
    input.averageVolume > 0 &&
    input.volume > 0;
  return {
    entry:
      ready &&
      !input.bearish &&
      input.bullish &&
      input.volume >= input.averageVolume * 1.5 &&
      input.close > input.ma5! &&
      input.dif! > input.dea! &&
      input.rsi6! > 50,
    exit: input.bearish,
  };
}
export function researchPatternCombinationSeries(
  id: PatternCombinationId,
  bars: readonly Bar[],
) {
  const fast = ma(bars, 5),
    momentum = macd(bars),
    strength = rsi(bars);
  const shapes =
    id === "sw-reversal-confirmed"
      ? candleStrategyIds.map((id) => ({
          id,
          points: researchCandleSeries(id, bars),
          bearish: id.endsWith("-exit"),
        }))
      : [
          ...continuationIds.map((id) => ({
            id,
            points: researchContinuationSeries(id, bars),
            bearish: id.endsWith("-exit"),
          })),
          ...channelIds.map((id) => ({
            id,
            points: researchChannelSeries(id, bars),
            bearish: false,
          })),
        ];
  return bars.map((bar, i) => {
    const window = bars.slice(Math.max(0, i - 20), i + 1);
    const ready =
      window.length === 21 &&
      window.every(
        (b) =>
          Number.isFinite(b.volume) &&
          b.volume > 0 &&
          [b.open, b.high, b.low, b.close].every(
            (v) => Number.isFinite(v) && v > 0,
          ) &&
          b.high >= Math.max(b.open, b.close) &&
          b.low <= Math.min(b.open, b.close) &&
          b.high > b.low,
      );
    const matched = shapes.filter((s) =>
      s.bearish ? s.points[i]!.exit : s.points[i]!.entry || s.points[i]!.exit,
    );
    const bullish = matched
      .filter((s) => !s.bearish && s.points[i]!.entry)
      .map((s) => s.id);
    const bearish = matched
      .filter(
        (s) => (s.bearish || "channel" in s.points[i]!) && s.points[i]!.exit,
      )
      .map((s) => s.id);
    const averageVolume = ready
      ? window.slice(0, 20).reduce((sum, b) => sum + b.volume, 0) / 20
      : null;
    const decision = patternConfirmation({
      bullish: bullish.length > 0,
      bearish: bearish.length > 0,
      volume: bar.volume,
      averageVolume: averageVolume ?? NaN,
      close: bar.close,
      ma5: fast[i]!,
      dif: momentum[i]!.dif,
      dea: momentum[i]!.dea,
      rsi6: strength[i]!.rsi6,
    });
    const stops = matched
      .flatMap((s) => {
        const p = s.points[i]!;
        return p.entry && "ruleStop" in p && p.ruleStop
          ? [{ id: s.id, ...p.ruleStop }]
          : [];
      })
      .sort((a, b) => b.price - a.price || a.id.localeCompare(b.id));
    const entry = ready && decision.entry;
    return {
      date: bar.date,
      entry,
      exit: ready && decision.exit,
      reason: ready ? null : "形态组合需21根有效价量",
      values: {
        close: Number.isFinite(bar.close) ? bar.close : null,
        averageVolume,
        ma5: fast[i] ?? null,
        dif: momentum[i]!.dif,
        dea: momentum[i]!.dea,
        rsi6: strength[i]!.rsi6,
      },
      pattern: { bullish, bearish, criteriaVersion: "engineering-1" },
      ruleStop: entry
        ? {
            price: stops[0]?.price ?? bar.low,
            days: 3,
            reason: stops[0]?.reason ?? "冻结形态确认日低点",
          }
        : null,
    };
  });
}
