import { z } from "zod";
export const canslimStageIds = [
  "market",
  "data-coverage",
  "scoring",
  "patterns",
  "entry-risk",
  "conclusion",
] as const;
export type CanslimStageId = (typeof canslimStageIds)[number];
export type CanslimStagePolicy = Record<
  CanslimStageId,
  { supported: boolean; missing: string[] }
>;

// The model explains a server-owned scorecard. No numeric scoring fields are
// accepted here, so it cannot replace incomplete calculations with a new score.
export function canslimReportSchema(
  evidenceIds: string[],
  policy: CanslimStagePolicy,
) {
  const allowed = new Set(evidenceIds);
  const citations = z
    .array(z.string())
    .min(1)
    .refine(
      (ids) =>
        new Set(ids).size === ids.length && ids.every((id) => allowed.has(id)),
      "引用必须唯一且来自当前证据包",
    );
  return z
    .object({
      title: z.string().min(1).max(200),
      summary: z.string().min(1).max(3000),
      stages: z
        .array(
          z
            .object({
              id: z.enum(canslimStageIds),
              status: z.enum(["supported", "contradicted", "missing"]),
              summary: z.string().min(1).max(3000),
              citations,
              missing: z.array(z.string().min(1)),
            })
            .strict(),
        )
        .length(6),
      risks: z.array(z.string().min(1)).min(1),
      nextSteps: z.array(z.string().min(1)).min(1),
      citations,
    })
    .strict()
    .superRefine((report, context) => {
      report.stages.forEach((stage, index) => {
        if (stage.id !== canslimStageIds[index])
          context.addIssue({
            code: "custom",
            path: ["stages", index, "id"],
            message: "六阶段必须完整有序",
          });
        const requirement = policy[stage.id];
        if (
          requirement.missing.length &&
          (stage.status !== "missing" ||
            requirement.missing.some((item) => !stage.missing.includes(item)))
        )
          context.addIssue({
            code: "custom",
            path: ["stages", index],
            message: "必须保留服务端前提缺口，不能将缺失改为反证或支持",
          });
        if (
          stage.status === "supported" &&
          (!requirement.supported || stage.missing.length)
        )
          context.addIssue({
            code: "custom",
            path: ["stages", index, "status"],
            message: "阶段支持缺少服务端依据",
          });
      });
    });
}
