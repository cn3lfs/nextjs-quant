import { AlertEngine } from "./engine";
import { AlertRepository } from "../db/alert-repository";
import { settings } from "../infra/settings";
import { holdsSchedulerLease } from "../infra/lease";
import { localCalendarReference } from "../market/data-health";
import { downloadReady } from "../jobs/workflow-scheduler";
import { enqueueAlert } from "../infra/notifications";
import { recordRuntimeError } from "../infra/runtime-errors";
import { evaluateAlertInputs } from "./inputs";
import { settleAlertOutcomes } from "./outcomes";

export type AlertTickWork = { type: "alert-tick"; schedulerOwner: string };

/** Evaluate and commit in one worker: authorization closures never cross threads. */
export async function executeAlertTick(work: AlertTickWork) {
  if (!holdsSchedulerLease(work.schedulerOwner)) return;
  const repo = new AlertRepository();
  const engine = new AlertEngine({
    clock: { now: () => Date.now() },
    repository: repo,
    mode: () => settings().alerts.mode,
    leader: () => holdsSchedulerLease(work.schedulerOwner),
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
    evaluate: (phase, now, closeDate) =>
      evaluateAlertInputs(phase, now, repo, closeDate),
    deliver: enqueueAlert,
    outcomes: (now) => settleAlertOutcomes(now, repo),
    error: (error) => {
      recordRuntimeError("alert-engine", error);
    },
  });
  await engine.tick();
  return repo.state("runtime");
}
