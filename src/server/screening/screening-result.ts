import type { Candidate, Snapshot } from "~/lib/domain";

export type ScreeningResult = {
  candidates: Candidate[];
  snapshots: Snapshot[];
  errors: { symbol: string; error: string }[];
  excluded: { symbol: string; name?: string; date?: string; reason: string }[];
  asOf: string | null;
  total: number;
  elapsedMs: number;
};
