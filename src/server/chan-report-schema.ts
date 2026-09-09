import { z } from "zod";
import type { ChanPassage } from "./chan-method";

export const chanStageIds = [
  "morphology",
  "center",
  "dynamics",
  "points",
  "conclusion",
] as const;
const stageFiles = [
  "02-morphology.md",
  "03-center-and-trend.md",
  "04-dynamics.md",
  "05-trading-points.md",
];
export function chanCitationRules(passages: ChanPassage[]) {
  return chanStageIds.map((id, index) => ({
    id,
    file: stageFiles[index] ?? "任意已提供章节",
    allowedPassageIds: passages
      .filter((p) => index === 4 || p.file.endsWith(stageFiles[index]!))
      .map((p) => p.id),
  }));
}
export function chanReportSchema(
  passages: ChanPassage[],
  evidenceId: string,
  barCount: number,
) {
  const citationRules = chanCitationRules(passages);
  const text = z.string().trim().min(1).max(1600);
  const stage = z
    .object({
      id: z.enum(chanStageIds),
      status: z.enum(["hypothesis", "missing"]),
      summary: text,
      citations: z.array(z.literal(evidenceId)).length(1),
      passageIds: z.array(z.string()).min(1).max(8),
      missing: z.array(text).min(1).max(12),
      annotations: z
        .array(
          z
            .object({
              startIndex: z
                .number()
                .int()
                .min(0)
                .max(barCount - 1),
              endIndex: z
                .number()
                .int()
                .min(0)
                .max(barCount - 1),
              label: text,
              verification: text,
            })
            .strict()
            .refine((a) => a.startIndex <= a.endIndex, "标注区间必须顺序有效"),
        )
        .max(8),
    })
    .strict();
  return z
    .object({
      title: text,
      summary: text,
      stages: z.array(stage).length(5),
      risks: z.array(text).min(1).max(12),
      nextSteps: z.array(text).min(1).max(12),
    })
    .strict()
    .superRefine((report, ctx) => {
      report.stages.forEach((item, index) => {
        if (item.id !== chanStageIds[index])
          ctx.addIssue({
            code: "custom",
            path: ["stages", index, "id"],
            message: "五阶段必须完整有序",
          });
        const ids = new Set(item.passageIds);
        if (
          ids.size !== item.passageIds.length ||
          [...ids].some(
            (id) => !citationRules[index]!.allowedPassageIds.includes(id),
          )
        )
          ctx.addIssue({
            code: "custom",
            path: ["stages", index, "passageIds"],
            message: `必须引用对应方法章节的真实条目，不得重复或伪造；重复${item.passageIds.length - ids.size}项，未知${[...ids].filter((id) => !passages.some((p) => p.id === id)).length}项，跨章节${[...ids].filter((id) => passages.some((p) => p.id === id) && !citationRules[index]!.allowedPassageIds.includes(id)).length}项；本阶段文件${citationRules[index]!.file}，可用ID：${citationRules[index]!.allowedPassageIds.join(",")}`,
          });
        if (item.status === "hypothesis" && !item.annotations.length)
          ctx.addIssue({
            code: "custom",
            path: ["stages", index, "annotations"],
            message: "假设标注必须指向真实行情区间",
          });
      });
    });
}
