import type { Bar } from "trading-strategy-core/bars";
import {
  atr,
  boll,
  cci,
  ema,
  ma,
  williamsR,
} from "trading-strategy-core/indicators";

/** Fixed, long-only close-confirmed research proxies, not author-system reproductions. */
export const theoryDailyDefinitions = [
  {
    id: "theory-squeeze",
    theoryId: "F04.04",
    name: "BB/KC挤压释放·日线代理",
    family: "突破",
    rule: "BB20/2完全位于EMA20±1.5×SMA-ATR20内时累计准备区间；释放根不纳入区间，5根内首次收盘越冻结高点入场。",
  },
  {
    id: "theory-nr4-close",
    theoryId: "F04.07",
    name: "NR4收盘突破代理",
    family: "突破",
    rule: "前根H-L严格小于其前三根，每个候选仅下一根收盘越前高且最低不破前低才入场；不猜盘中顺序。",
  },
  {
    id: "theory-nr7-close",
    theoryId: "F04.07",
    name: "NR7收盘突破代理",
    family: "突破",
    rule: "前根H-L严格小于其前六根，每个候选仅下一根收盘越前高且最低不破前低才入场；并列不成立。",
  },
  {
    id: "theory-box20",
    theoryId: "F04.03",
    name: "20根紧箱突破代理",
    family: "突破",
    rule: "索引为20倍数的收盘，以最近20根冻结高低；宽度≤10%、上下1%内各至少两次触碰；随后5根内首次收盘突破入场。",
  },
  {
    id: "theory-inside-close",
    theoryId: "F05.03",
    name: "内包母线收盘突破代理",
    family: "突破",
    rule: "前根严格内包母线；仅随后一根收盘越母线高且最低不破母线低入场。",
  },
  {
    id: "theory-pin-confirm",
    theoryId: "F05.02",
    name: "支撑长下影确认代理",
    family: "反转",
    rule: "前根低点距此前20根支撑≤1%，下影≥两倍max(实体,收盘×0.0001)、上影≤全幅20%、收盘位于上部三分之一；下一根收盘越其高且最低不破其低入场。",
  },
  {
    id: "theory-engulf-confirm",
    theoryId: "F05.01",
    name: "下行吞没确认代理",
    family: "反转",
    rule: "前三根收盘下行后出现阳实体吞没前阴实体，下一根收盘越形态高点且最低不破形态低点入场。",
  },
  {
    id: "theory-spring-confirm",
    theoryId: "F08.06",
    name: "有限区间Spring确认代理",
    family: "反转",
    rule: "此前20根宽度≤15%，前根低点跌破此前区间低、收盘收回；下一根收盘越前高且仍在旧区间内、低点未破拒绝根才入场；不是完整威科夫。",
  },
  {
    id: "theory-ema-reclaim",
    theoryId: "F03.05",
    name: "EMA20趋势回踩收复代理",
    family: "回调",
    rule: "EMA20>MA60且MA60高于10根前；前收盘≤前EMA20，本收盘>EMA20入场。",
  },
  {
    id: "theory-boll-reentry",
    theoryId: "F12.02",
    name: "布林下轨回带代理",
    family: "反转",
    rule: "MA60十根漂移绝对值≤2%；前收盘低于BB20/2下轨、本收盘回下轨以上且低于中轨入场；独立环境代理，不等同研究卡冻结区间版本。",
  },
  {
    id: "theory-zscore-reentry",
    theoryId: "F12.08",
    name: "Z分数极端恢复代理",
    family: "反转",
    rule: "MA60十根漂移绝对值≤2%；以含当前已完成根的最近20根收盘计算均值和样本标准差（分母N−1），Z从<-2恢复到≥-1.5且<0入场。",
  },
  {
    id: "theory-bias-reclaim",
    theoryId: "F12.07",
    name: "BIAS负偏离恢复代理",
    family: "反转",
    rule: "收盘>MA60，BIAS20从<-5%恢复到≥-5%且价格上涨入场。",
  },
  {
    id: "theory-cci-reclaim",
    theoryId: "F12.05",
    name: "CCI低区恢复代理",
    family: "反转",
    rule: "收盘>MA60，CCI20从<-100回到≥-100且仍<0入场。",
  },
  {
    id: "theory-williams-reclaim",
    theoryId: "F12.06",
    name: "威廉低区恢复代理",
    family: "反转",
    rule: "收盘>MA60，Williams14从<-80回到≥-80且仍<-50入场。",
  },
  {
    id: "theory-dryup-breakout",
    theoryId: "F08.10",
    name: "缩量后放量确认代理",
    family: "量价",
    rule: "前根量低于其此前20根均量的50%，本根量大于同一冻结均量1.5倍且收盘越前高、收盘>MA60入场；不推断真实机构交易。",
  },
  {
    id: "theory-gap-continuation",
    theoryId: "F05.11",
    name: "缺口续涨收盘代理",
    family: "突破",
    rule: "前根最低高于更前根最高且前收盘>MA60；下一根最低不回补缺口并收盘越前高入场。",
  },
] as const;
export type TheoryDailyId = (typeof theoryDailyDefinitions)[number]["id"];
export const theoryDailyIds = theoryDailyDefinitions.map((d) => d.id);
export const theoryDailyExitRule =
  "入场信号当根SMA-ATR14的0.1倍下移形态低点为固定收盘保护；只在持仓后收盘触保护发退出，不假设保护价成交。不加仓。反转持仓回MA20或满10根退出；趋势跌破此前10根低点或满40根退出。实际成交后才记录持仓。";

