import type { Bar } from "./domain";
import { researchVolumeSeries, type VolumePoint } from "./research-volume";

export const volumeFailureIds = [
  "vp-failure-1",
  "vp-failure-2",
  "vp-failure-3",
  "vp-next-bear-exit",
  "vp-next-wick-exit",
  "vp-next-shape-exit",
] as const;
export type VolumeFailureId = (typeof volumeFailureIds)[number];
export function isVolumeFailure(id: string): id is VolumeFailureId {
  return (volumeFailureIds as readonly string[]).includes(id);
}
const descriptions: Record<VolumeFailureId, [string, string]> = {
  "vp-failure-1": [
    "量价 · 信号后一根假突破退出",
    "放量信号后的第1根收盘失守冻结突破位退出。",
  ],
  "vp-failure-2": [
    "量价 · 信号后两根假突破退出",
    "放量信号后的第1至2根收盘失守冻结突破位退出。",
  ],
  "vp-failure-3": [
    "量价 · 信号后三根假突破退出",
    "放量信号后的第1至3根收盘失守冻结突破位退出。",
  ],
  "vp-next-bear-exit": [
    "量价 · 次根更大量阴线退出",
    "信号下一根成交量严格高于信号量且收盘低于开盘时退出，不要求当根相对昨收下跌。",
  ],
  "vp-next-wick-exit": [
    "量价 · 次根更大量长上影退出",
    "信号下一根成交量严格高于信号量且上影占全幅至少一半时退出，二分之一是工程阈值。",
  ],
  "vp-next-shape-exit": [
    "量价 · 次根更大量形态证伪",
    "信号下一根成交量严格高于信号量，阴线或上影占全幅至少一半任一成立即退出；二分之一是工程阈值。",
  ],
};
function definition(id: VolumeFailureId) {
  return {
    label: descriptions[id][0],
    family: "量价",
    signal: "technical" as const,
    version: `${id}-1`,
    description: `均线上涨位置，涨幅严格大于2%、含当日R≥1.5且首次收盘突破前20根高点入场。${descriptions[id][1]}时钟从放量信号日起算，信号当根不计，等待入场不重启；同时有效的突破逐个冻结，任一个被证伪均退出。开盘低于自身冻结位取消买入；${id.startsWith("vp-failure") ? "不叠加入场后3根守卫，收盘破位仅按信号窗口与共享退出判断。" : "保留入场后3根冻结位守卫。"}输入失效取消待观察证伪窗口并保留数据缺口；共享MA20失守、放量下跌、高位滞涨及最长持有期退出仍有效。收盘确认后下一可成交开盘退出，不能按已知收盘提前卖出。`,
    sources: [
      "volume-price-analysis/SKILL.md",
      "volume-price-analysis/references/vp-patterns.md",
      "volume-price-analysis/references/vp-indicators.md",
      "volume-price-analysis/references/vp-astock-caveats.md",
    ],
  };
}
export const volumeFailureStrategies = {
  "vp-failure-1": definition("vp-failure-1"),
  "vp-failure-2": definition("vp-failure-2"),
  "vp-failure-3": definition("vp-failure-3"),
  "vp-next-bear-exit": definition("vp-next-bear-exit"),
  "vp-next-wick-exit": definition("vp-next-wick-exit"),
  "vp-next-shape-exit": definition("vp-next-shape-exit"),
};
type Breakout = { date: string; level: number; volume: number; index: number };
export type VolumeFailurePoint = VolumePoint & {
  failure: {
    window: number;
    active: {
      date: string;
      level: number;
      volume: number;
      age: number;
      broken: boolean;
      largerVolume: boolean;
    }[];
    bearish: boolean;
    upperWickFraction: number | null;
    triggered: string[];
  };
};
export function researchVolumeFailureSeries(
  id: VolumeFailureId,
  bars: readonly Bar[],
): VolumeFailurePoint[] {
  const base = researchVolumeSeries("vp-breakout-1-5", bars);
  const clock = id.startsWith("vp-failure"),
    window = id === "vp-failure-3" ? 3 : id === "vp-failure-2" ? 2 : 1;
  let candidates: Breakout[] = [];
  return base.map((point, index) => {
    const v = point.values,
      previous = base[index - 1]?.values;
    candidates = candidates.filter((c) => index - c.index <= window);
    const bearish = v.close < v.open;
    const upperWickFraction =
      v.high > v.low
        ? (v.high - Math.max(v.open, v.close)) / (v.high - v.low)
        : null;
    const active = candidates.map((c) => ({
      date: c.date,
      level: c.level,
      volume: c.volume,
      age: index - c.index,
      broken: v.close < c.level,
      largerVolume: v.volume > c.volume,
    }));
    const triggered = point.reason
      ? []
      : active
          .filter((c) =>
            clock
              ? c.broken
              : c.largerVolume &&
                (id === "vp-next-bear-exit"
                  ? bearish
                  : id === "vp-next-wick-exit"
                    ? upperWickFraction !== null && upperWickFraction >= 0.5
                    : bearish ||
                      (upperWickFraction !== null && upperWickFraction >= 0.5)),
          )
          .map((c) => c.date);
    const exit = point.exit || triggered.length > 0;
    const entry =
      !point.reason &&
      !exit &&
      v.location === "up-ma-proxy" &&
      v.grid?.price === "up" &&
      v.ratio5 !== null &&
      v.ratio5 >= 1.5 &&
      v.high20Prior !== null &&
      v.close > v.high20Prior &&
      previous?.high20Prior != null &&
      previous.close <= previous.high20Prior;
    if (point.reason || exit) candidates = [];
    if (entry)
      candidates.push({
        date: point.date,
        level: v.high20Prior!,
        volume: v.volume,
        index,
      });
    const decision = point.reason
      ? "输入不可用，证伪窗口取消"
      : triggered.length
        ? (clock
            ? `信号后${window}根内收盘破位证伪`
            : id === "vp-next-bear-exit"
              ? "次根更大量阴线证伪"
              : id === "vp-next-wick-exit"
                ? "次根更大量长上影证伪"
                : "次根更大量阴线/长上影证伪") +
          (point.exit ? "；共享量价退出同时成立" : "")
        : exit
          ? point.decision
          : entry
            ? "价涨量增突破，冻结信号时钟"
            : "等待信号时钟内的证伪";
    return {
      date: point.date,
      values: v,
      reason: point.reason,
      entry,
      exit,
      decision,
      candidate: null,
      failure: { window, active, bearish, upperWickFraction, triggered },
      ...(entry
        ? {
            ruleStop: {
              price: v.high20Prior!,
              days: clock ? 0 : 3,
              reason: "放量信号冻结突破位",
            },
          }
        : {}),
    };
  });
}
