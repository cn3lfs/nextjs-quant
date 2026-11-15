import { publicDataRoot } from "../data-sources/binance/public-data-store";
import { settings } from "../infra/settings";
import { background, runWorker } from "./jobs";
export function startBinanceBackfill(includeOneMinute = false) {
  const root = publicDataRoot(settings().binancePublicDataRoot);
  return background(
    "market-data-backfill",
    { source: "binance-public-data", root, includeOneMinute },
    (job) =>
      runWorker(
        { type: "binance-public-data", root, includeOneMinute },
        job.id,
      ),
    { source: "binance-public-data", root },
  );
}
