import { clearFormulaSnapshotSpool } from "./formula-snapshot-spool";
import { z } from "zod";
import { isFormulaScreenJob } from "~/lib/screening/formula-job";
import { randomUUID } from "node:crypto";
import {
  validateScreenFormula,
  type SavedFormula,
} from "trading-strategies/formula/formula-screen";
import { readRecordSnapshot, put } from "../db";
import type { Job } from "~/lib/domain";
import { settings } from "../infra/settings";
import { background, runWorker } from "../jobs/jobs";
import type { FormulaScreenOutput } from "./formula-screen-work";
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
      source: z.literal("tdx-local").optional(),
      adjustment: z.enum(["none", "forward", "backward"]).optional(),
      strategy: strategyObjectSchema.optional(),
    })
    .parse(job.input);
  const result = job.result as StoredScreenResult;
  const formula = validateScreenFormula(input.formula);
  return {
    format: "quant-formula-screen-export-1",
    jobId: job.id,
    createdAt: job.createdAt,
    completedAt: job.updatedAt,
    source: "tdx-local",
    adjustment: input.adjustment ?? "none",
    parameters: { ...input, formula },
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
  const formula = validateScreenFormula(input);
  const work = {
    type: "formula-screen" as const,
    root: settings().tdxRoot,
    formula,
    now: Date.now(),
    strategy: new StrategyRepository().saveStrategy(formulaStrategy(formula)),
  };
  return background(
    "screen",
    { ...work, period: "day", source: "tdx-local", adjustment: "forward" },
    async (job, signal) => {
      try {
        const result = await runWorker<FormulaScreenOutput>(work, job.id);
        signal.throwIfAborted();
        return {
          ...result,
          formula,
          adjustment: "forward",
          period: "day",
          researchMode: "latest-local",
          universeSource: "当前本地通达信全 A 股日线",
          researchWarnings: [
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
