import { readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { z } from "zod";
export const configSchema = z
  .object({
    batch: z.enum(["R2a-4", "R2a-5"]),
    task: z.string(),
    predecessor: z.string(),
    root: z.string(),
    end: z.string(),
    holdoutStart: z.string(),
    dsrScope: z.enum(["global", "market"]),
    sizing: z.array(z.enum(["legacy", "equal", "volatility"])),
    method: z.enum(["legacy", "lifecycle-2"]).optional(),
    purpose: z.enum(["preregistered", "post-hoc"]).optional(),
    clusterCorrelation: z.number().positive().max(1).optional(),
    maximumPbo: z.number().min(0).max(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.method === "lifecycle-2" &&
      (value.purpose !== "post-hoc" ||
        value.clusterCorrelation === undefined ||
        value.maximumPbo === undefined)
    )
      context.addIssue({
        code: "custom",
        message:
          "Old R2 rows require explicit post-hoc purpose and declared lifecycle method parameters",
      });
  });
if (!process.env.QUANT_RESEARCH_CONFIG)
  throw new Error("Use scripts/research.ts with --config");
export const config = configSchema.parse(
  JSON.parse(readFileSync(process.env.QUANT_RESEARCH_CONFIG, "utf8")),
);
export const replayOnly = process.env.QUANT_RESEARCH_REPLAY === "1";
if (replayOnly && config.method === "lifecycle-2")
  throw new Error("Frozen replay cannot change its recorded validation method");
export const outputTask = replayOnly
  ? resolve(".test-data/r2a5/replay-r2a4")
  : resolve(config.task);
for (const path of [config.task, config.predecessor, outputTask])
  if (!resolve(path).startsWith(resolve(".test-data") + sep))
    throw new Error("Research path must be isolated under .test-data");
const directory = process.env.QUANT_DATA_DIR;
if (
  !directory ||
  !isAbsolute(directory) ||
  resolve(directory) !== resolve(outputTask, "data")
)
  throw new Error(
    "Set absolute isolated QUANT_DATA_DIR for the configured task before loading research",
  );
