import {
  strategyExperimentInputSchema,
  strategyExperimentWarmup,
} from "quant-backtest";
import { suggestFiveMinuteWindow } from "~/lib/backtest/coverage-window";
import {
  readBars,
  type ReadBarsInput,
} from "~/server/market/bar-store/read-bars";
import type { Snapshot } from "~/lib/domain";

export const maCoverageInputSchema = strategyExperimentInputSchema
  .innerType()
  .pick({ symbol: true, strategy: true });
type CoverageInput = import("zod").z.input<typeof maCoverageInputSchema>;
type CoverageReader = (
  input: ReadBarsInput,
) => Promise<Pick<Snapshot, "symbol" | "bars">>;
/** Read-only coverage/advisory; execution still owns calendar, actions and feed validation. */
export async function readMaCoverage(
  raw: CoverageInput,
  root: string,
  reader: CoverageReader = readBars,
) {
  const input = maCoverageInputSchema.parse(raw);
  const source = await reader({
    instrument: { market: "cn-equity", symbol: input.symbol },
    root,
    period: "5m",
    adjustment: "none",
  });
  if (!source.bars.length) throw new Error("本地未包含可用五分钟行情");
  const start = source.bars[0]!.date.slice(0, 10),
    end = source.bars.at(-1)!.date.slice(0, 10);
  const warmupBars = strategyExperimentWarmup(
    strategyExperimentInputSchema.parse({ ...input, start, end }),
  );
  return {
    symbol: source.symbol,
    start,
    end,
    bars: source.bars.length,
    ...suggestFiveMinuteWindow(source.bars, warmupBars),
  };
}
