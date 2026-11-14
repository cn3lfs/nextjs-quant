import { z } from "zod";
import type { RpsPrerequisite } from "./rps-prerequisite";
import { researchDateSchema } from "trading-strategies/research/contracts/date";
import { rpsPeriods, rpsPolicy, type RpsExclusion } from "quant-rps";

export const rpsPeriodLabel = (period: number) =>
  period === 1 ? "当日（RPS1）" : `RPS${period}`;

export const rpsRequestSchema = z.object({
  target: z.enum(["stock", "industry", "concept"]).optional(),
  mode: z.enum(["forward", "backfill"]),
  days: z.number().int().min(1).max(250).default(250),
});
export type RpsRequest = z.infer<typeof rpsRequestSchema>;
export const rpsQuerySchema = z.object({
  date: researchDateSchema,
  period: z
    .number()
    .int()
    .refine((n) => (rpsPeriods as readonly number[]).includes(n)),
});
export type RpsDay = {
  industry?: import("./industry-rps").IndustryRpsAudit;
  date: string;
  mode: RpsRequest["mode"];
  periods: number[];
  policy: typeof rpsPolicy;
  total: number;
  pool: number;
  counts: number[];
  excluded: Record<RpsExclusion, string[]>;
  missing: number[];
  source: {
    root: string;
    calendar: string;
    calendarHash: string;
    actionsHash: string;
    actionsCoverage: string;
    universeHash: string;
    incrementSnapshots?: string[];
  };
  inputHash: string;
  createdAt: number;
};
export type RpsProgress = {
  target?: "stock" | "industry" | "concept";
  id: string;
  mode: RpsRequest["mode"];
  status: "running" | "complete" | "failed" | "cancelled" | "waiting";
  phase: string;
  scanned: number;
  total: number;
  completedDays: number;
  totalDays: number;
  startedAt: number;
  updatedAt: number;
  error?: string;
  waiting?: RpsPrerequisite;
};
