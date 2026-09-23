import type { Bar } from "../../domain";
import { candlePatterns, ma } from "../../indicators";

export const candleStrategyIds = [
  "candle-hammer",
  "candle-morning-star",
  "candle-morning-doji",
  "candle-bull-engulf",
  "candle-bottom-doji",
  "candle-shooting-star-exit",
  "candle-evening-star-exit",
  "candle-bear-engulf-exit",
  "candle-dark-cloud-exit",
  "candle-top-doji-exit",
] as const;
export type CandleStrategyId = (typeof candleStrategyIds)[number];
const names: Record<CandleStrategyId, string> = {
  "candle-hammer": "锤子线",
  "candle-morning-star": "启明星",
  "candle-morning-doji": "早晨之星",
  "candle-bull-engulf": "看涨吞没",
  "candle-bottom-doji": "底部十字星",
  "candle-shooting-star-exit": "射击之星",
  "candle-evening-star-exit": "黄昏之星",
  "candle-bear-engulf-exit": "看跌吞没",
  "candle-dark-cloud-exit": "乌云盖顶",
  "candle-top-doji-exit": "顶部十字星",
};
export function isCandleStrategy(id: string): id is CandleStrategyId {
  return (candleStrategyIds as readonly string[]).includes(id);
}
function definition(id: CandleStrategyId) {
  const bearish = id.endsWith("-exit");
  return {
    label: `${names[id]} · ${bearish ? "均线入场形态退出" : "反转入场"}`,
    family: "K线反转",
    signal: "technical" as const,
    version: `${id}-1`,
    sources: ["swing-trader/references/trading-system.md"],
    description: `${names[id]}独立日线工程对照。${bearish ? "MA5上穿MA10入场，仅选定看空形态或最长持有期退出；不是裸卖空。" : "选定看多形态收盘成立入场，任一五种看空形态或最长持有期退出。"}背景使用形态开始前三根收盘的首尾方向，不声称已知趋势末端。短影≤实体0.25倍、十字星实体≤全幅10%；星形中体≤首体30%，中体与首体跳空，末收越首体中点；早晨之星另要求中体十字。吞没实体严格更大；乌云高开超过前高，收盘严格进入前阳体下半部但未完全吞没。只用有效连续OHLC与正成交量，收盘确认后下一可成交开盘执行，逐批T+1和组合风控仍有效。公司行动证据须覆盖研究期及前11根预热；原文未明确的几何阈值和均线入场是公开工程定义。`,
  };
}
export const candleStrategies = Object.fromEntries(
  candleStrategyIds.map((id) => [id, definition(id)]),
) as Record<CandleStrategyId, ReturnType<typeof definition>>;
const valid = (bar: Bar) =>
  Number.isFinite(bar.volume) &&
  bar.volume > 0 &&
  [bar.open, bar.high, bar.low, bar.close].every(
    (x) => Number.isFinite(x) && x > 0,
  ) &&
  bar.high >= Math.max(bar.open, bar.close) &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high > bar.low;
export function candleWarmupStart(bars: readonly Bar[], start: string) {
  const index = bars.findIndex((b) => b.date >= start);
  return bars[Math.max(0, index - 11)]?.date ?? start;
}
export function researchCandleSeries(
  id: CandleStrategyId,
  bars: readonly Bar[],
) {
  const fast = ma(bars, 5),
    slow = ma(bars, 10),
    bearish = id.endsWith("-exit");
  return bars.map((bar, i) => {
    const window = bars.slice(Math.max(0, i - (bearish ? 10 : 5)), i + 1);
    const ready = window.length === (bearish ? 11 : 6) && window.every(valid);
    const bull = ready ? candlePatterns(bars, i, "long", true) : [];
    const bear = ready ? candlePatterns(bars, i, "short", true) : [];
    const crossed =
      ready &&
      fast[i] != null &&
      slow[i] != null &&
      fast[i - 1] != null &&
      slow[i - 1] != null &&
      fast[i]! > slow[i]! &&
      fast[i - 1]! <= slow[i - 1]!;
    const exit =
      ready && (bearish ? bear.includes(names[id]) : bear.length > 0);
    return {
      date: bar.date,
      entry: ready && !exit && (bearish ? crossed : bull.includes(names[id])),
      exit,
      reason: ready ? null : "形态及背景日线不足、停牌、一字线或OHLC无效",
      values: {
        close: Number.isFinite(bar.close) ? bar.close : null,
        ma5: fast[i] ?? null,
        ma10: slow[i] ?? null,
      },
      candle: {
        selected: names[id],
        bullish: bull,
        bearish: bear,
        maCross: crossed,
        start: window[0]?.date ?? null,
      },
    };
  });
}
export type CandlePoint = ReturnType<typeof researchCandleSeries>[number];
