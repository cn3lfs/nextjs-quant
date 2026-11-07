import {
  maBaselineInputSchema,
  type MaBaselineInput,
} from "~/lib/backtest/ma-baseline";
import { settings } from "../infra/settings";
import { background, runWorker } from "../jobs/jobs";
import { type MaBaselineArchive } from "./ma-baseline-work";

export function maBaselineJob(raw: MaBaselineInput) {
  const input = maBaselineInputSchema.parse(raw);
  const work = {
    type: "ma-baseline" as const,
    root: settings().tdxRoot,
    input,
  };
  return background(
    "backtest",
    { ...work, symbol: input.symbol, start: input.start, end: input.end },
    (job) => runWorker<MaBaselineArchive>(work, job.id),
  );
}
