import { beijingClock } from "~/lib/market/market-session";
import { intradayConfigSchema } from "~/lib/strategy-facts/intraday-schedule";
import type { AlertRepository } from "../db/alert-repository";
import type { IntradayAlertConfig } from "~/lib/strategy-facts/intraday-alerts";

/** One supplemental quote check in each configured five-minute launch window. */
export function supplementalScanDue(
  repo: AlertRepository,
  config: IntradayAlertConfig,
  at: number,
  lastAttempt: number,
) {
  if (!config.intradayScanEnabled) return false;
  const { noon, late } = intradayConfigSchema.parse(
    repo.records.read("intraday-config") ?? {},
  );
  const { date } = beijingClock(at);
  return [noon, late].some((cutoff) => {
    const start = Date.parse(`${date}T${cutoff}:00+08:00`);
    return lastAttempt < start && start <= at && at < start + 300_000;
  });
}
