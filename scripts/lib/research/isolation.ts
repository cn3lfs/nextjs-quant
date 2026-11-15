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
  })
  .strict();
if (!process.env.QUANT_RESEARCH_CONFIG)
  throw new Error("Use scripts/research.ts with --config");
export const config = configSchema.parse(
  JSON.parse(readFileSync(process.env.QUANT_RESEARCH_CONFIG, "utf8")),
);
export const replayOnly = process.env.QUANT_RESEARCH_REPLAY === "1";
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
