import type { Bar } from "./domain";
import { ma, macd, kdj, rsi, boll } from "./indicators";

export const technicalStrategyIds = [
  "ma-golden-5-10",
  "ma-golden-10-20",
  "ma-golden-20-60",
  "ma-alignment",
  "macd-golden",
  "macd-golden-positive",
  "macd-histogram-turn",
  "kdj-golden",
  "kdj-extreme",
  "kdj-macd-confirmed",
  "rsi-recovery",
  "rsi-50-cross",
  "boll-middle-cross",
  "boll-band-recovery",
] as const;
export type TechnicalStrategyId = (typeof technicalStrategyIds)[number];
export function isTechnicalStrategy(id: string): id is TechnicalStrategyId {
  return (technicalStrategyIds as readonly string[]).includes(id);
}
const rules: Record<TechnicalStrategyId, [string, string]> = {
  "ma-golden-5-10": ["均线5/10 · 金叉买死叉卖", "MA5上穿MA10买入，下穿退出。"],
  "ma-golden-10-20": [
    "均线10/20 · 金叉买死叉卖",
    "MA10上穿MA20买入，下穿退出。",
  ],
  "ma-golden-20-60": [
    "均线20/60 · 金叉买死叉卖",
    "MA20上穿MA60买入，下穿退出。",
  ],
  "ma-alignment": [
    "均线多头排列 · 进入与失效",
    "首次进入MA5>MA10>MA20>MA60买入，排列失效退出；混合排列不持多。",
  ],
  "macd-golden": [
    "MACD · 金叉买死叉卖",
    "DIF上穿DEA买入，下穿退出；固定12/26/9。",
  ],
  "macd-golden-positive": [
    "MACD · 零轴上金叉",
    "DIF、DEA均大于0的金叉买入，任一位置死叉退出；固定12/26/9。",
  ],
  "macd-histogram-turn": [
    "MACD · 绿柱转缩红柱转缩",
    "负柱首次缩短买入，正柱首次缩短退出；缩短指绝对值严格变小，首次需前两根对照，固定12/26/9。",
  ],
  "kdj-golden": ["KDJ · 金叉买死叉卖", "K上穿D买入，下穿退出；固定9/3/3。"],
  "kdj-extreme": [
    "KDJ · 超卖金叉超买死叉",
    "当前K<20且上穿D买入，当前K>80且下穿D退出；严格阈值，固定9/3/3。",
  ],
  "kdj-macd-confirmed": [
    "KDJ金叉 · MACD方向确认",
    "K上穿D且DIF>DEA买入，K下穿D或DIF下穿DEA退出；方向明确为DIF>DEA，固定9/3/3及12/26/9。",
  ],
  "rsi-recovery": [
    "RSI · 超卖恢复超买回落",
    "RSI6上穿30买入，下穿70退出。原文仅给超买超卖区，本版本将恢复/回落交叉作为交易假设；周期6为显式选择。",
  ],
  "rsi-50-cross": [
    "RSI · 50强弱分界",
    "RSI6上穿50买入，下穿50退出；周期6为显式选择。原文40至60震荡区过滤另作变体。",
  ],
  "boll-middle-cross": [
    "布林 · 中轨上穿下破",
    "收盘上穿中轨买入，下穿退出；固定20/2，复用共享样本标准差。",
  ],
  "boll-band-recovery": [
    "布林 · 下轨反弹上轨回落",
    "收盘从下轨外上穿下轨买入，从上轨外下穿上轨退出；固定20/2。与通达信示例上穿上轨卖出的方向不同。",
  ],
};
function technicalDefinition(id: TechnicalStrategyId) {
  return {
    label: rules[id][0],
    family: "技术指标",
    signal: "technical" as const,
    version: `${id}-1`,
    description: `${rules[id][1]}相等后严格越过视为交叉；只用完成日线，次日可成交开盘执行，最长持有期仍有效。需要独立卖出数量规则，每日最多一笔，受单笔上限截断后跨日继续。单独指标是研究对照，未假定有综合量能确认。`,
    sources: ["swing-trader/references/technical-indicators.md"],
  };
}
export const technicalStrategies = {
  "ma-golden-5-10": technicalDefinition("ma-golden-5-10"),
  "ma-golden-10-20": technicalDefinition("ma-golden-10-20"),
  "ma-golden-20-60": technicalDefinition("ma-golden-20-60"),
  "ma-alignment": technicalDefinition("ma-alignment"),
  "macd-golden": technicalDefinition("macd-golden"),
  "macd-golden-positive": technicalDefinition("macd-golden-positive"),
  "macd-histogram-turn": technicalDefinition("macd-histogram-turn"),
  "kdj-golden": technicalDefinition("kdj-golden"),
  "kdj-extreme": technicalDefinition("kdj-extreme"),
  "kdj-macd-confirmed": technicalDefinition("kdj-macd-confirmed"),
  "rsi-recovery": technicalDefinition("rsi-recovery"),
  "rsi-50-cross": technicalDefinition("rsi-50-cross"),
  "boll-middle-cross": technicalDefinition("boll-middle-cross"),
  "boll-band-recovery": technicalDefinition("boll-band-recovery"),
} satisfies Record<TechnicalStrategyId, ReturnType<typeof technicalDefinition>>;

