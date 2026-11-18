import type { Settings } from "~/lib/domain";
import { localBars } from "../market/bar-store/local-source";
import {
  localCalendarReference,
  screenDataHealth,
} from "../market/data-health";
import { downloadReady } from "../jobs/workflow-scheduler";
import { beijingClock } from "~/lib/market/market-session";

/** Index daily bars are the local market clock, never an online/forming overlay. */
export async function equityDailyReadiness(config: Settings, now: number) {
  const reference = await localCalendarReference(
    config.tdxRoot,
    config.calendar,
  );
  const wall = beijingClock(now);
  if (wall.weekday === 0 || wall.weekday === 6)
    reference.closedDays = [...(reference.closedDays ?? []), wall.date];
  let localDate: string | null = null;
  try {
    localDate =
      (await localBars(config.tdxRoot, "sh000300", "day")).bars.at(-1)?.date ??
      null;
  } catch {
    // Missing local input remains an explicit unknown rather than a guessed date.
  }
  const health = screenDataHealth(localDate, "day", now, reference);
  const receipt = health.referenceAsOf
    ? await downloadReady(health.referenceAsOf, now)
    : false;
  return {
    localDate,
    expectedDate: health.referenceAsOf,
    status: health.status,
    receipt,
    ready: health.status === "aligned" && receipt,
    // Internal reference only; callers must keep it out of the API readiness.
    calendar: reference.days,
  };
}
