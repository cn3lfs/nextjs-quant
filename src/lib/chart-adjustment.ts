import { z } from "zod";

export const chartAdjustmentSchema = z.enum(["none", "forward", "backward"]);
export type ChartAdjustment = z.infer<typeof chartAdjustmentSchema>;

export const chartAdjustmentLabels: Record<ChartAdjustment, string> = {
  none: "不复权",
  forward: "前复权",
  backward: "后复权",
};
