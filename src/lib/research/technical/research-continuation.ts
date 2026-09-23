import type { Bar } from "../../domain";
import { threeMethods, ma } from "../../indicators";

export const continuationIds = [
  "three-rising-5",
  "three-rising-6",
  "three-rising-7",
  "three-falling-5-exit",
  "three-falling-6-exit",
  "three-falling-7-exit",
] as const;
export type ContinuationId = (typeof continuationIds)[number];
export function isContinuation(id: string): id is ContinuationId {
  return (continuationIds as readonly string[]).includes(id);
}
const profiles: Record<
  ContinuationId,
  { length: 5 | 6 | 7; bearish: boolean }
> = {
  "three-rising-5": { length: 5, bearish: false },
  "three-rising-6": { length: 6, bearish: false },
  "three-rising-7": { length: 7, bearish: false },
  "three-falling-5-exit": { length: 5, bearish: true },
  "three-falling-6-exit": { length: 6, bearish: true },
  "three-falling-7-exit": { length: 7, bearish: true },
};
function definition(id: ContinuationId) {
  const { length, bearish } = profiles[id];
  return {
    label: `${bearish ? "下降" : "上升"}三法 · ${length}根${bearish ? "退出" : "突破"}`,
    family: "K线持续",
    signal: "technical" as const,
    version: `${id}-1`,
    sources: ["swing-trader/references/trading-system.md"],
    description: `${length}根三法独立工程对照：首尾同向大实体（实体/开盘≥3%、实体/全幅≥60%），中间${length - 2}根均为反向小实体（≤首体50%）且全幅处于首根高低范围，末收严格越过首根高/低。形态前三根收盘首尾方向与延续方向一致；十字或一字线不充当反向小实体。${bearish ? "MA5上穿MA10入场，选定长度下降三法或最长持有期退出，不裸卖空。" : "上升三法入场，同长度下降三法或最长持有期退出。"}数值阈值和均线基线公开为工程定义，未假称原文唯一参数；收盘确认后下一可成交开盘执行，组合风控与逐批T+1继续有效。无公司行动证据须覆盖研究期及前11根，已知除权不计算形态。`,
  };
}
export const continuationStrategies = Object.fromEntries(
  continuationIds.map((id) => [id, definition(id)]),
) as Record<ContinuationId, ReturnType<typeof definition>>;
export function researchContinuationSeries(
  id: ContinuationId,
  bars: readonly Bar[],
) {
  const { length, bearish } = profiles[id],
    fast = ma(bars, 5),
    slow = ma(bars, 10);
  return bars.map((bar, index) => {
    const rising = threeMethods(bars, index, length, "long"),
      falling = threeMethods(bars, index, length, "short");
    const averageWindow = bars.slice(Math.max(0, index - 10), index + 1);
    const averageValid =
      averageWindow.length === 11 &&
      averageWindow.every(
        (b) =>
          Number.isFinite(b.volume) &&
          b.volume > 0 &&
          [b.open, b.high, b.low, b.close].every(
            (x) => Number.isFinite(x) && x > 0,
          ) &&
          b.high >= Math.max(b.open, b.close) &&
          b.low <= Math.min(b.open, b.close) &&
          b.high > b.low,
      );
    const crossed =
      averageValid &&
      fast[index] != null &&
      slow[index] != null &&
      fast[index - 1] != null &&
      slow[index - 1] != null &&
      fast[index]! > slow[index]! &&
      fast[index - 1]! <= slow[index - 1]!;
    const exit = falling.matched;
    return {
      date: bar.date,
      entry: !exit && (bearish ? crossed : rising.matched),
      exit,
      reason: rising.reason,
      values: {
        close: Number.isFinite(bar.close) ? bar.close : null,
        ma5: fast[index] ?? null,
        ma10: slow[index] ?? null,
      },
      continuation: { length, rising, falling, maCross: crossed, averageValid },
    };
  });
}
export type ContinuationPoint = ReturnType<
  typeof researchContinuationSeries
>[number];
