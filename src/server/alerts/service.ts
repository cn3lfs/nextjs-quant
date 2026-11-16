import { acquireScheduler, schedulerOwnerId } from "../infra/lease";
import { runWorker } from "../jobs/jobs";
const scope = globalThis as typeof globalThis & {
  quantAlertTicking?: Promise<unknown>;
};
/** Coalesce timer ticks while the existing compute worker owns the scan. */
export function tickAlerts() {
  if (scope.quantAlertTicking) return scope.quantAlertTicking;
  if (!acquireScheduler()) return Promise.resolve();
  const pending = runWorker({
    type: "alert-tick",
    schedulerOwner: schedulerOwnerId(),
  });
  scope.quantAlertTicking = pending.finally(() => {
    scope.quantAlertTicking = undefined;
  });
  return scope.quantAlertTicking;
}
