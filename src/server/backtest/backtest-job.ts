import type { Backtest, Snapshot, Strategy } from "~/lib/domain";
import {
  backtestCostsSchema,
  defaultBacktestCosts,
  type BacktestCosts,
} from "~/lib/backtest/backtest-costs";
import {
  researchAdjustmentSchema,
  type ResearchAdjustment,
} from "~/lib/research/evidence/research-adjustment";
import { get, put } from "../db";
import { settings } from "../infra/settings";
import { background, runWorker, updateJob } from "../jobs/jobs";
import { analyze } from "../research/research";

export function backtestJob(
  snapshotId: string,
  strategy: Strategy,
  initial: number,
  scope: "full" | "window" = "full",
  costInput: BacktestCosts = defaultBacktestCosts,
  adjustment?: ResearchAdjustment,
) {
  researchAdjustmentSchema.optional().parse(adjustment);
  const costs = backtestCostsSchema.parse(costInput);
  const selected = get<Snapshot>(snapshotId);
  if (!selected) throw new Error("数据快照不存在，请先加载行情");
  if (scope === "full" && selected.source !== "tdx-local")
    throw new Error("远端快照请选择窗口回测，不能冒充完整本地历史");
  const config = settings();
  return background(
    "backtest",
    {
      snapshotId,
      strategy,
      initial,
      scope,
      costs,
      ...(adjustment ? { adjustment } : {}),
      root: selected.dataRoot ?? config.tdxRoot,
    },
    async (job, signal) => {
      updateJob(job.id, {
        phase:
          scope === "full" ? "读取完整历史并核对所选快照" : "计算快照窗口回测",
      });
      const { result, source } = await runWorker<{
        result: Backtest;
        source: Snapshot;
      }>(
        {
          type: "backtest",
          adjustment,
          costs,
          snapshot: selected,
          strategy,
          initial,
          fullRoot:
            scope === "full"
              ? (selected.dataRoot ?? config.tdxRoot)
              : undefined,
        },
        job.id,
      );
      if (signal.aborted) throw new Error("已取消");
      put("snapshot", source.id, source);
      if (config.autoAnalysis)
        background("research", { contextId: job.id }, async (_, abort) =>
          analyze(
            job.id,
            "解释这次研究模拟的结果、回撤和局限。所有数字直接引用结果，不重新计算。",
            [
              {
                id: job.id,
                source: "本机确定性回测引擎",
                asOf: source.bars.at(-1)!.date,
                text: JSON.stringify({
                  ...result,
                  equity: result.equity.filter(
                    (_, i) =>
                      i % Math.max(1, Math.floor(result.equity.length / 30)) ===
                      0,
                  ),
                  trades: result.trades.slice(-30),
                }),
              },
            ],
            abort,
          ),
        );
      return result;
    },
  );
}
