export const accountRiskRules = {
  day2: "RK-E-daily",
  week6: "RK-E-weekly",
  month6: "RK-E-monthly",
  "streak5-half": "RK-E-streak",
  drawdown10: "RK-E-drawdown",
  equity20: "RK-E-equity",
  week3r: "RK-E-week3r",
  elder6: "RK-E-elder2-6",
  "month-win35": "SW-P-month-win",
  "month-rr15": "SW-P-month-rr",
  "month-negative3": "SW-P-month-negative3",
  "day5-week": "SW-P-day5-week",
  "loss5-week": "SW-P-loss5-week",
  "drawdown15-week": "SW-P-dd15-week",
} as const;
export type AccountRiskRule = keyof typeof accountRiskRules;
export const accountRiskBoundary =
  "账户纪律工程v1：逐独立分区结算，已完成交易费用后净损益，零收益计非胜且打断连亏。日频日亏阈值收盘确认后暂停下一交易日（2%版）或随后5个已提供交易日（5%版），不冒充盘中即时熔断。周/月6%以期初权益为基准，Elder6以当月峰值回撤且单笔2%上限；当期禁止新仓，下期恢复。周3R为完整已结算交易净损益/初始规划风险之和，周切换恢复。连亏5笔将新仓风险与市值预算各减半（不强卖存量），直到触发后累计已实现R>0；5笔休息版暂停当日余下时段和随后5交易日。回撤10%/15%版本暂停随后5交易日，恢复时重置峰值基准，不声称原文唯一恢复标准。权益MA20使用含当日完整权益的20点均值，低于暂停，收盘回到均线及以上后次日恢复；预热/陈旧估值不准新仓。月度胜率<35%或净盈利金额均值/净亏损金额均值<1.5连续2完整月、月收益连续3完整月为负，暂停5交易日；首个不完整研究月不参与，零交易/缺少盈或亏的月不可用并中断统计连续性，触发后重置计数。期末暂停余日按日历索引保留，超出快照的暂停结束/恢复日期均null，不生成交易日。";