export type TechnicalValues = {
  close: number | null;
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  dif: number | null;
  dea: number | null;
  histogram: number | null;
  k: number | null;
  d: number | null;
  rsi6: number | null;
  middle: number | null;
  upper: number | null;
  lower: number | null;
};
const required: Record<TechnicalStrategyId, (keyof TechnicalValues)[]> = {
  "ma-golden-5-10": ["ma5", "ma10"],
  "ma-golden-10-20": ["ma10", "ma20"],
  "ma-golden-20-60": ["ma20", "ma60"],
  "ma-alignment": ["ma5", "ma10", "ma20", "ma60"],
  "macd-golden": ["dif", "dea"],
  "macd-golden-positive": ["dif", "dea"],
  "macd-histogram-turn": ["histogram"],
  "kdj-golden": ["k", "d"],
  "kdj-extreme": ["k", "d"],
  "kdj-macd-confirmed": ["k", "d", "dif", "dea"],
  "rsi-recovery": ["rsi6"],
  "rsi-50-cross": ["rsi6"],
  "boll-middle-cross": ["close", "middle"],
  "boll-band-recovery": ["close", "lower", "upper"],
};

/** Decision-only entry point permits hand-worked indicator examples in tests.
 * Production values always come from the shared indicators above. */
export function technicalDecision(
  id: TechnicalStrategyId,
  current: TechnicalValues,
  previous: TechnicalValues | undefined,
  beforePrevious?: TechnicalValues,
) {
  const history =
    id === "macd-histogram-turn"
      ? [current, previous, beforePrevious]
      : [current, previous];
  if (
    history.some(
      (row) =>
        !row ||
        required[id].some(
          (key) => row[key] == null || !Number.isFinite(row[key]),
        ),
    )
  )
    return { entry: false, exit: false, reason: "所需指标尚未可用" };
  const cross = (
    a: keyof TechnicalValues,
    b: keyof TechnicalValues | number,
    up: boolean,
  ) => {
    const now = typeof b === "number" ? b : current[b]!;
    const prior = typeof b === "number" ? b : previous![b]!;
    return up
      ? previous![a]! <= prior && current[a]! > now
      : previous![a]! >= prior && current[a]! < now;
  };
  let entry = false,
    exit = false;
  switch (id) {
    case "ma-golden-5-10":
      entry = cross("ma5", "ma10", true);
      exit = cross("ma5", "ma10", false);
      break;
    case "ma-golden-10-20":
      entry = cross("ma10", "ma20", true);
      exit = cross("ma10", "ma20", false);
      break;
    case "ma-golden-20-60":
      entry = cross("ma20", "ma60", true);
      exit = cross("ma20", "ma60", false);
      break;
    case "ma-alignment": {
      const aligned = (v: TechnicalValues) =>
        v.ma5! > v.ma10! && v.ma10! > v.ma20! && v.ma20! > v.ma60!;
      entry = aligned(current) && !aligned(previous!);
      exit = !aligned(current) && aligned(previous!);
      break;
    }
    case "macd-golden":
    case "macd-golden-positive":
      entry =
        cross("dif", "dea", true) &&
        (id === "macd-golden" || (current.dif! > 0 && current.dea! > 0));
      exit = cross("dif", "dea", false);
      break;
    case "macd-histogram-turn": {
      const now = current.histogram!,
        prior = previous!.histogram!,
        before = beforePrevious!.histogram!;
      entry =
        now < 0 && prior < 0 && now > prior && !(before < 0 && prior > before);
      exit =
        now > 0 && prior > 0 && now < prior && !(before > 0 && prior < before);
      break;
    }
    case "kdj-golden":
    case "kdj-extreme":
    case "kdj-macd-confirmed":
      entry =
        cross("k", "d", true) &&
        (id !== "kdj-extreme" || current.k! < 20) &&
        (id !== "kdj-macd-confirmed" || current.dif! > current.dea!);
      exit =
        (cross("k", "d", false) && (id !== "kdj-extreme" || current.k! > 80)) ||
        (id === "kdj-macd-confirmed" && cross("dif", "dea", false));
      break;
    case "rsi-recovery":
      entry = cross("rsi6", 30, true);
      exit = cross("rsi6", 70, false);
      break;
    case "rsi-50-cross":
      entry = cross("rsi6", 50, true);
      exit = cross("rsi6", 50, false);
      break;
    case "boll-middle-cross":
      entry = cross("close", "middle", true);
      exit = cross("close", "middle", false);
      break;
    case "boll-band-recovery":
      entry = cross("close", "lower", true);
      exit = cross("close", "upper", false);
      break;
  }
  return { entry, exit, reason: null };
}

