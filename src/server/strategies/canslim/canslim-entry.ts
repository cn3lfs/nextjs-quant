import type { Snapshot } from "~/lib/domain";

export function canslimEntry(
  snapshot: Snapshot,
  pivot: number | null,
  marketChange: number | null,
  catalyst: boolean | null,
  now = Date.now(),
) {
  const bars = snapshot.bars;
  const local = new Date(now + 8 * 3600000).toISOString();
  const valid =
    snapshot.period === "day" &&
    bars.length >= 21 &&
    bars.every((b, i) => {
      const time = Date.parse(`${b.date}T00:00:00Z`);
      return (
        /^\d{4}-\d{2}-\d{2}$/.test(b.date) &&
        Number.isFinite(time) &&
        new Date(time).toISOString().slice(0, 10) === b.date &&
        (!i || b.date > bars[i - 1]!.date) &&
        [b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) &&
        b.low > 0 &&
        b.high >= Math.max(b.open, b.close, b.low) &&
        b.low <= Math.min(b.open, b.close) &&
        b.volume > 0 &&
        b.date <= local.slice(0, 10) &&
        !(b.date === local.slice(0, 10) && local.slice(11, 16) < "15:05") &&
        (!snapshot.historicalAsOf || b.date <= snapshot.historicalAsOf)
      );
    });
  const usablePivot =
    pivot !== null && Number.isFinite(pivot) && pivot > 0 ? pivot : null;
  const last = bars.at(-1);
  const volume20 = valid
    ? bars.slice(-21, -1).reduce((sum, b) => sum + b.volume / 20, 0)
    : null;
  const checks = {
    closeAboveConfirmation:
      valid && usablePivot !== null ? last!.close > usablePivot * 1.01 : null,
    volumeConfirmed:
      valid && volume20 !== null ? last!.volume >= volume20 * 1.5 : null,
    withinFivePercent:
      valid && usablePivot !== null ? last!.close <= usablePivot * 1.05 : null,
    marketConfirmed:
      marketChange !== null && Number.isFinite(marketChange)
        ? marketChange > -2
        : null,
    catalystConfirmed: catalyst,
  };
  const required = [
    checks.closeAboveConfirmation,
    checks.volumeConfirmed,
    checks.withinFivePercent,
  ];
  const strength = required.some((v) => v === false)
    ? "weak"
    : required.some((v) => v === null)
      ? "missing"
      : checks.marketConfirmed === true || checks.catalystConfirmed === true
        ? "strong"
        : checks.marketConfirmed === null || checks.catalystConfirmed === null
          ? "missing"
          : "medium";
  return {
    version: "canslim-entry-1",
    asOf: valid ? last!.date : null,
    pivot: usablePivot,
    volume20,
    checks,
    strength,
    warnings: [
      "五项技术入场诊断，不是交易指令。市场跌幅以百分数输入，严格大于-2%。",
      "均量取测试日前20条，不包含测试日；市场和催化剂输入必须由上游提供同截止时点证据。",
      "ST、涨跌停、财报窗口、复牌/上市时长、账户风险、止损与T+1可卖数量仍需核验。",
    ],
  };
}
