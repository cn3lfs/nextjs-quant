import { createHash } from "node:crypto";
import type { StrategyObjectInput } from "trading-strategies";
import { StrategyRepository } from "../../db/strategy-repository";
import { watchStrategy, type WatchPosition } from "./watch";
import { scanStrategy, type ScanCapital } from "./scan";
import type { StrategySeries } from "./evaluation";
import type { DriverBookAdmission } from "./book";

/** Explicit invocation only. R2 owns scheduling and delivery; this never sends. */
export function persistWatch(
  strategy: StrategyObjectInput,
  series: StrategySeries,
  asOf: string,
  options: {
    position?: WatchPosition;
    membership?: readonly string[];
    capital?: ScanCapital;
    expiresAt?: string;
    admission?: DriverBookAdmission;
  } = {},
  repository = new StrategyRepository(),
) {
  const events = watchStrategy(strategy, series, asOf, options);
  return events.filter((event) => {
    const candidate =
      event.type === "entry" && options.capital
        ? scanStrategy(strategy, [series], asOf, options)[0]
        : undefined;
    const plan =
      candidate && candidate.quantity !== null && candidate.quantity > 0
        ? {
            id: `plan-${createHash("sha256").update(event.key).digest("hex")}`,
            strategyId: strategy.id,
            strategyVersion: strategy.version,
            symbol: event.symbol,
            sleeve: event.sleeve,
            triggerKey: event.key,
            entry: event.price,
            quantity: candidate.quantity,
            tranches: candidate.tranches,
            stop: event.stop,
            target: event.target,
            expiresAt: options.expiresAt ?? null,
            status: "open" as const,
          }
        : undefined;
    return repository.record(strategy, event, plan);
  });
}
