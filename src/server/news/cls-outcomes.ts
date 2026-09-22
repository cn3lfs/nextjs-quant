import type { Bar } from "~/lib/domain";
import type { ClsSample } from "./cls-sample";

export type ClsOutcome = {
  horizon: 0 | 1 | 5 | 10;
  date: string;
  exitDate: string | null;
  status: "observed" | "pending" | "unavailable";
  grossReturn: number | null;
  benchmarkReturn: number | null;
  excessReturn: number | null;
  hit: boolean | null;
  reason: string | null;
};

/** Price-direction observations from sample-day open, never T+0 executions.
 * Caller freezes prices/source/adjustment alongside the resulting observations.
 */
export function clsOutcomes(
  sample: ClsSample,
  bars: readonly Bar[],
  benchmark: readonly Bar[],
  calendar: readonly string[],
  now: number,
): ClsOutcome[] {
  if (calendar.some((date, index) => index > 0 && date <= calendar[index - 1]!))
    throw new Error("复盘交易日历顺序无效");
  const index = calendar.indexOf(sample.date);
  const indexed = new Map(bars.map((bar) => [bar.date, bar]));
  const base = new Map(benchmark.map((bar) => [bar.date, bar]));
  return ([0, 1, 5, 10] as const).map((horizon) => {
    const exitDate = index < 0 ? null : (calendar[index + horizon] ?? null);
    const empty: ClsOutcome = {
      horizon,
      date: sample.date,
      exitDate,
      status: "pending",
      grossReturn: null,
      benchmarkReturn: null,
      excessReturn: null,
      hit: null,
      reason: null,
    };
    if (!sample.selected || index < 0)
      return {
        ...empty,
        status: "unavailable",
        reason: sample.reason ?? "样本日不在交易日历内",
      };
    if (sample.fixedAt >= Date.parse(`${sample.date}T09:30:00+08:00`))
      return { ...empty, status: "unavailable", reason: "样本未在开盘前固定" };
    if (!exitDate || now < Date.parse(`${exitDate}T15:05:00+08:00`))
      return { ...empty, reason: "观察窗口尚未收盘" };
    const entry = indexed.get(sample.date),
      exit = indexed.get(exitDate);
    if (
      !entry ||
      !exit ||
      entry.volume <= 0 ||
      exit.volume <= 0 ||
      ![entry.open, exit.close].every(
        (price) => Number.isFinite(price) && price > 0,
      )
    )
      return {
        ...empty,
        status: "unavailable",
        reason: "起止日缺价、停牌或价格无效",
      };
    const grossReturn = exit.close / entry.open - 1;
    const first = base.get(sample.date),
      last = base.get(exitDate);
    const benchmarkReturn =
      first &&
      last &&
      [first.open, last.close].every(
        (price) => Number.isFinite(price) && price > 0,
      )
        ? last.close / first.open - 1
        : null;
    const direction = sample.selected.direction;
    return {
      ...empty,
      status: "observed",
      grossReturn,
      benchmarkReturn,
      excessReturn:
        benchmarkReturn === null ? null : grossReturn - benchmarkReturn,
      hit:
        direction === "bullish"
          ? grossReturn > 0
          : direction === "bearish"
            ? grossReturn < 0
            : null,
      reason: benchmarkReturn === null ? "基准缺价，不计算超额收益" : null,
    };
  });
}

export function clsOutcomeStatistics(
  rows: readonly ClsOutcome[],
  horizon: ClsOutcome["horizon"],
) {
  const sample = rows.filter((row) => row.horizon === horizon);
  const valid = sample.filter(
    (row) => row.status === "observed" && row.hit !== null,
  );
  const excess = valid.flatMap((row) =>
    row.excessReturn === null ? [] : [row.excessReturn],
  );
  return {
    total: sample.length,
    valid: valid.length,
    pending: sample.filter((row) => row.status === "pending").length,
    unavailable: sample.filter((row) => row.status === "unavailable").length,
    hits: valid.filter((row) => row.hit).length,
    hitRate: valid.length
      ? valid.filter((row) => row.hit).length / valid.length
      : null,
    excessSamples: excess.length,
    meanExcessReturn: excess.length
      ? excess.reduce((sum, value) => sum + value, 0) / excess.length
      : null,
  };
}
