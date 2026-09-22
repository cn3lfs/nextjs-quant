import type { Bar } from "./domain";
import type { BreakoutPoint } from "../server/strategies/breakout/breakout";
import { ma } from "./indicators";
import {
  swingMarketIds,
  researchSwingMarketSeries,
  type SwingMarketEvidence,
} from "./research-swing-market";
import { researchTechnicalMethodSeries } from "./research-technical-methods";
export const swingSystemBoundary =
  "SW11工程组合v1：三要素双突破+既有五辅助计数，≥3票全额、2票半额，MACD/均线方向矛盾禁入；市场必须同日指数价>上升MA20、MACD偏多、广度>1.5，布林与指数量价不得偏空，连续3日中性/波动恐慌/节前两日/事件前两日/10日MA20附近±2%至少3次穿越均禁入。布林与量价中性不冒充看多票；偏空或震荡退出优先。逐项保留状态，不造总分。缺任一必要市场输入不可用。此预设是技术+市场组合；账户停损/3%风险/不摊薄/至少2R分别由具名波段管理模板启用，未启用不宣称完整账户体系。";
type State = "bull" | "bear" | "neutral" | "unknown" | "blocked";
export function swingSystemDecision(input: {
  core: boolean;
  fraction: number;
  market: Record<string, State>;
  aboveRisingMa: boolean | null;
  choppy: boolean | null;
}) {
  const { market: m } = input;
  if (
    input.aboveRisingMa === null ||
    input.choppy === null ||
    swingMarketIds.some((id) => !m[id] || m[id] === "unknown")
  )
    return {
      entry: false,
      exit: false,
      reason: "待数据：完整指数/广度/已知日历及MA20窗口",
    };
  const exit = Object.values(m).includes("bear") || input.choppy;
  const allow =
    input.aboveRisingMa &&
    !input.choppy &&
    m["sw-market-macd"] === "bull" &&
    m["sw-market-breadth"] === "bull" &&
    !Object.values(m).includes("blocked");
  return {
    entry: !exit && allow && input.core && input.fraction > 0,
    exit,
    reason: null,
  };
}
export function researchSwingSystemSeries(
  bars: readonly Bar[],
  points: readonly BreakoutPoint[],
  evidence: readonly SwingMarketEvidence[] = [],
) {
  const components = swingMarketIds.map((id) => ({
    id,
    points: researchSwingMarketSeries(id, bars, evidence),
  }));
  const auxiliary = researchTechnicalMethodSeries("sw-confluence", bars);
  const index = bars.map((b) => {
    const es = evidence.filter((e) => e.date === b.date);
    const e = es.length === 1 ? es[0] : undefined;
    return e?.index &&
      e.index.date === b.date &&
      /^\d{4}-\d{2}-\d{2}$/.test(e.availableDate) &&
      e.availableDate <= b.date &&
      e.source.trim()
      ? e.index
      : { ...b, close: NaN };
  });
  const average = ma(index, 20);
  return bars.map((b, i) => {
    const p = points[i]!,
      a = auxiliary[i]!;
    const states = Object.fromEntries(
      components.map((c) => [c.id, c.points[i]!.market.state]),
    );
    const distances = index
      .slice(Math.max(0, i - 9), i + 1)
      .map((v, j) => v.close / (average[Math.max(0, i - 9) + j] ?? NaN) - 1);
    const choppy =
      distances.length !== 10 || !distances.every(Number.isFinite)
        ? null
        : distances.every((d) => Math.abs(d) <= 0.02) &&
          distances.slice(1).filter((d, j) => d * distances[j]! < 0).length >=
            3;
    const avg = average[i],
      prev = average[i - 1];
    const aboveRisingMa =
      avg == null || prev == null || !Number.isFinite(index[i]!.close)
        ? null
        : index[i]!.close > avg && avg > prev;
    const core =
      p.missing.length === 0 &&
      [p.long.checks.trend, p.long.checks.level, p.long.checks.volume].every(
        (v) => v === "是",
      );
    const decision = swingSystemDecision({
      core,
      fraction: a.entryFraction,
      market: states,
      aboveRisingMa,
      choppy,
    });
    const valid =
      [b.open, b.high, b.low, b.close, b.volume].every(
        (v) => Number.isFinite(v) && v > 0,
      ) &&
      b.high >= Math.max(b.open, b.close) &&
      b.low <= Math.min(b.open, b.close);
    return {
      date: b.date,
      entry: valid && a.reason === null && decision.entry,
      exit: valid && (decision.exit || p.short.checks.trend === "是"),
      reason: valid ? (a.reason ?? decision.reason) : "当日量价无效",
      entryFraction: a.entryFraction,
      values: { close: b.close } as Record<string, number | null>,
      system: { states, aboveRisingMa, choppy, auxiliary: a },
      historyStart: bars[0]!.date,
    };
  });
}
