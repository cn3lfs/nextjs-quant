import { AlertEngine } from "./engine";
import { AlertRepository } from "../db/alert-repository";
import { settings } from "../infra/settings";
import { acquireScheduler } from "../infra/lease";
import { localCalendarReference } from "../market/data-health";
import { downloadReady } from "../jobs/workflow-scheduler";
import { enqueueAlert } from "../infra/notifications";
import { recordRuntimeError } from "../infra/runtime-errors";
import { evaluateAlertInputs } from "./inputs";
import { settleAlertOutcomes } from "./outcomes";
const scope = globalThis as typeof globalThis & {
  quantAlertEngine?: AlertEngine;
};
export function tickAlerts() {
  const repo = new AlertRepository();
  const engine = (scope.quantAlertEngine ??= new AlertEngine({
    clock: { now: () => Date.now() },
    repository: repo,
    mode: () => settings().alerts.mode,
    leader: acquireScheduler,
    calendar: async (now) => {
      const config = settings();
      const reference = await localCalendarReference(
        config.tdxRoot,
        config.calendar,
      );
      repo.records.calendar(reference.days, reference.source, now);
      return reference.days;
    },
    receipt: downloadReady,
    evaluate: (phase, now) => evaluateAlertInputs(phase, now, repo),
    deliver: enqueueAlert,
    outcomes: (now) => settleAlertOutcomes(now, repo),
    error: (error) => {
      recordRuntimeError("alert-engine", error);
    },
  }));
  return engine.tick();
}
