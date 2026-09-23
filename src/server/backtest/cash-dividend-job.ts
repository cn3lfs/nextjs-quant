import { z } from "zod";
import { strategySchema, type Snapshot, type Backtest } from "~/lib/domain";
import { backtestCostsSchema } from "~/lib/backtest/backtest-costs";
import { get, put } from "../db";
import { background, runWorker } from "../jobs/jobs";
import { settings } from "../infra/settings";
import { isAStock } from "../data-sources/tdx/tdx";
import type { BacktestActions } from "./backtest-actions";
import type { dividendSchedule } from "../data-sources/hithink/hithink-dividends";
import { reconcileDividends } from "./dividend-reconciliation";
import { reconciledCashPlan } from "./cash-dividend-plan";
export const cashDividendInput = z.object({
  snapshotId: z.string(),
  strategy: strategySchema,
  initial: z.number().finite().min(1000).max(1e9),
  costs: backtestCostsSchema,
  reconciliationId: z.string().regex(/^dividend-reconciliation-[a-f0-9]{64}$/),
  start: z.string(),
  end: z.string(),
  taxBps: z.number().int().min(0).max(10000),
});
export function cashDividendJob(input: z.infer<typeof cashDividendInput>) {
  input = cashDividendInput.parse(input);
  const selected = get<Snapshot>(input.snapshotId);
  if (
    !selected ||
    selected.source !== "tdx-local" ||
    selected.period !== "day" ||
    !isAStock(selected.symbol)
  )
    throw new Error("纯现金模拟仅支持本地A股日线快照");
  const archive = get<{
    local: BacktestActions;
    remoteArchiveId: string;
    reconciliation: ReturnType<typeof reconcileDividends>;
  }>(input.reconciliationId);
  if (!archive) throw new Error("分红对账档案不存在");
  const remote = get<ReturnType<typeof dividendSchedule>>(
    archive.remoteArchiveId,
  );
  if (!remote || archive.remoteArchiveId !== `dividend-schedule-${remote.hash}`)
    throw new Error("分红远端档案不存在或引用不符");
  const verified = reconcileDividends(archive.local, remote);
  if (
    input.reconciliationId !== `dividend-reconciliation-${verified.hash}` ||
    JSON.stringify(verified) !== JSON.stringify(archive.reconciliation) ||
    verified.symbol !== selected.symbol
  )
    throw new Error("分红对账身份或档案内容不符");
  const plan = reconciledCashPlan(
    verified,
    input.taxBps,
    input.start,
    input.end,
  );
  return background(
    "backtest",
    { ...input, kind: "cash-dividend-experiment" },
    async (job, signal) => {
      const { source, result } = await runWorker<{
        source: Snapshot;
        result: Backtest;
      }>(
        {
          type: "backtest",
          snapshot: selected,
          strategy: input.strategy,
          initial: input.initial,
          costs: input.costs,
          fullRoot: selected.dataRoot ?? settings().tdxRoot,
          cashDividends: {
            plan,
            start: input.start,
            end: input.end,
            review: verified,
          },
        },
        job.id,
      );
      signal.throwIfAborted();
      put("snapshot", source.id, source);
      return result;
    },
  );
}
