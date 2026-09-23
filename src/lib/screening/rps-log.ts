import { z } from "zod";
import type { RpsProgress } from "./rps";

/**
 * Presentation vocabulary and pure helpers shared by the RPS data management
 * page. The运行状态 box reads the singleton job record; the历史日志 box reads the
 * persisted workflow checks. Both stay free of CLS review records: the page only
 * reports RPS batches.
 */
export const rpsTargetLabels = {
  stock: "个股",
  industry: "行业",
  concept: "概念",
} as const;
export const rpsModeLabels = {
  backfill: "回填",
  forward: "向前新增",
} as const;
export const rpsRunStatusLabels = {
  running: "运行中",
  complete: "已完成",
  failed: "失败",
  cancelled: "已取消",
} as const;
export const rpsObservationPhaseLabels = {
  noon: "午盘",
  late: "尾盘",
  close: "收盘",
} as const;

/** Workflow checks written by the RPS observation job use this id prefix. */
export const rpsLogIdPrefix = "rps-observation-check-";

export const rpsLogPayloadSchema = z.object({
  phase: z.string().min(1).max(32),
  date: z.string().min(1).max(32),
  status: z.string().min(1).max(32),
  error: z.string().max(2048).optional(),
  startedAt: z.number().optional(),
  completedAt: z.number().optional(),
  checkedAt: z.number().optional(),
});
export type RpsLogEntry = {
  id: string;
  date: string;
  phase: string;
  status: string;
  error?: string;
  at: number;
};

/**
 * Keeps the record shape out of the UI. Unparsable rows are dropped instead of
 * breaking the box: a log is an observation aid, not an invariant.
 */
export function toRpsLogEntry(row: {
  id: string;
  payload: unknown;
  updatedAt: number;
}): RpsLogEntry | null {
  const parsed = rpsLogPayloadSchema.safeParse(row.payload);
  if (!parsed.success) return null;
  const { phase, date, status, error, completedAt, checkedAt, startedAt } =
    parsed.data;
  return {
    id: row.id,
    date,
    phase,
    status,
    ...(error ? { error } : {}),
    at: completedAt ?? checkedAt ?? startedAt ?? row.updatedAt,
  };
}

export const rpsPhaseLabel = (phase: string) =>
  rpsObservationPhaseLabels[phase as keyof typeof rpsObservationPhaseLabels] ??
  phase;
export const rpsStatusLabel = (status: string) =>
  rpsRunStatusLabels[status as keyof typeof rpsRunStatusLabels] ?? status;

/** Shanghai wall clock, computed without a locale so SSR and tests agree. */
export function rpsLogTime(at: number) {
  return new Date(at + 8 * 3600000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

export const rpsPercent = (done: number, total: number) =>
  total > 0 ? Math.min(100, Math.max(0, Math.round((done / total) * 100))) : 0;

export function summarizeRpsProgress(progress: RpsProgress | null) {
  if (!progress) return null;
  return {
    target: rpsTargetLabels[progress.target ?? "stock"],
    mode: rpsModeLabels[progress.mode],
    status: progress.status,
    statusLabel: rpsStatusLabel(progress.status),
    phase: progress.phase,
    running: progress.status === "running",
    scanPercent: rpsPercent(progress.scanned, progress.total),
    dayPercent: rpsPercent(progress.completedDays, progress.totalDays),
    error: progress.error,
  };
}
