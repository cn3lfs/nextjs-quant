import { z } from "zod";
import type { Snapshot } from "~/lib/domain";
import { get } from "./db";
import { settings } from "./settings";
import { localCalendarReference } from "./data-health";
import { weeklyBars } from "./weekly-bars";
import { monthlyBars } from "./monthly-bars";
export const chartBarsInput = z.object({
  snapshotId: z.string().min(1),
  period: z.enum(["week", "month"]),
});
export async function chartBars(input: z.infer<typeof chartBarsInput>) {
  const source = get<Snapshot>(input.snapshotId);
  if (!source) throw new Error("行情快照不存在");
  const config = settings();
  const calendar = await localCalendarReference(
    source.dataRoot ?? config.tdxRoot,
    config.calendar,
  );
  return input.period === "week"
    ? weeklyBars(source, calendar, Date.now())
    : monthlyBars(source, calendar, Date.now());
}
