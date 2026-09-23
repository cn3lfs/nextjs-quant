import {
  strategySchema,
  type Bar,
  type Metrics,
  type Monitor,
  type Strategy,
} from "~/lib/domain";
import type { CzscSignalDetails } from "~/lib/research/methods/chan/czsc";
import { analyzeCzsc } from "../strategies/chan/czsc";
import { metrics } from "~/lib/screening/screening-metrics";
import { analyzeBreakout } from "../strategies/breakout/breakout";

export async function monitorStrategy(
  bars: Bar[],
  strategy: Strategy,
  previous: Monitor["states"][string] | undefined,
) {
  const parsed = strategySchema.parse(strategy);
  if (parsed.type === "dual-breakout") {
    const breakout = analyzeBreakout(bars),
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
            matched: fresh.length > 0 && bars.at(-1)!.volume > 0,
          } satisfies Metrics)
        : null,
      previous: previous ? { ...previous, matched: false } : undefined,
      keys: [...new Set([...(previous?.signalKeys ?? []), ...observed])],
      details: undefined,
      breakout,
    };
  }
  if (parsed.type !== "czsc")
    return {
      value: metrics(bars, parsed),
      previous,
      details: undefined,
      keys: undefined,
    };
  const last = bars.at(-1);
  if (!last)
    return { value: null, previous, details: undefined, keys: undefined };
  const result = await analyzeCzsc(bars, true);
  const family = result.families.find((f) => f.config === parsed.params.config);
  const qualified =
    result.status === "structure"
      ? (family?.signals.filter(
          (s) =>
            [1, 2].includes(s.quality) && [1, 2, 3].includes(Math.abs(s.kind)),
        ) ?? [])
      : [];
  const key = (s: (typeof qualified)[number]) =>
    `${parsed.params.config}:${s.date}:${s.kind}`;
  const keys = [
    ...new Set([...(previous?.signalKeys ?? []), ...qualified.map(key)]),
  ];
  // A newly confirmed historical endpoint is an event observed on today's completed
  // bar. First run/resume still establishes a baseline via the existing transition.
  const fresh = previous?.signalKeys
    ? qualified.filter((s) => !previous.signalKeys!.includes(key(s)))
    : [];
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
    matched: fresh.length > 0 && last.volume > 0,
  };
  return {
    value,
    previous: previous ? { ...previous, matched: false } : undefined,
    details,
    keys,
  };
}
