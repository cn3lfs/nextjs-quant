import type { Bar } from "./domain";
import { priceChannel } from "./indicators";
import type { RuleStop } from "./research-volume";

const profiles = {
  "flag-10": { length: 10, flag: true },
  "flag-15": { length: 15, flag: true },
  "flag-20": { length: 20, flag: true },
  "triangle-15": { length: 15, flag: false },
  "triangle-20": { length: 20, flag: false },
  "triangle-30": { length: 30, flag: false },
} satisfies Record<string, { length: number; flag: boolean }>;
export type ChannelId = keyof typeof profiles;
export const channelIds = Object.keys(profiles) as [ChannelId, ...ChannelId[]];
export function isChannelStrategy(id: string): id is ChannelId {
  return (channelIds as readonly string[]).includes(id);
}
export function channelWarmupBars(id: ChannelId) {
  const p = profiles[id];
  return p.length + (p.flag ? 6 : 0);
}
export function channelWarmupStart(
  id: ChannelId,
  bars: readonly Bar[],
  start: string,
) {
  const i = bars.findIndex((b) => b.date >= start);
  return bars[Math.max(0, i - channelWarmupBars(id))]?.date ?? start;
}
function definition(id: ChannelId) {
  const { length, flag } = profiles[id];
  return {
    label: `${flag ? "旗形" : "三角形"} · ${length}根通道突破`,
    family: "K线持续",
    signal: "technical" as const,
    version: `${id}-1`,
    sources: ["swing-trader/references/trading-system.md"],
    description: `只用突破前${length}根完整整理线，对高低价分别拟合最小二乘外包络并延长一根；误差≤均价1%，宽度≤均价20%，上下边界各至少两次触及0.1%容差且首尾触点间隔≥半个窗口。${flag ? "前置6根收盘首尾绝对涨跌幅≥8%作为快速旗杆；两条整理线均逆旗杆倾斜，斜率差累计≤初宽20%，回撤不超旗杆50%，整理不超旗杆末价1%。上涨旗杆后向上突破入场，下跌旗杆后向下突破退出。" : "上边斜率负、下边正，末宽≤初宽70%，延长到突破日仍未交叉；收盘上破入场、下破退出。"}当根不参与通道拟合，严格收盘越界才确认。多头信号冻结下沿，入场开盘已失守则拒绝，入场后三根内任一收盘失守后下一可成交开盘退出；相反形态和最长持有期同样退出。次日执行、独立卖出规则与组合风控保留，不裸卖空。阈值及回撤定义为公开工程版本；无公司行动证据覆盖研究期及前${channelWarmupBars(id)}根。`,
  };
}
export const channelStrategies = Object.fromEntries(
  channelIds.map((id) => [id, definition(id)]),
) as Record<ChannelId, ReturnType<typeof definition>>;
const validBar = (bar: Bar) =>
  Number.isFinite(bar.volume) &&
  bar.volume > 0 &&
  [bar.open, bar.high, bar.low, bar.close].every(
    (x) => Number.isFinite(x) && x > 0,
  ) &&
  bar.high >= Math.max(bar.open, bar.close) &&
  bar.low <= Math.min(bar.open, bar.close) &&
  bar.high > bar.low;
export function researchChannelSeries(id: ChannelId, bars: readonly Bar[]) {
  const { length, flag } = profiles[id];
  return bars.map((bar, index) => {
    const start = index - length,
      window = bars.slice(Math.max(0, start), index);
    const channel = window.length === length ? priceChannel(window) : null;
    const pole = flag && start >= 6 ? bars.slice(start - 6, start) : [];
    const poleValid = !flag || (pole.length === 6 && pole.every(validBar));
    const valid = validBar(bar);
    const ready =
      window.length === length && window.every(validBar) && poleValid && valid;
    const poleReturn =
      poleValid && flag ? pole.at(-1)!.close / pole[0]!.close - 1 : null;
    let up = false,
      down = false;
    if (ready && channel?.wellFormed) {
      const c = channel!;
      if (flag) {
        const first = pole[0]!.close,
          last = pole.at(-1)!.close;
        const parallel =
          Math.abs(c.upper.slope - c.lower.slope) * length <=
          c.startWidth * 0.2;
        const min = Math.min(...window.map((b) => b.low)),
          max = Math.max(...window.map((b) => b.high));
        up =
          parallel &&
          poleReturn! >= 0.08 &&
          c.upper.slope < 0 &&
          c.lower.slope < 0 &&
          min >= (first + last) / 2 &&
          max <= last * 1.01;
        down =
          parallel &&
          poleReturn! <= -0.08 &&
          c.upper.slope > 0 &&
          c.lower.slope > 0 &&
          max <= (first + last) / 2 &&
          min >= last * 0.99;
      } else
        up = down =
          c.upper.slope < 0 &&
          c.lower.slope > 0 &&
          c.endWidth <= c.startWidth * 0.7;
    }
    const entry = ready && up && bar.close > channel!.upper.next;
    const exit = ready && down && bar.close < channel!.lower.next;
    const ruleStop: RuleStop | null = entry
      ? { price: channel!.lower.next, days: 3, reason: "冻结整理通道下沿" }
      : null;
    return {
      date: bar.date,
      entry,
      exit,
      reason: ready ? null : "整理或旗杆输入不足、停牌、一字线或无效OHLC",
      values: { close: Number.isFinite(bar.close) ? bar.close : null },
      ruleStop,
      channel: {
        length,
        flag,
        start: window[0]?.date ?? null,
        end: window.at(-1)?.date ?? null,
        geometry: channel,
        poleReturn,
        up,
        down,
      },
    };
  });
}
export type ChannelPoint = ReturnType<typeof researchChannelSeries>[number];
