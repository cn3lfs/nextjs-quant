import {
  dailyPerformance,
  type DailyPerformanceInput,
} from "./daily-performance";
import type { ReviewValue } from "../portfolio/trade-review";

export const periodWindows = [
  "past1w",
  "past2w",
  "past1m",
  "past3m",
  "past6m",
  "past1y",
  "ytd",
  "all",
] as const;
export const aSharePeriodTradingDays = {
  past1w: 5,
  past2w: 10,
  past1m: 20,
  past3m: 60,
  past6m: 120,
  past1y: 250,
} as const;
export const periodicWindows = [
  1, 3, 5, 10, 20, 30, 60, 90, 120, 180, 240, 360,
] as const;
export type PeriodInput = DailyPerformanceInput & {
  dates: readonly string[];
  tradingDays: readonly string[];
};

function validateDates(dates: readonly string[]) {
  if (
    dates.some(
      (date, i) =>
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !Number.isFinite(Date.parse(date)) ||
        new Date(date).toISOString().slice(0, 10) !== date ||
        (i > 0 && date <= dates[i - 1]!),
    )
  )
    throw new Error("日期必须有效、唯一且升序");
}

/** 日历由调用方提供；缺失交易日补 null，不用收益观察数代替交易日回溯。 */
export function alignPeriodInput(input: PeriodInput) {
  validateDates(input.dates);
  validateDates(input.tradingDays);
  if (input.dates.length !== input.returns.length)
    throw new Error("日期与收益长度不一致");
  const calendar = new Set(input.tradingDays);
  if (input.dates.some((date) => !calendar.has(date)))
    throw new Error("收益日期不在交易日历内");
  if (input.returns.some((r) => r !== null && !Number.isFinite(r)))
    throw new Error("日收益必须为有限数或 null");
  const byDate = new Map(
    input.dates.map((date, i) => [date, input.returns[i]!]),
  );
  const dates = input.tradingDays.filter(
    (date) =>
      date >= (input.dates[0] ?? "~") && date <= (input.dates.at(-1) ?? ""),
  );
  return { dates, returns: dates.map((date) => byDate.get(date) ?? null) };
}

export function periodPerformance(input: PeriodInput) {
  const aligned = alignPeriodInput(input);
  const end = aligned.dates.at(-1);
  const calendar = input.tradingDays.filter(
    (date) => end !== undefined && date <= end,
  );
  return periodWindows.map((window) => {
    const requested =
      window === "all"
        ? aligned.dates
        : window === "ytd"
          ? calendar.filter((date) => date.slice(0, 4) === end?.slice(0, 4))
          : calendar.slice(-aSharePeriodTradingDays[window]);
    const start = requested[0];
    const offset =
      start === undefined
        ? aligned.dates.length
        : aligned.dates.findIndex((date) => date >= start);
    const dates = offset < 0 ? [] : aligned.dates.slice(offset);
    const returns = offset < 0 ? [] : aligned.returns.slice(offset);
    const expectedDays =
      window === "all" || window === "ytd"
        ? requested.length
        : aSharePeriodTradingDays[window];
    return {
      window,
      startDate: dates[0] ?? null,
      endDate: dates.at(-1) ?? null,
      tradingDays: dates.length,
      requestedTradingDays: expectedDays,
      truncated: dates.length < expectedDays,
      insufficientSample: returns.filter((r) => r !== null).length < 5,
      // 任务书 §2.1 的 15 项与 U1 实际 17 项不符；完整委托 U1，不复制或删减指标。
      ...dailyPerformance({ ...input, returns }),
    };
  });
}

export function isoWeek(date: string): readonly [number, number] {
  validateDates([date]);
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum);
  const isoYear = t.getUTCFullYear();
  const week = Math.ceil(
    ((t.getTime() - Date.UTC(isoYear, 0, 1)) / 86400000 + 1) / 7,
  );
  return [isoYear, week];
}

export const naturalPeriods = ["week", "month", "quarter", "year"] as const;
/** wbt 自然周期胜率按区间日收益和 > 0；与复利累计收益及 U1 日胜率 >= 0 分开。 */
export function naturalPeriodWinRates(input: PeriodInput) {
  const aligned = alignPeriodInput(input);
  return naturalPeriods.map((period) => {
    const groups = new Map<string, (number | null)[]>();
    aligned.dates.forEach((date, i) => {
      const key =
        period === "week"
          ? isoWeek(date).join("-W")
          : period === "month"
            ? date.slice(0, 7)
            : period === "quarter"
              ? `${date.slice(0, 4)}-Q${Math.ceil(Number(date.slice(5, 7)) / 3)}`
              : date.slice(0, 4);
      const group = groups.get(key) ?? [];
      group.push(aligned.returns[i]!);
      groups.set(key, group);
    });
    const totals = [...groups.values()].map((returns) =>
      returns.includes(null)
        ? null
        : dailyPerformance({ returns, basis: "simple" }).totalReturn.value,
    );
    const available = totals.filter((n) => n !== null);
    const profitable = available.filter((n) => n > 0).length;
    return {
      period,
      periods: totals.length,
      available: available.length,
      profitable,
      value: available.length ? profitable / available.length : null,
      reason: available.length ? null : "无完整可得自然周期",
      partialBoundaryPeriodsIncluded: true,
    };
  });
}

export function periodicReturns(
  input: Omit<PeriodInput, "returns"> & {
    series: Record<string, readonly (number | null)[]>;
  },
) {
  // 即使零标的，也要校验共享轴。
  const aligned = alignPeriodInput({
    ...input,
    returns: input.dates.map(() => null),
  });
  const rows = Object.entries(input.series).map(([id, returns]) => {
    const series = alignPeriodInput({ ...input, returns }).returns;
    return {
      id,
      cells: periodicWindows.map((window) => {
        const values = series.slice(-window);
        const dates = aligned.dates.slice(-window);
        const result: ReviewValue = values.includes(null)
          ? { value: null, reason: "窗口内存在缺失日收益" }
          : dailyPerformance({ ...input, returns: values }).totalReturn;
        return {
          window,
          ...result,
          startDate: dates[0] ?? null,
          endDate: dates.at(-1) ?? null,
          tradingDays: dates.length,
          truncated: dates.length < window,
          insufficientSample: values.filter((r) => r !== null).length < 5,
        };
      }),
    };
  });
  const summary = periodicWindows.map((window, index) => {
    const available = rows.filter((row) => row.cells[index]!.value !== null);
    // 标的层面零收益等同于没赚到，不算盈利标的；与 U1 日胜率 >= 0 不同。
    const profitable = available.filter(
      (row) => row.cells[index]!.value! > 0,
    ).length;
    return {
      window,
      profitable,
      available: available.length,
      ratio: available.length ? profitable / available.length : null,
      reason: available.length ? null : "无可得标的",
    };
  });
  return { rows, summary };
}

export type PeriodPerformance = ReturnType<typeof periodPerformance>;
export type PeriodicReturns = ReturnType<typeof periodicReturns>;
