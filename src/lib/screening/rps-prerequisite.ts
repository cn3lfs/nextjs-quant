import { z } from "zod";

export const rpsPrerequisiteSchema = z.object({
  code: z.enum([
    "close-time",
    "calendar-current",
    "calendar-history",
    "calendar-updating",
    "block-source",
    "universe",
    "actions-coverage",
  ]),
  message: z.string().min(1).max(2048),
});
export type RpsPrerequisite = z.infer<typeof rpsPrerequisiteSchema>;
