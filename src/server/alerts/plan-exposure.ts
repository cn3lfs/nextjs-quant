import { beijingClock, marketSession } from "~/lib/market/market-session";
import type { Settings } from "~/lib/domain";
import type { AlertRepository } from "../db/alert-repository";

export type ExposureSnapshot = {
  market: string;
  sleeve: string;
  value: number;
  at: number;
};

/** Intraday snapshots expire; evening planning uses the last completed close. */
export function planExposure(
  market: "cn-equity" | "crypto",
  config: Settings,
  now: number,
  repository: AlertRepository,
) {
  const wall = beijingClock(now);
  const trading = config.calendar.length
    ? config.calendar.includes(wall.date)
      ? "open"
      : "closed"
    : "unknown";
  const session = marketSession(now, trading);
  const inSession =
    market === "crypto" ||
    ["auction", "morning", "lunch", "afternoon"].includes(session.kind);
  const current = repository.state<ExposureSnapshot[]>("exposure") ?? [];
  const closed = repository.state<ExposureSnapshot[]>(
    `exposure-close:${market}`,
  );
  const usage = (!inSession && closed ? closed : current).filter(
    (u) => u.market === market,
  );
  const marker = usage.find((u) => u.sleeve === "__checked__");
  const valid =
    !!marker &&
    usage.every(
      (u) =>
        u.at <= now &&
        (inSession
          ? now - u.at <= 10 * 60000
          : !!closed || beijingClock(u.at).minutes >= 15 * 60),
    );
  return {
    usage,
    valid,
    at: marker?.at ?? null,
    basis: inSession ? ("intraday" as const) : ("post-close" as const),
  };
}
