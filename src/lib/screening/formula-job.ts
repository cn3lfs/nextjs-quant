import type { Job } from "../domain";

/** The screen category also contains retired task formats. */
export function isFormulaScreenJob(job: Pick<Job, "type" | "input">) {
  return (
    job.type === "screen" &&
    (job.input as { type?: unknown } | null)?.type === "formula-screen"
  );
}
