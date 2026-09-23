import type { Snapshot } from "../domain";
import type { ChartPeriod } from "./chart-view";
import type { ChartAdjustment } from "./chart-adjustment";

/** Chart-only observations must never enter confirmed research/notification paths. */
export type ChartSnapshot = Omit<Snapshot, "period" | "adjustment"> & {
  period: ChartPeriod;
  adjustment: ChartAdjustment;
  formingDates: string[];
  excluded: { date: string; reason: string }[];
  historyExhausted: boolean;
};
