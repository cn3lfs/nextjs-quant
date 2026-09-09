import { z } from "zod";
import type { wyckoffFrames } from "./wyckoff-frames";
export const wyckoffStages = [
  "environment",
  "structure",
  "volume",
  "range",
  "events",
  "relativeStrength",
  "targets",
  "conclusion",
] as const;
export const wyckoffStageFiles = {
  environment: ["wyckoff-foundation.md"],
  structure: ["wyckoff-foundation.md", "wyckoff-mtf-guide.md"],
  volume: [
    "wyckoff-volume-analysis.md",
    "wyckoff-vsa-signals.md",
    "wyckoff-volume-profile.md",
  ],
  range: [
    "wyckoff-accumulation-schematic.md",
    "wyckoff-distribution-schematic.md",
  ],
  events: [
    "wyckoff-accumulation-schematic.md",
    "wyckoff-distribution-schematic.md",
    "wyckoff-vsa-signals.md",
  ],
  relativeStrength: ["wyckoff-relative-strength.md"],
  targets: ["wyckoff-pf-targets.md"],
  conclusion: ["wyckoff-foundation.md", "wyckoff-mtf-guide.md"],
} as const;
export function wyckoffReportSchema(frames: ReturnType<typeof wyckoffFrames>) {
  const text = z.string().trim().min(1).max(2000);
  return z
    .object({
      title: text,
      summary: text,
      stages: z
        .array(
          z
            .object({
              id: z.enum(wyckoffStages),
              status: z.enum(["hypothesis", "missing"]),
              summary: text,
              citations: z.array(z.literal(frames.hash)).length(1),
              methodFiles: z.array(z.string()).min(1).max(3),
              missing: z.array(text).min(1).max(15),
            })
            .strict(),
        )
        .length(8),
      events: z
        .array(
          z
            .object({
              timeframe: z.enum(["daily", "weekly", "hourly"]),
              index: z.number().int().nonnegative(),
              date: z.string(),
              name: z.enum([
                "PS",
                "SC",
                "AR",
                "ST",
                "Spring",
                "SOS",
                "LPS",
                "BC",
                "UT",
                "UTAD",
                "SOW",
                "LPSY",
                "other",
              ]),
              status: z.literal("hypothesis"),
              rationale: text,
              invalidation: text,
            })
            .strict(),
        )
        .max(20),
      risks: z.array(text).min(3).max(15),
      nextSteps: z.array(text).min(1).max(15),
    })
    .strict()
    .superRefine((value, ctx) => {
      value.stages.forEach((stage, i) => {
        if (stage.id !== wyckoffStages[i])
          ctx.addIssue({
            code: "custom",
            path: ["stages", i, "id"],
            message: "八阶段必须完整有序",
          });
        const allowed: readonly string[] = wyckoffStageFiles[stage.id];
        if (
          new Set(stage.methodFiles).size !== stage.methodFiles.length ||
          stage.methodFiles.some((file) => !allowed.includes(file))
        )
          ctx.addIssue({
            code: "custom",
            path: ["stages", i, "methodFiles"],
            message: `本阶段必须引用不重复的方法文件：${allowed.join(",")}`,
          });
      // A single market ratio does not complete market context, dual-benchmark RS or P&F.
        if (
          ["environment", "relativeStrength", "targets"].includes(stage.id) &&
          stage.status !== "missing"
        )
          ctx.addIssue({
            code: "custom",
            path: ["stages", i, "status"],
            message: "当前档案无该阶段计算或市场证据，必须标missing",
          });
      });
      const seen = new Set<string>();
      value.events.forEach((event, i) => {
        const frame = frames[event.timeframe];
        const key = `${event.timeframe}:${event.index}:${event.name}`;
        if (
          frame.bars[event.index]?.date !== event.date ||
          (event.timeframe === "hourly" && frames.hourly.noHourly) ||
          frame.bars.length < 30 ||
          seen.has(key)
        )
          ctx.addIssue({
            code: "custom",
            path: ["events", i],
            message:
              "事件必须引用可用周期的真实索引和日期，不能重复；陈旧小时或不足30根的周期不得标事件",
          });
        seen.add(key);
      });
    });
}