const month = (date: string) => date.slice(0, 7);
function week(date: string) {
  const d = new Date(date + "T00:00:00Z"),
    day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day);
  return d.toISOString().slice(0, 10);
}
export function researchAccountRisk(
  rule: AccountRiskRule,
  calendar: readonly string[],
  initial: number,
) {
  let through = -1,
    periodBlocked: string | null = null,
    streak = 0,
    reduced = false,
    recoveryR = 0,
    weekR = 0;
  let currentWeek = "",
    currentMonth = "",
    weekBase = initial,
    monthBase = initial,
    monthPeak = initial,
    peak = initial;
  let lastEquity = initial,
    lastIndex = -1,
    stale = false,
    curveBlocked = rule === "equity20",
    badMonths = 0,
    firstMonth = true;
  let monthStale = false;
  let profits: number[] = [];
  const values: number[] = [];
  const records: {
    date: string;
    kind: string;
    value: number | null;
    pausedThrough: string | null;
    nextEligibleDate: string | null;
  }[] = [];
  const monthly: {
    month: string;
    complete: boolean;
    trades: number;
    wins: number;
    losses: number;
    zeros: number;
    winRate: number | null;
    payoff: number | null;
    returnFraction: number | null;
    profits: number[];
  }[] = [];
  const record = (i: number, kind: string, value: number | null) =>
    records.push({
      date: calendar[i]!,
      kind,
      value,
      pausedThrough: calendar[through] ?? null,
      nextEligibleDate: through < 0 ? null : (calendar[through + 1] ?? null),
    });
  const pause = (i: number, n: number, kind: string, value: number) => {
    through = Math.max(through, i + n);
    record(i, kind, value);
  };
  function begin(i: number) {
    if (!Number.isInteger(i) || !calendar[i] || i !== lastIndex + 1)
      throw new Error("账户风控须逐研究交易日推进");
    const date = calendar[i]!,
      wk = week(date),
      mo = month(date);
    if (
      through >= 0 &&
      i === through + 1 &&
      (rule === "drawdown10" || rule === "drawdown15-week")
    )
      peak = lastEquity;
    if (wk !== currentWeek) {
      currentWeek = wk;
      weekBase = lastEquity;
      weekR = 0;
      if (periodBlocked?.startsWith("W")) periodBlocked = null;
    }
    if (mo !== currentMonth) {
      const ordinal = (m: string) =>
        Number(m.slice(0, 4)) * 12 + Number(m.slice(5, 7));
      const skippedMonths =
        !!currentMonth && ordinal(mo) - ordinal(currentMonth) > 1;
      if (skippedMonths) {
        badMonths = 0;
        monthStale = true;
      }
      if (currentMonth) {
        const wins = profits.filter((p) => p > 0),
          losses = profits.filter((p) => p < 0);
        const winRate = profits.length ? wins.length / profits.length : null;
        const payoff =
          wins.length && losses.length
            ? wins.reduce((a, b) => a + b, 0) /
              wins.length /
              (-losses.reduce((a, b) => a + b, 0) / losses.length)
            : null;
        const ret =
          !monthStale && monthBase > 0 ? lastEquity / monthBase - 1 : null;
        monthly.push({
          month: currentMonth,
          complete: !firstMonth && !monthStale,
          trades: profits.length,
          wins: wins.length,
          losses: losses.length,
          zeros: profits.length - wins.length - losses.length,
          winRate,
          payoff,
          returnFraction: ret,
          profits: [...profits],
        });
        const metric =
          rule === "month-win35"
            ? winRate
            : rule === "month-rr15"
              ? payoff
              : ret;
        const threshold =
          rule === "month-win35" ? 0.35 : rule === "month-rr15" ? 1.5 : 0;
        if (
          rule.startsWith("month-") &&
          ["month-win35", "month-rr15", "month-negative3"].includes(rule)
        ) {
          badMonths =
            !firstMonth && !monthStale && metric != null && metric < threshold
              ? badMonths + 1
              : 0;
          if (badMonths >= (rule === "month-negative3" ? 3 : 2)) {
            pause(i - 1, 5, rule, metric!);
            badMonths = 0;
          }
        }
        firstMonth = false;
      }
      currentMonth = mo;
      monthBase = lastEquity;
      monthPeak = lastEquity;
      profits = [];
      monthStale = stale || skippedMonths;
      if (periodBlocked?.startsWith("M")) periodBlocked = null;
    }
    lastIndex = i;
  }
  function settle(i: number, profit: number, risk: number | null) {
    if (i !== lastIndex || !Number.isFinite(profit))
      throw new Error("账户结算时序或净损益无效");
    profits.push(profit);
    streak = profit < 0 ? streak + 1 : 0;
    const r =
      risk != null && Number.isFinite(risk) && risk > 0 ? profit / risk : null;
    if (rule === "week3r") {
      if (r == null) {
        periodBlocked = "W" + currentWeek;
        record(i, "结算初始R缺失", null);
      } else {
        weekR += r;
        if (weekR <= -3) {
          periodBlocked = "W" + currentWeek;
          record(i, rule, weekR);
        }
      }
    }
    if (reduced && r != null) {
      recoveryR += r;
      if (recoveryR > 0) {
        reduced = false;
        recoveryR = 0;
        streak = 0;
        record(i, "累计已实现R转正恢复", r);
      }
    }
    if (streak >= 5) {
      if (rule === "streak5-half" && !reduced) {
        reduced = true;
        recoveryR = 0;
        record(i, rule, streak);
      }
      if (rule === "loss5-week") {
        pause(i, 5, rule, streak);
        streak = 0;
      }
    }
  }
  function close(i: number, equity: number, hasStale: boolean) {
    if (i !== lastIndex || !Number.isFinite(equity) || equity <= 0)
      throw new Error("账户收盘权益无效");
    const previousStale = stale;
    stale = hasStale;
    monthStale ||= hasStale;
    values.push(hasStale ? NaN : equity);
    if (!hasStale) {
      const daily = equity / lastEquity - 1;
      peak = Math.max(peak, equity);
      monthPeak = Math.max(monthPeak, equity);
      if (i > through && !previousStale) {
        if (rule === "day2" && daily <= -0.02 + 1e-12) pause(i, 1, rule, daily);
        if (rule === "day5-week" && daily < -0.05 - 1e-12)
          pause(i, 5, rule, daily);
        const dd = 1 - equity / peak;
        if (rule === "drawdown10" && dd >= 0.1 - 1e-12) pause(i, 5, rule, dd);
        if (rule === "drawdown15-week" && dd > 0.15 + 1e-12)
          pause(i, 5, rule, dd);
      }
      if (
        rule === "week6" &&
        equity / weekBase <= 0.94 + 1e-12 &&
        !periodBlocked
      ) {
        periodBlocked = "W" + currentWeek;
        record(i, rule, equity / weekBase - 1);
      }
      if (
        rule === "month6" &&
        equity / monthBase <= 0.94 + 1e-12 &&
        !periodBlocked
      ) {
        periodBlocked = "M" + currentMonth;
        record(i, rule, equity / monthBase - 1);
      }
      if (
        rule === "elder6" &&
        equity / monthPeak <= 0.94 + 1e-12 &&
        !periodBlocked
      ) {
        periodBlocked = "M" + currentMonth;
        record(i, rule, equity / monthPeak - 1);
      }
      if (rule === "equity20") {
        const window = values.slice(-20);
        curveBlocked =
          window.length < 20 ||
          window.some((v) => !Number.isFinite(v)) ||
          equity < window.reduce((a, b) => a + b, 0) / 20;
      }
    }
    lastEquity = equity;
  }
  const blocked = (i: number) =>
    stale || curveBlocked || i <= through || periodBlocked != null;
  return {
    begin,
    settle,
    close,
    blocked,
    multiplier: () => (reduced ? 0.5 : 1),
    snapshot: () => ({
      version: "account-risk-1",
      rule,
      paused: blocked(lastIndex),
      remainingTradingDays:
        periodBlocked || curveBlocked || stale
          ? null
          : Math.max(0, through - lastIndex),
      pausedThrough: through < 0 ? null : (calendar[through] ?? null),
      nextEligibleDate:
        through < 0 || periodBlocked || curveBlocked || stale
          ? null
          : (calendar[through + 1] ?? null),
      recovery: periodBlocked
        ? "下一已提供交易日所属周/月切换"
        : curveBlocked
          ? "有效权益收盘回到MA20及以上"
          : stale
            ? "有效收盘估值恢复"
            : reduced
              ? "触发后累计已实现R严格大于0"
              : "固定暂停日数结束",
      multiplier: reduced ? 0.5 : 1,
      consecutiveLosses: streak,
      recoveryR,
      weekR,
      monthly,
      currentMonth: {
        month: currentMonth,
        profits: [...profits],
        complete: false,
      },
      records: [...records],
    }),
  };
}
