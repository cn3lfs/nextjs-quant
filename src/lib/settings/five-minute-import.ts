import { z } from "zod";

export const fiveMinuteInput = z.object({
  directories: z.array(z.string().trim().min(1).max(1000)).min(1).max(10),
  source: z.literal("wswdz").default("wswdz"),
});
export type FiveMinuteInput = z.infer<typeof fiveMinuteInput>;
