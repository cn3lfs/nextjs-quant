import type { Bar } from "trading-strategy-core/bars";
import { ma, rsi, boll } from "trading-strategy-core/indicators";
import { calculateFactor } from "trading-strategy-core/factors";
import { createExtendedStudyRule } from "./study-rules.js";
import type { StudyStrategy } from "./study-catalog.js";
import {
  createNativeStudyRule,
  isNativeStudyStrategy,
  type FrozenChanObservation,
  type NativeStudyStrategy,
} from "./native-study.js";
export type StudyOrder = {
  side: "buy" | "sell";
  quantity?: number;
  fraction?: number;
  reason: string;
  signalDate: string;
};
export type StudyDecisionState = {
  cash: number;
  shares: number;
  entry: number;
  entryIndex: number;
  anchor: number;
  core: number;
  sleeveCap: number;
  initialized: boolean;
  lastAllocationMonth: string;
  installments: number;
};
/** Pure allocation and entry/exit policy; account changes occur only after execution. */
export function createStudyDecision(
  strategy: StudyStrategy | NativeStudyStrategy,
  bars: readonly Bar[],
  signal: readonly Bar[],
  initial: number,
  first: number,
  nativeObservations?: readonly FrozenChanObservation[],
) {
  if (isNativeStudyStrategy(strategy)) {
    if (!nativeObservations) throw new Error("原生策略缺少逐前缀观察输入");
    const rule = createNativeStudyRule(signal, first, nativeObservations);
    return (i: number, state: StudyDecisionState): StudyOrder | null => {
      const { enter, exit } = rule(i, state);
      const side =
        state.shares > 0 ? (exit ? "sell" : null) : enter ? "buy" : null;
      if (!side) return null;
      return {
        side,
        ...(side === "sell" ? { quantity: state.shares } : {}),
        reason:
          side === "buy" ? "原生三买首次收盘确认" : "原生三买固定持有5日退出",
        signalDate: bars[i]!.date,
      };
    };
  }
  if (nativeObservations !== undefined)
    throw new Error("行情规则不得覆盖为原生观察输入");
  const o = { strategy, initial };
  const fast = ma(signal, 5),
    mid = ma(signal, 20),
    slow = ma(signal, 60),
    long = ma(signal, 120),
    strength = rsi(signal),
    bands = boll(signal, 20, 2);
  const extendedRule = createExtendedStudyRule(o.strategy, signal);
  const volatility =
    o.strategy === "vol-target"
      ? calculateFactor(signal, {
          id: "return-volatility",
          parameters: { period: 20 },
        }).values
      : [];
  const extrema = (i: number, n: number, key: "high" | "low") => {
    const values = signal.slice(i - n, i).map((b) => b[key]);
    return key === "high" ? Math.max(...values) : Math.min(...values);
  };
  return function decide(
    i: number,
    state: StudyDecisionState,
  ): StudyOrder | null {
    const {
      cash,
      shares,
      entry,
      entryIndex,
      anchor,
      core,
      sleeveCap,
      initialized,
      lastAllocationMonth,
      installments,
    } = state;
    const b = signal[i]!,
      initialMode = ["hold", "hold80", "grid"].includes(o.strategy);
    const order = (
      side: "buy" | "sell",
      reason: string,
      quantity?: number,
    ): StudyOrder => ({ side, reason, quantity, signalDate: b.date });
    if (["vol-target", "constant-mix", "cppi"].includes(o.strategy)) {
      const initialDecision = i === first - 1;
      const month = b.date.slice(0, 7);
      if (
        o.strategy === "constant-mix" &&
        !initialDecision &&
        month === lastAllocationMonth
      )
        return null;
      if (
        o.strategy === "vol-target" &&
        !initialDecision &&
        new Date(b.date).getUTCDay() !== 5
      )
        return null;
      const investable = cash + shares * bars[i]!.close;
      let target = 0.8;
      if (o.strategy === "cppi")
        target = Math.min(
          1,
          (3 * Math.max(investable - o.initial * 0.8, 0)) / investable,
        );
      if (o.strategy === "vol-target") {
        const vol = volatility[i];
        if (vol === null || vol === undefined) return null;
        target =
          vol === 0 ? 1 : Math.min(1, 0.15 / ((vol / 100) * Math.sqrt(252)));
      }
      const desired =
        Math.floor((investable * target) / bars[i]!.close / 100) * 100;
      const change = desired - shares;
      // Zero-lot adjustments are a completed observation, not a rejected order.
      if (change === 0) {
        state.lastAllocationMonth = month;
        return null;
      }
      return order(
        change > 0 ? "buy" : "sell",
        `目标权重${(target * 100).toFixed(2)}%`,
        Math.abs(change),
      );
    }
    if (o.strategy === "dca") {
      if (installments >= 12 || b.date.slice(0, 7) === lastAllocationMonth)
        return null;
      return {
        ...order("buy", `分批建仓第${installments + 1}批`),
        fraction: 1 / 12,
      };
    }
    if (initialMode) {
      if (!initialized)
        return {
          ...order("buy", "期初建仓"),
          fraction: o.strategy === "hold" ? 1 : 0.8,
        };
      if (o.strategy !== "grid") return null;
      if (b.close >= anchor * 1.04 && shares > core)
        return order("sell", "网格上涨4%", Math.min(100, shares - core));
      if (b.close <= anchor * 0.96 && shares - core < sleeveCap)
        return order("buy", "网格下跌4%", 100);
      return null;
    }
    let enter = false,
      exit = false;
    if (o.strategy === "ma") {
      enter = fast[i]! > mid[i]!;
      exit = fast[i]! < mid[i]!;
    }
    if (o.strategy === "breakout") {
      enter = b.close > extrema(i, 55, "high");
      exit = b.close < extrema(i, 20, "low");
    }
    if (o.strategy === "pullback") {
      enter =
        b.close > long[i]! &&
        mid[i]! > slow[i]! &&
        b.close < mid[i]! &&
        strength[i]!.rsi6 !== null &&
        strength[i]!.rsi6! < 40;
      exit =
        (strength[i]!.rsi6 !== null && strength[i]!.rsi6! > 70) ||
        b.close < long[i]! ||
        b.close < entry * 0.92;
    }
    if (o.strategy === "range") {
      enter =
        Math.abs(slow[i]! / slow[i - 20]! - 1) <= 0.03 &&
        bands[i]!.upper! > bands[i]!.lower! &&
        b.close <= bands[i]!.lower!;
      exit =
        b.close >= bands[i]!.mid! ||
        i - entryIndex >= 20 ||
        b.close < entry * 0.92;
    }
    let entryFraction: number | undefined;
    if (extendedRule)
      ({ enter, exit, entryFraction } = extendedRule(i, { entry, entryIndex }));
    return shares > 0
      ? exit
        ? order("sell", "规则退出", shares)
        : null
      : enter
        ? {
            ...order("buy", "规则入场"),
            ...(entryFraction === undefined ? {} : { fraction: entryFraction }),
          }
        : null;
  };
}