export function researchTechnicalSeries(
  id: TechnicalStrategyId,
  bars: readonly Bar[],
) {
  if (
    bars.some(
      (bar, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(bar.date) ||
        (i > 0 && bar.date <= bars[i - 1]!.date),
    )
  )
    throw new Error("技术策略日线日期无效或未递增");
  const averages = [5, 10, 20, 60].map((period) => ma(bars, period));
  const momentum = macd(bars),
    stochastic = kdj(bars),
    strength = rsi(bars),
    bands = boll(bars);
  const values: TechnicalValues[] = bars.map((bar, i) => ({
    close: Number.isFinite(bar.close) ? bar.close : null,
    ma5: averages[0]![i]!,
    ma10: averages[1]![i]!,
    ma20: averages[2]![i]!,
    ma60: averages[3]![i]!,
    dif: momentum[i]!.dif,
    dea: momentum[i]!.dea,
    histogram: momentum[i]!.macd,
    k: stochastic[i]!.k,
    d: stochastic[i]!.d,
    rsi6: strength[i]!.rsi6,
    middle: bands[i]!.mid,
    upper: bands[i]!.upper,
    lower: bands[i]!.lower,
  }));
  const valid = (bar: Bar | undefined) =>
    !!bar &&
    Number.isFinite(bar.volume) &&
    bar.volume > 0 &&
    [bar.open, bar.high, bar.low, bar.close].every(
      (v) => Number.isFinite(v) && v > 0,
    ) &&
    bar.high >= Math.max(bar.open, bar.close) &&
    bar.low <= Math.min(bar.open, bar.close);
  return bars.map((bar, i) => {
    const adjacent = [
      bar,
      bars[i - 1],
      ...(id === "macd-histogram-turn" ? [bars[i - 2]] : []),
    ];
    const decision = adjacent.every(valid)
      ? technicalDecision(id, values[i]!, values[i - 1], values[i - 2])
      : { entry: false, exit: false, reason: "相邻日线缺失、停牌或OHLC无效" };
    return {
      date: bar.date,
      ...decision,
      values: values[i]!,
      previous: values[i - 1] ?? null,
      ...(id === "macd-histogram-turn"
        ? { beforePrevious: values[i - 2] ?? null }
        : {}),
    };
  });
}
export type TechnicalPoint = ReturnType<typeof researchTechnicalSeries>[number];
