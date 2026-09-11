import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { dataDirectory, get } from "./db";
import {
  completedRpsObservation,
  type RpsObservation,
} from "./rps-observation";
import { runRpsObservation } from "./rps-observation-job";
import { settings } from "./settings";
export const workflowEnabled = () =>
  get<{ enabled: boolean }>("workflow-config")?.enabled === true;
const receipt = z.object({
  date: z.string(),
  phase: z.enum(["noon", "close"]),
  completedAt: z.number(),
  exitCode: z.literal(0),
});
export async function downloadReady(date: string, phase: "noon" | "close") {
  try {
    const parsed = receipt.parse(
      JSON.parse(
        (
          await readFile(
            join(dataDirectory(), `download-${date}-${phase}.json`),
            "utf8",
          )
        ).replace(/^\uFEFF/, ""),
      ),
    );
    return (
      parsed.date === date &&
      parsed.phase === phase &&
      parsed.completedAt <= Date.now()
    );
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
    if (phase !== "late" && !(await downloadReady(date, phase))) return;
    await runRpsObservation(phase, now);
  })()
    .catch(() => {
      /* Persistent workflow-check exposes failure; old ranking remains visible. */
    })
    .finally(() => {
      scope.workflowTick = undefined;
    });
}
