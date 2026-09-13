import { recordResearchUsage, recordedResearchTrials } from "./research-usage";
import { z } from "zod";
import { strategySchema, type Snapshot } from "~/lib/domain";
import { backtestCostsSchema } from "~/lib/backtest-costs";
import { walkForwardSchema, type WalkForwardResult } from "~/lib/walk-forward";
import { background, runWorker } from "./jobs";
import { atomic, get, put } from "./db";
import { settings } from "./settings";
export const walkForwardInput = z.object({
  snapshotId: z.string(),
  strategy: strategySchema,
  initial: z.number().min(1000).max(1e9),
  scope: z.enum(["full", "window"]).default("full"),
  costs: backtestCostsSchema.default({}),
  options: walkForwardSchema.default({}),
});
export function walkForwardJob(input: z.infer<typeof walkForwardInput>) {
  const selected = get<Snapshot>(input.snapshotId);
  if (!selected) throw new Error("请先加载行情快照");
  if (selected.period !== "day") throw new Error("滚动检验只支持日线");
  if (input.scope === "full" && selected.source !== "tdx-local")
    throw new Error("远端快照仅支持窗口检验");
  return background("walk-forward", input, async (job, signal) => {
    const { source, result } = await runWorker<{
      source: Snapshot;
      result: WalkForwardResult;
    }>(
      {
        type: "walk-forward",
        snapshot: selected,
        strategy: input.strategy,
        initial: input.initial,
        costs: input.costs,
        options: input.options,
        fullRoot:
          input.scope === "full"
            ? (selected.dataRoot ?? settings().tdxRoot)
            : undefined,
      },
      job.id,
    );
    signal.throwIfAborted();
    const record = {
      ...result,
      dataRange: {
        scope: input.scope,
        selectedSnapshotId: selected.id,
        start: source.bars[0]!.date,
        end: source.bars.at(-1)!.date,
        bars: source.bars.length,
      },
      id: `walk-forward-${job.id.slice(4)}`,
      createdAt: Date.now(),
    };
    const usage = recordResearchUsage(() => ({
      kind: "walk-forward",
      symbols: [source.symbol],
      universeSize: 1,
      range: record.dataRange,
      candidateCount: result.candidates.length,
      config: {
        kind: "walk-forward",
        symbol: source.symbol,
        strategy: input.strategy,
        initial: input.initial,
        costs: input.costs,
        options: input.options,
      },
    }));
    if (record.multipleTesting)
      record.multipleTesting.recordedTrials = recordedResearchTrials(
        record.dataRange,
        usage,
      );
    atomic(() => {
      put("snapshot", source.id, source);
      put("walk-forward", record.id, record);
    });
    return record;
  });
}
