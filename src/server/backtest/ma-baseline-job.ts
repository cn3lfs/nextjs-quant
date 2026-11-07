import {
  strategyExperimentInputSchema,
  type StrategyExperimentInput,
} from "~/lib/backtest/strategy-experiment";
import { settings } from "../infra/settings";
import { background, runWorker } from "../jobs/jobs";
import { type MaBaselineArchive } from "./ma-baseline-work";

export function maBaselineJob(raw: StrategyExperimentInput) {
  const input = strategyExperimentInputSchema.parse(raw);
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