type Position = { entry: number; entryIndex: number; signalIndex?: number };
type Setup = { stop: number };
/** Pure lookup after causal preparation: repeated/out-of-order reads cannot change signals. */
export function createTheoryDailyRule(strategy: string, bars: readonly Bar[]) {
  const definition = theoryDailyDefinitions.find((d) => d.id === strategy);
  if (!definition) return null;
  const ranges = atr(bars, 14),
    squeezeAtr = atr(bars, 20);
  const average = ma(bars, 20),
    long = ma(bars, 60),
    exponential = ema(bars, 20);
  const bands = boll(bars, 20, 2),
    commodity = cci(bars, 20),
    williams = williamsR(bars, 14);
  const setups: (Setup | null)[] = bars.map(() => null);
  const reversion = definition.family === "反转";
  const valid = (start: number, end: number) =>
    start >= 0 &&
    bars
      .slice(start, end + 1)
      .every(
        (b) =>
          [b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) &&
          b.volume > 0 &&
          b.low > 0 &&
          b.low <= Math.min(b.open, b.close) &&
          b.high >= Math.max(b.open, b.close),
      );
  const bounds = (start: number, end: number) => ({
    high: Math.max(...bars.slice(start, end + 1).map((b) => b.high)),
    low: Math.min(...bars.slice(start, end + 1).map((b) => b.low)),
  });
  let squeeze: { high: number; low: number; released: number | null } | null =
    null;
  let box: { high: number; low: number; created: number } | null = null;
  for (let i = 70; i < bars.length; i++) {
    if (!valid(i - 69, i) || ranges[i] === null) {
      squeeze = null;
      box = null;
      continue;
    }
    const b = bars[i]!,
      p = bars[i - 1]!,
      before = bars[i - 2]!;
    let enter = false,
      stop = Math.min(p.low, b.low);
    const sideway =
      long[i - 10] !== null && Math.abs(long[i]! / long[i - 10]! - 1) <= 0.02;
    switch (definition.id) {
      case "theory-squeeze": {
        const inside =
          bands[i]!.upper! < exponential[i]! + 1.5 * squeezeAtr[i]! &&
          bands[i]!.lower! > exponential[i]! - 1.5 * squeezeAtr[i]!;
        if (inside) {
          if (!squeeze || squeeze.released !== null)
            squeeze = { high: b.high, low: b.low, released: null };
          else {
            squeeze.high = Math.max(squeeze.high, b.high);
            squeeze.low = Math.min(squeeze.low, b.low);
          }
        } else if (squeeze) {
          squeeze.released ??= i;
          if (b.close < squeeze.low || i - squeeze.released > 4) squeeze = null;
          else if (b.close > squeeze.high) {
            enter = true;
            stop = squeeze.low;
            squeeze = null;
          }
        }
        break;
      }
      case "theory-box20": {
        if (box && (b.close < box.low || i - box.created > 5)) box = null;
        if (box && b.close > box.high) {
          enter = true;
          stop = box.low;
          box = null;
        }
        if (!box && !enter && i % 20 === 0) {
          const edges = bounds(i - 19, i),
            window = bars.slice(i - 19, i + 1);
          if (
            (edges.high - edges.low) / edges.low <= 0.1 &&
            window.filter((x) => x.high >= edges.high * 0.99).length >= 2 &&
            window.filter((x) => x.low <= edges.low * 1.01).length >= 2
          )
            box = { ...edges, created: i };
        }
        break;
      }
      case "theory-nr4-close":
      case "theory-nr7-close": {
        const n = definition.id === "theory-nr4-close" ? 4 : 7;
        enter =
          bars
            .slice(i - n, i - 1)
            .every((x) => p.high - p.low < x.high - x.low) &&
          b.close > p.high &&
          b.low >= p.low;
        stop = p.low;
        break;
      }
      case "theory-inside-close":
        enter =
          p.high < before.high &&
          p.low > before.low &&
          b.close > before.high &&
          b.low >= before.low;
        stop = before.low;
        break;
      case "theory-pin-confirm": {
        const support = bounds(i - 21, i - 2).low,
          width = p.high - p.low;
        enter =
          width > 0 &&
          Math.abs(p.low / support - 1) <= 0.01 &&
          Math.min(p.open, p.close) - p.low >=
            2 * Math.max(Math.abs(p.close - p.open), p.close * 0.0001) &&
          (p.high - Math.max(p.open, p.close)) / width <= 0.2 &&
          (p.close - p.low) / width >= 2 / 3 &&
          b.close > p.high &&
          b.low >= p.low;
        stop = p.low;
        break;
      }
      case "theory-engulf-confirm":
        enter =
          bars[i - 4]!.close > bars[i - 3]!.close &&
          bars[i - 3]!.close > before.close &&
          before.close < before.open &&
          p.close > p.open &&
          p.open <= before.close &&
          p.close >= before.open &&
          b.close > Math.max(p.high, before.high) &&
          b.low >= Math.min(p.low, before.low);
        stop = Math.min(p.low, before.low);
        break;
      case "theory-spring-confirm": {
        const edges = bounds(i - 21, i - 2);
        enter =
          (edges.high - edges.low) / edges.low <= 0.15 &&
          p.low < edges.low &&
          p.close > edges.low &&
          b.close > p.high &&
          b.close < edges.high &&
          b.low >= p.low;
        stop = p.low;
        break;
      }
      case "theory-ema-reclaim":
        enter =
          exponential[i]! > long[i]! &&
          long[i]! > long[i - 10]! &&
          p.close <= exponential[i - 1]! &&
          b.close > exponential[i]!;
        break;
      case "theory-boll-reentry":
        enter =
          sideway &&
          p.close < bands[i - 1]!.lower! &&
          b.close >= bands[i]!.lower! &&
          b.close < average[i]!;
        break;
      case "theory-zscore-reentry": {
        const sd = (bands[i]!.upper! - average[i]!) / 2,
          prevSd = (bands[i - 1]!.upper! - average[i - 1]!) / 2;
        enter =
          sideway &&
          sd > 0 &&
          prevSd > 0 &&
          (p.close - average[i - 1]!) / prevSd < -2 &&
          (b.close - average[i]!) / sd >= -1.5 &&
          b.close < average[i]!;
        break;
      }
      case "theory-bias-reclaim":
        enter =
          b.close > long[i]! &&
          p.close / average[i - 1]! - 1 < -0.05 &&
          b.close / average[i]! - 1 >= -0.05 &&
          b.close > p.close;
        break;
      case "theory-cci-reclaim":
        enter =
          b.close > long[i]! &&
          commodity[i - 1] !== null &&
          commodity[i] !== null &&
          commodity[i - 1]! < -100 &&
          commodity[i]! >= -100 &&
          commodity[i]! < 0;
        break;
      case "theory-williams-reclaim":
        enter =
          b.close > long[i]! &&
          williams[i - 1] !== null &&
          williams[i] !== null &&
          williams[i - 1]! < -80 &&
          williams[i]! >= -80 &&
          williams[i]! < -50;
        break;
      case "theory-dryup-breakout": {
        const volume =
          bars.slice(i - 21, i - 1).reduce((s, x) => s + x.volume, 0) / 20;
        enter =
          p.volume < volume * 0.5 &&
          b.volume > volume * 1.5 &&
          b.close > p.high &&
          b.close > long[i]!;
        stop = p.low;
        break;
      }
      case "theory-gap-continuation":
        enter =
          p.low > before.high &&
          p.close > long[i - 1]! &&
          b.low > before.high &&
          b.close > p.high;
        stop = before.high;
        break;
    }
    if (enter && stop > 0 && stop < b.close)
      setups[i] = { stop: stop - 0.1 * ranges[i]! };
  }
  return (index: number, position: Position) => {
    const b = bars[index];
    if (!b || index < 70) return { enter: false, exit: false };
    // entryIndex denotes the actual next-session fill; freeze its preceding signal.
    const anchor = setups[position.signalIndex ?? position.entryIndex - 1];
    const hasPosition = position.entry > 0 && position.entryIndex <= index;
    const timed = index - position.entryIndex >= (reversion ? 10 : 40);
    const exit =
      hasPosition &&
      ((anchor !== undefined && anchor !== null && b.close <= anchor.stop) ||
        timed ||
        (reversion
          ? average[index] !== null && b.close >= average[index]!
          : index >= 10 && b.close < bounds(index - 10, index - 1).low));
    return { enter: !hasPosition && setups[index] !== null, exit };
  };
}
