import type { Bar } from "trading-strategy-core/bars";
import {
  isCompleteFiveMinuteSession,
  matchesFiveMinuteWarmup,
} from "./five-minute-session";

export type FiveMinuteWindowSuggestion = {
  warmupBars: number;
  runnableWindows: { start: string; end: string }[];
  earliestStart: string | null;
  suggestedStart: string | null;
  suggestedEnd: string | null;
  unavailableReason: string | null;
};
/** Date-only inputs can start only at a session boundary, never after an intraday warmup. */
export function suggestFiveMinuteWindow(
  bars: readonly Pick<Bar, "date">[],
  warmupBars: number,
): FiveMinuteWindowSuggestion {
  if (!Number.isInteger(warmupBars) || warmupBars < 0)
    throw new Error("预热根数须为非负整数");
  const sessions: { day: string; first: number; times: string[] }[] = [];
  for (let i = 0; i < bars.length; i++) {
    const date = bars[i]!.date;
    if (i > 0 && date <= bars[i - 1]!.date)
      throw new Error("五分钟覆盖日期必须严格递增");
    const day = date.slice(0, 10);
    if (sessions.at(-1)?.day !== day)
      sessions.push({ day, first: i, times: [] });
    sessions.at(-1)!.times.push(date.slice(11, 16));
  }
  const runnableWindows: { start: string; end: string }[] = [];
  let current: { start: string; end: string } | null = null;
  const previousDays: string[] = [];
  for (const session of sessions) {
    if (!isCompleteFiveMinuteSession(session.times)) current = null;
    else if (
      matchesFiveMinuteWarmup(bars, session.first, previousDays, warmupBars)
    ) {
      if (current) current.end = session.day;
      else {
        current = { start: session.day, end: session.day };
        runnableWindows.push(current);
      }
    } else current = null;
    previousDays.push(session.day);
  }
  const latest = runnableWindows.at(-1);
  if (!latest)
    return {
      warmupBars,
      runnableWindows,
      earliestStart: null,
      suggestedStart: null,
      suggestedEnd: null,
      unavailableReason: `当前覆盖没有具备此前交易日末尾 ${warmupBars} 根完整预热的五分钟回测窗口，请补齐更早行情或更换证券。`,
    };
  const from = new Date(`${latest.end}T00:00:00Z`);
  from.setUTCDate(from.getUTCDate() - 30);
  const threshold = from.toISOString().slice(0, 10);
  const suggestedStart = sessions.find(
    (session) =>
      session.day >= latest.start &&
      session.day >= threshold &&
      session.day <= latest.end,
  )!.day;
  return {
    warmupBars,
    runnableWindows,
    earliestStart: runnableWindows[0]!.start,
    suggestedEnd: latest.end,
    suggestedStart,
    unavailableReason: null,
  };
}
