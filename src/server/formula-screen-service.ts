import { randomUUID } from "node:crypto";
import { validateScreenFormula, type SavedFormula } from "~/lib/formula-screen";
import { get, list, put, putChangedBatch } from "./db";
import type { Job } from "~/lib/domain";
import { settings } from "./settings";
import { background, runWorker, updateJob } from "./jobs";
import type { ScreeningResult } from "./screening";
import { serializeSnapshot } from "./snapshot-serializer";
import type { StoredScreenResult } from "./screen-results";
export const savedFormulas = () => list<SavedFormula>("tdx-formula", 1000);
export function exportFormulaScreen(job: Job) {
  if (job.type !== "screen" || job.status !== "completed" || !job.result) throw new Error("只能导出已完成的公式选股任务");
  const input = job.input as {formula: unknown; root: string; now: number};
  const formula = validateScreenFormula(input.formula);
  return {format: "quant-formula-screen-export-1", jobId: job.id, createdAt: job.createdAt, completedAt: job.updatedAt, source: "tdx-local", adjustment: "none", parameters: {...input, formula}, ...(job.result as StoredScreenResult)};
}
export function saveFormula(input: unknown) {
  const formula = validateScreenFormula(input);
  const id = formula.id ?? randomUUID();
  return put("tdx-formula", `tdx-formula-${id}`, {...formula, id, updatedAt: Date.now()});
}
export function formulaScreenJob(input: unknown) {
  const formula = validateScreenFormula(input);
  const work = {type: "formula-screen" as const, root: settings().tdxRoot, formula, now: Date.now()};
  return background("screen", {...work, period: "day", source: "tdx-local", adjustment: "none"}, async (job, signal) => {
    const result = await runWorker<ScreeningResult>(work, job.id);
    for (let i=0; i<result.snapshots.length; i+=50) {
      signal.throwIfAborted();
      if (get<Job>(job.id)?.status !== "running") throw new Error("公式选股已取消");
      updateJob(job.id, {phase: "保存公式候选快照", progress: 95});
      putChangedBatch("snapshot", result.snapshots.slice(i,i+50), serializeSnapshot);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    signal.throwIfAborted();
    const {snapshots: _snapshots, ...stored} = result;
    return {...stored, formula, period: "day", researchMode: "latest-local", universeSource: "当前本地通达信全 A 股日线", researchWarnings: ["使用最新已完成本地日线，不承诺数据为当前交易日；不复权。候选表均线/量比为既有默认描述指标，不参与公式判定。"]};
  }, work);
}
