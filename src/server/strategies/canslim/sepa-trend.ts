import type { Snapshot } from "~/lib/domain";

// Application interpretation of SEPA screening-criteria section 2; not a complete SEPA decision.
export function sepaTrendFacts(snapshot: Snapshot) {
  const bars = snapshot.bars;
  const applicable = snapshot.period === "day";
  const mean = (count: number, offset = 0) =>
    !applicable || bars.length < count + offset
      ? null
      : bars
          .slice(bars.length - count - offset, bars.length - offset)
          .reduce((sum, bar) => sum + bar.close, 0) / count;
  const ma20 = mean(20),
    ma60 = mean(60),
    ma120 = mean(120),
    ma250 = mean(250),
    previousMa120 = mean(120, 20);
  const last = bars.at(-1);
  const asOf = last?.date.slice(0, 10) ?? null;
  const cutoff = asOf
    ? new Date(Date.parse(`${asOf}T00:00:00Z`) - 364 * 86400000)
        .toISOString()
        .slice(0, 10)
    : null;
  const covers52Weeks =
    applicable && !!cutoff && !!bars[0] && bars[0].date.slice(0, 10) <= cutoff;
  const high52 = covers52Weeks
    ? Math.max(
        ...bars.filter((b) => b.date.slice(0, 10) > cutoff!).map((b) => b.high),
      )
    : null;
  const above = (value: number | null) =>
    value === null || !last ? null : last.close > value;
  const checks = {
    closeAboveMa20: above(ma20),
    closeAboveMa60: above(ma60),
    closeAboveMa120: above(ma120),
    ma120Rising:
      ma120 === null || previousMa120 === null ? null : ma120 > previousMa120,
    movingAverageOrder:
      ma20 === null || ma60 === null || ma120 === null
        ? null
        : ma20 > ma60 && ma60 > ma120,
    within25PercentOf52WeekHigh:
      high52 === null || !last ? null : last.close >= high52 * 0.75,
    relativeStrength85: null,
  };
  return {
    version: "sepa-trend-diagnostic-1",
    asOf,
    applicable,
    adjustment: snapshot.adjustment,
    ma20,
    ma60,
    ma120,
    ma250,
    ma120TwentyBarsAgo: previousMa120,
    high52,
    checks,
    gate: Object.values(checks).some((v) => v === false)
      ? "failed"
      : "incomplete",
    warnings: [
      "仅 SEPA 趋势诊断，不是完整 SEPA 策略或买卖结论。基本面、VCP、入场与账户风控尚未完成。",
      "MA120 上行采用与 20 个交易记录前比较，不能证明逐日持续上涨；缺记录时不采用其他均线替代。",
      "52 周按 364 个自然日窗口计算；仅证明快照跨度，停牌/交易日缺失和企业行动需另行核验。",
      "RS 全市场排名缺失，不以个股涨幅冒充相对强度。",
      ...(!applicable ? ["分钟周期不适用日线趋势模板。"] : []),
      ...(!covers52Weeks
        ? ["快照不足 52 周，不能用局部最高价代替 52 周高点。"]
        : []),
    ],
  };
}
