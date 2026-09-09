import { z } from "zod";
export const workProgressSchema = z
  .object({
    stage: z.string().min(1).max(100),
    unit: z.enum(["证券", "候选", "批次", "步骤"]),
    processed: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
  })
  .refine(
    (v) => v.processed <= v.total && v.failed + v.excluded <= v.processed,
    "任务阶段计数不一致",
  );
export type WorkProgress = z.infer<typeof workProgressSchema>;
export function workProgress(
  stage: string,
  unit: WorkProgress["unit"],
  processed: number,
  total: number,
  failed = 0,
  excluded = 0,
): WorkProgress {
  return workProgressSchema.parse({
    stage,
    unit,
    processed,
    total,
    failed,
    excluded,
  });
}
