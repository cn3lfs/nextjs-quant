import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dataDirectory, get } from "../db";
import {
  completedRpsObservation,
  type RpsObservation,
} from "../screening/rps-observation";
import { runRpsObservation } from "../screening/rps-observation-job";
import { settings } from "../infra/settings";
export const workflowEnabled = () =>
  get<{ enabled: boolean }>("workflow-config")?.enabled === true;
const receipt = z.object({
  date: z.string(),
  phase: z.literal("close"),
  completedAt: z.number(),
  exitCode: z.literal(0),
});
// Only the close phase reads the daily files a download produces; noon and late
// estimate today's bar from online quotes. A redundant noon download therefore
// must never gate those observations.
export const requiresDownloadReceipt = (phase: RpsObservation["phase"]) =>
  phase === "close";
export async function downloadReady(date: string) {
  try {
    const parsed = receipt.parse(
      JSON.parse(
        (
          await readFile(
            join(dataDirectory(), `download-${date}-close.json`),
            "utf8",
          )
        ).replace(/^\uFEFF/, ""),
      ),
    );
    return parsed.date === date && parsed.completedAt <= Date.now();
  } catch {
    return false;
  }
}
const scope = globalThis as typeof globalThis & {
  workflowTick?: Promise<void>;
  workflowAttempt?: number;
};
export function scheduleWorkflowRps(now: number) {
  if (
    !workflowEnabled() ||
    scope.workflowTick ||
    now - (scope.workflowAttempt ?? 0) < 5 * 60000
  )
    return;
  const wall = new Date(now + 8 * 3600000).toISOString(),
    date = wall.slice(0, 10),
    time = wall.slice(11, 16);
  const phase: RpsObservation["phase"] | null =
    time >= "12:00" && time < "13:00"
      ? "noon"
      : time >= "14:40" && time < "15:00"
        ? "late"
        : time >= "15:30"
          ? "close"
          : null;
  if (!phase || completedRpsObservation(settings().tdxRoot, date, phase))
    return;
  scope.workflowAttempt = now;
  scope.workflowTick = (async () => {
    if (requiresDownloadReceipt(phase) && !(await downloadReady(date))) return;
    await runRpsObservation(phase, now);
  })()
    .catch(() => {
      /* Persistent workflow-check exposes failure; old ranking remains visible. */
    })
    .finally(() => {
      scope.workflowTick = undefined;
    });
}
