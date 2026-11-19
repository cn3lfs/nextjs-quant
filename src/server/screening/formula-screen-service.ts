import { clearFormulaSnapshotSpool } from "./formula-snapshot-spool";
import { z } from "zod";
import { isFormulaScreenJob } from "~/lib/screening/formula-job";
import { formulaScreenInputSchema } from "~/lib/screening/formula-screen-request";
import { randomUUID } from "node:crypto";
import {
  validateScreenFormula,
  type SavedFormula,
} from "trading-strategies/formula/formula-screen";
import { readRecordSnapshot, put } from "../db";
import type { Job } from "~/lib/domain";
import { settings } from "../infra/settings";
import { background, runWorker, updateJob } from "../jobs/jobs";
import {
  executeFormulaScreen,
  type FormulaScreenOutput,
} from "./formula-screen-work";
import type { StoredScreenResult } from "./screen-results";
import { readJobResultSnapshot } from "../db/job-results";
import { formulaStrategy } from "../strategies/drivers/strategy-definitions";
import { strategyObjectSchema } from "trading-strategies";
import { StrategyRepository } from "../db/strategy-repository";
export const savedFormulas = () =>
  readRecordSnapshot("tdx-formula", (rows: Iterable<SavedFormula>) =>
    [...rows].sort(
      (a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id),
    ),
  );
export function exportFormulaScreen(job: Job) {
  if (!isFormulaScreenJob(job) || job.status !== "completed" || !job.result)
    throw new Error("只能导出已完成的公式选股任务");
  const input = z
    .object({
      type: z.literal("formula-screen"),
      formula: z.unknown(),
      root: z.string(),
      now: z.number().finite(),
      period: z.literal("day").optional(),
      source: z.enum(["tdx-local", "thsdk-hq"]).optional(),
      symbols: z.array(z.string()).optional(),
      adjustmentSource: z.enum(["local-gbbq", "thsdk-native"]).optional(),
      volumeUnit: z.string().optional(),
      adjustment: z.enum(["none", "forward", "backward"]).optional(),
      strategy: strategyObjectSchema.optional(),
    })
    .parse(job.input);
  const result = job.result as StoredScreenResult;
  const formula = validateScreenFormula(input.formula);
  const source = result.source ?? input.source ?? "tdx-local";
  const { symbols, ...parameters } = input;
  return {
    format: "quant-formula-screen-export-1",
    jobId: job.id,
    createdAt: job.createdAt,
    completedAt: job.updatedAt,
    source,
    adjustment: result.adjustment ?? input.adjustment ?? "none",
    adjustmentSource: result.adjustmentSource ?? input.adjustmentSource,
    volumeUnit: result.volumeUnit ?? input.volumeUnit,
    parameters: {
      ...parameters,
      ...(source === "thsdk-hq" ? { symbols } : {}),
      formula,
    },
    formula,
    candidates: result.candidates,
    excluded: result.excluded,
    errors: result.errors,
    total: result.total,
    asOf: result.asOf,
    elapsedMs: result.elapsedMs,
    period: result.period,
    researchMode: result.researchMode,
    universeSource: result.universeSource,
    researchWarnings: result.researchWarnings,
  };
}
/** Complete export assembled from bounded batches within one read snapshot. */
export function exportStoredFormulaScreen(id: string) {
  const value = readJobResultSnapshot(id, ({ job, json, array }) => {
    const input = json<Job["input"]>("$.input");
    if (!isFormulaScreenJob({ ...job, input }) || job.status !== "completed")
      throw new Error("只能导出已完成的公式选股任务");
    const result = json<StoredScreenResult>("$.result", [
      "$.candidates",
      "$.excluded",
      "$.errors",
      "$.snapshots",
    ]);
    if (!result) throw new Error("只能导出已完成的公式选股任务");
    result.candidates = [
      ...array<StoredScreenResult["candidates"][number]>("$.result.candidates"),
    ];
    result.excluded = [
      ...array<StoredScreenResult["excluded"][number]>("$.result.excluded"),
    ];
    result.errors = [
      ...array<StoredScreenResult["errors"][number]>("$.result.errors"),
    ];
    return exportFormulaScreen({ ...job, progress: 100, input, result });
  });
  if (!value) throw new Error("任务不存在");
  return value;
}
export function saveFormula(input: unknown) {
  const formula = validateScreenFormula(input);
  const id = formula.id ?? randomUUID();
  return put("tdx-formula", `tdx-formula-${id}`, {
    ...formula,
    id,
    updatedAt: Date.now(),
  });
}
export function formulaScreenJob(input: unknown) {
  const { marketSource, symbols, ...definition } =
    formulaScreenInputSchema.parse(input);
  const formula = validateScreenFormula(definition);
  const ths = marketSource === "thsdk";
  const work = {
    type: "formula-screen" as const,
    root: settings().tdxRoot,
    formula,
    ...(ths ? { marketSource, symbols: [...new Set(symbols)].sort() } : {}),
    now: Date.now(),
    strategy: new StrategyRepository().saveStrategy(formulaStrategy(formula)),
  };
  return background(
    "screen",
    {
      ...work,
      period: "day",
      source: ths ? "thsdk-hq" : "tdx-local",
      adjustment: "forward",
    },
    async (job, signal) => {
      try {
        const result = ths
          ? await executeFormulaScreen(
              { ...work, attemptId: job.attemptId, signal },
              job.id,
              (progress, phase, counts) => {
                signal.throwIfAborted();
                const updated = updateJob(job.id, {
                  progress,
                  phase,
                  ...(counts ? { workProgress: counts } : {}),
                });
                if (updated?.status === "cancelled")
                  throw new Error("任务已取消");
              },
            )
          : await runWorker<FormulaScreenOutput>(work, job.id);
        signal.throwIfAborted();
        return {
          ...result,
          formula,
          adjustment: "forward",
          period: "day",
          source: ths ? "thsdk-hq" : "tdx-local",
          adjustmentSource: ths ? "thsdk-native" : "local-gbbq",
          volumeUnit: ths ? "股/份" : "通达信原始单位",
          researchMode: ths ? "latest-thsdk" : "latest-local",
          universeSource: ths
            ? `同花顺指定证券池（${result.total} 只）`
            : "当前本地通达信全 A 股日线",
          researchWarnings: ths
            ? [
                "同花顺延迟行情，仅使用指定证券池最新已完成日线。信号价采用同花顺原生前复权（qfq），成交价冻结同源未复权原价。",
              ]
            : [
                "使用最新已完成本地日线，不承诺数据为当前交易日；前复权信号价（成交/账户保留原价）。候选表均线/量比为既有默认描述指标，不参与公式判定。",
              ],
        } satisfies StoredScreenResult;
      } finally {
        // The host also cleans an abruptly terminated/cancelled compute worker.
        await clearFormulaSnapshotSpool(job.id);
      }
    },
    work,
  );
}
