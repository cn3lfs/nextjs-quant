import type { Bar } from "~/lib/domain";
import type { ResearchEvent } from "~/lib/research/strategy-research";

export type ResearchOutcome = {
  event: ResearchEvent;
  status: "observed" | "pending" | "unavailable";
  entryDate: string | null;
  exitDate: string | null;
  grossReturn: number | null;
  benchmarkReturn: number | null;
  excessReturn: number | null;
  reason: string | null;
};

/** Event observation, NOT a claim of executable trades. The later simulator
 * must apply cash, position, fees and market execution constraints separately.
 */
export function researchOutcomes(
  events: readonly ResearchEvent[],
  series: ReadonlyMap<string, readonly Bar[]>,
  benchmark: readonly Bar[],
  calendar: readonly string[],
  holdingDays: number,
  observedThrough: string,
): ResearchOutcome[] {
  if (!Number.isInteger(holdingDays) || holdingDays < 1)
    throw new Error("持有期无效");
  if (calendar.some((day, index) => index > 0 && day <= calendar[index - 1]!))
    throw new Error("研究交易日历顺序无效");
  const indexed = new Map(
    [...series].map(([symbol, bars]) => [
      symbol,
      new Map(bars.map((bar) => [bar.date, bar])),
    ]),
  );
  const benchmarkDays = new Map(benchmark.map((bar) => [bar.date, bar]));
  return events.map((event) => {
    const index = calendar.indexOf(event.observedDate);
    const entryDate = index >= 0 ? (calendar[index + 1] ?? null) : null;
    // One-day observation is next session's open-to-close, not a T+0 trade.
    const exitDate =
      index >= 0 ? (calendar[index + holdingDays] ?? null) : null;
    const outcome: ResearchOutcome = {
      event,
      status: "pending",
      entryDate,
      exitDate,
      grossReturn: null,
      benchmarkReturn: null,
      excessReturn: null,
      reason: null,
    };
    if (index < 0)
      return {
        ...outcome,
        status: "unavailable",
        reason: "信号日期不在交易日历内",
      };
    if (!entryDate || !exitDate || exitDate > observedThrough)
      return { ...outcome, reason: "观察窗口尚未结束" };
    const bars = indexed.get(event.symbol),
      entry = bars?.get(entryDate),
      exit = bars?.get(exitDate);
    const baseEntry = benchmarkDays.get(entryDate),
      baseExit = benchmarkDays.get(exitDate);
    if (!entry || !exit || entry.volume <= 0 || exit.volume <= 0)
      return {
        ...outcome,
        status: "unavailable",
        reason: "观察起止日行情缺失或停牌",
      };
    if (
      ![entry.open, exit.close].every(
        (value) => Number.isFinite(value) && value > 0,
      )
    )
      return { ...outcome, status: "unavailable", reason: "观察价格无效" };
    outcome.grossReturn = exit.close / entry.open - 1;
    outcome.status = "observed";
    if (
      baseEntry &&
      baseExit &&
      [baseEntry.open, baseExit.close].every(
        (value) => Number.isFinite(value) && value > 0,
      )
    ) {
      outcome.benchmarkReturn = baseExit.close / baseEntry.open - 1;
      outcome.excessReturn = outcome.grossReturn - outcome.benchmarkReturn;
    } else outcome.reason = "基准行情缺失，超额收益不可计算";
    return outcome;
  });
}
