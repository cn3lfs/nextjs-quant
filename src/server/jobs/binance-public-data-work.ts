import { readJob } from "../db/jobs";
import {
  backfillPublicData,
  publicDataStatus,
} from "../data-sources/binance/public-data-store";
export type BinancePublicDataWork = {
  type: "binance-public-data";
  root: string;
  includeOneMinute: boolean;
  jobId?: string;
};
export async function executeBinanceBackfill(
  work: BinancePublicDataWork,
  progress: (n: number, phase: string) => void,
) {
  await backfillPublicData({
    root: work.root,
    intervals: work.includeOneMinute
      ? ["1d", "4h", "1h", "15m", "5m", "1m"]
      : undefined,
    progress(done, total, phase) {
      if (work.jobId && readJob(work.jobId)?.status === "cancelled")
        throw new Error("Historical backfill cancelled");
      progress(Math.floor((100 * done) / Math.max(1, total)), phase);
    },
  });
  return publicDataStatus(work.root);
}
