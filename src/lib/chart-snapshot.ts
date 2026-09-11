import type { Snapshot } from "./domain";
import type { ChartPeriod } from "./chart-view";

/** Chart-only observations must never enter confirmed research/notification paths. */
export type ChartSnapshot = Omit<Snapshot, "period"> & {
  period: ChartPeriod;
  formingDates: string[];
  excluded: { date: string; reason: string }[];
  historyExhausted: boolean;
};
