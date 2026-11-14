import {
  strategySchema,
  type Bar,
  type Monitor,
  type Strategy,
} from "~/lib/domain";
import { type Metrics } from "trading-strategies/research/technical/screening-metrics";
import type { CzscSignalDetails } from "trading-strategies/research/chan/czsc";
import { analyzeCzsc } from "../strategies/chan/czsc";
import { metrics } from "trading-strategies/research/technical/screening-metrics";
import { analyzeBreakout } from "trading-strategies/research/breakout/breakout";
import {
  prepareStrategy,
  selectCzscMonitorSignals,
  type StrategyObjectInput,
} from "trading-strategies";
import { watchStrategy } from "../strategies/drivers/watch";
import { breakoutStrategy } from "../strategies/drivers/strategy-definitions";

export async function monitorStrategy(
  bars: Bar[],
  strategy: Strategy,
  previous: Monitor["states"][string] | undefined,
) {
  const parsed = strategySchema.parse(strategy);
  const series = { symbol: "monitor", market: "cn-equity" as const, bars };
  const definition: StrategyObjectInput = {
    id: "monitor-metrics",
    version: 1,
    market: "cn-equity",
    period: "day",
    universe: { kind: "symbols", symbols: [series.symbol] },
    entry: {
      kind: "screening-metrics",
      fast: parsed.fast,
      slow: parsed.slow,
      minChange: parsed.minChange,
      maxChange: parsed.maxChange,
      minVolumeRatio: parsed.minVolumeRatio,
    },
    exit: {},
    sizing: { kind: "weight", weight: 1 },
    sleeve: "swing",
  };
  if (parsed.type === "dual-breakout") {
    const prepared = bars.length
      ? prepareStrategy(breakoutStrategy([series.symbol]), bars)
      : null;
    const breakout = prepared
        ? prepared.breakoutAt(bars.length - 1)
        : analyzeBreakout(bars),
      p = breakout.latest;
    const qualified = p
      ? [p.long, p.short].filter((s) => s.status === "是")
      : [];
    const observed = qualified.map(
      (s) => `dual-breakout-1:${p!.date}:${s.direction}`,
    );
    const fresh = previous?.signalKeys
      ? observed.filter((k) => !previous.signalKeys!.includes(k))
      : [];
    return {
      value: p
        ? ({
            date: p.date,
            close: p.close,
            change:
              bars.length > 1 ? (p.close / bars.at(-2)!.close - 1) * 100 : 0,
            fast: 0,
            slow: 0,
            volumeRatio: p.volumeRatio ?? 0,
            score: Math.max(p.long.score ?? 0, p.short.score ?? 0),
            matched:
              fresh.length > 0 &&
              bars.at(-1)!.volume > 0 &&
              (watchStrategy(breakoutStrategy([series.symbol]), series, p.date)
                .length > 0 ||
                watchStrategy(
                  breakoutStrategy([series.symbol], "exit"),
                  series,
                  p.date,
                ).length > 0),
          } satisfies Metrics)
        : null,
      previous: previous ? { ...previous, matched: false } : undefined,
      keys: [...new Set([...(previous?.signalKeys ?? []), ...observed])],
      details: undefined,
      breakout,
    };
  }
  if (parsed.type !== "czsc") {
    const value = metrics(bars, parsed);
    return {
      value: value
        ? {
            ...value,
            matched: watchStrategy(definition, series, value.date).length > 0,
          }
        : null,
      previous,
      details: undefined,
      keys: undefined,
    };
  }
  const last = bars.at(-1);
  if (!last)
    return { value: null, previous, details: undefined, keys: undefined };
  const result = await analyzeCzsc(bars, true);
  const family = result.families.find((f) => f.config === parsed.params.config);
  const signals = result.status === "structure" ? (family?.signals ?? []) : [];
  const key = (s: (typeof signals)[number]) =>
    `${parsed.params.config}:${s.date}:${s.kind}`;
  const observations = signals.map((s) => ({
    date: last.date,
    availableAt: last.date,
    endpointDate: s.date,
    config: parsed.params.config,
    key: key(s),
    kind: s.kind,
    quality: s.quality,
  }));
  const selection = selectCzscMonitorSignals(
    observations,
    parsed.params.config,
    last.date,
    previous?.signalKeys,
  );
  const keys = [
    ...new Set([
      ...(previous?.signalKeys ?? []),
      ...selection.qualified.map((s) => s.key),
    ]),
  ];
  // A newly confirmed historical endpoint is an event observed on today's completed
  // bar. First run/resume still establishes a baseline via the existing transition.
  const freshKeys = new Set(selection.fresh.map((s) => s.key));
  const fresh = signals.filter((s) => freshKeys.has(key(s)));
  const details: CzscSignalDetails = {
    strategyVersion: "czsc-monitor-1",
    dllVersion: result.hash.slice(0, 8),
    config: parsed.params.config,
    points: fresh.map((s) => {
      const center = s.centerId
        ? (family?.centers[s.centerId - 1] ?? null)
        : null;
      const d = s.divergence;
      const ratio = (v: number) => (v === 0 ? "未知" : `${v.toFixed(2)}%`);
      return {
        key: key(s),
        date: s.date,
        kind: s.kind,
        quality: s.quality,
        center,
        divergence: d
          ? `${["未给出背驰语义", "趋势背驰", "盘整背驰", "小转大必要条件"][d.semantic] ?? "未知语义"}；C/A MACD柱面积 ${ratio(d.areaRatio)}、价差 ${ratio(d.priceRatio)}、速度 ${ratio(d.speedRatio)}；要素位图 ${d.flags}`
          : "DLL未提供背驰依据，不推断成立",
        // Structural observation conditions, not generated stop-loss advice.
        invalidation:
          Math.abs(s.kind) === 3 && center
            ? `${s.kind > 0 ? `回试低点跌破ZG ${center.ZG.toFixed(2)}` : `回抽高点升破ZD ${center.ZD.toFixed(2)}`}，或原买卖点撤销/质量降为观察`
            : "原买卖点撤销、质量降为观察，或其关联中枢/背驰结构不再成立",
      };
    }),
  };
  const value: Metrics = {
    date: last.date,
    close: last.close,
    change: bars.length > 1 ? (last.close / bars.at(-2)!.close - 1) * 100 : 0,
    fast: 0,
    slow: 0,
    volumeRatio: 0,
    score: 0,
    matched:
      last.volume > 0 &&
      watchStrategy(
        {
          ...definition,
          id: "monitor-czsc",
          entry: { kind: "czsc-monitor", config: parsed.params.config },
        },
        {
          ...series,
          external: {
            monitorCzsc: { observations, seenKeys: previous?.signalKeys },
          },
        },
        last.date,
      ).length > 0,
  };
  return {
    value,
    previous: previous ? { ...previous, matched: false } : undefined,
    details,
    keys,
  };
}
