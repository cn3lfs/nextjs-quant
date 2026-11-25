import { tickCryptoBots } from "./crypto-trading/service";
import { recordRuntimeError } from "./infra/runtime-errors";
import { scheduleRps } from "./screening/rps-client";
import { scheduleClsReview } from "./news/cls-review-scheduler";
import { scheduleNews } from "./news/news-scheduler";
import { drain, recoverDeliveries } from "./infra/notifications";
import { acquireScheduler } from "./infra/lease";
import { recoverJobs, background, runWorker } from "./jobs/jobs";
import { recoverDiagnoseArchives } from "./research/diagnose/archive";
import { settings } from "./infra/settings";
import { put } from "./db";
import type { Coverage } from "~/lib/domain";
import { tickAlerts } from "./alerts/service";
import { tickPipelineScheduler } from "./pipeline/pipeline-scheduler";
const scope = globalThis as typeof globalThis & {
  quantRuntimeStarted?: boolean;
  quantCryptoTicking?: boolean;
  quantDeliveriesRecovered?: boolean;
  quantPaperTicking?: boolean;
  quantPipelineTicking?: boolean;
};
export function recoverRuntimeJobs() {
  recoverJobs();
  return recoverDiagnoseArchives();
}
export function startRuntime() {
  if (scope.quantRuntimeStarted) return;
  scope.quantRuntimeStarted = true;
  try {
    recoverRuntimeJobs();
  } catch (error) {
    scope.quantRuntimeStarted = false;
    recordRuntimeError("runtime-start", error);
    throw error;
  }
  const timer = setInterval(() => {
    void tick().catch((error) => {
      recordRuntimeError("scheduler-tick", error);
    });
  }, 60000);
  const outbox = setInterval(() => {
    if (!acquireScheduler()) return;
    if (!scope.quantDeliveriesRecovered) {
      recoverDeliveries();
      scope.quantDeliveriesRecovered = true;
    }
    void drain().catch((error) => {
      recordRuntimeError("notification-drain", error);
    });
  }, 3000);
  const crypto = async () => {
    if (scope.quantCryptoTicking) return;
    scope.quantCryptoTicking = true;
    try {
      await tickCryptoBots();
    } finally {
      scope.quantCryptoTicking = false;
    }
  };
  const cryptoTimer = setInterval(() => {
    void crypto().catch((error) => {
      recordRuntimeError("crypto-tick", error);
    });
  }, 10000);
  timer.unref();
  outbox.unref();
  cryptoTimer.unref();
  void tick().catch((error) => {
    recordRuntimeError("scheduler-tick", error);
  });
  void crypto().catch((error) => {
    recordRuntimeError("crypto-tick", error);
  });
}
export function scanJob() {
  return background("scan", {}, async (job) => {
    const result = await runWorker<Coverage>(
      { type: "scan", root: settings().tdxRoot },
      job.id,
    );
    put("coverage", "coverage", result);
    return { counts: result.counts, securities: result.securities.length };
  });
}
export async function tick() {
  if (!acquireScheduler()) return;
  scheduleRps(Date.now());
  scheduleClsReview();
  scheduleNews();
  try {
    await tickAlerts();
  } catch (error) {
    recordRuntimeError("alert-engine", error);
  }
  if (!scope.quantPaperTicking) {
    scope.quantPaperTicking = true;
    void runWorker({ type: "paper-tick", now: Date.now() })
      .catch((error) => {
        recordRuntimeError("scheduler-tick", error);
      })
      .finally(() => {
        scope.quantPaperTicking = false;
      });
  }
  if (!scope.quantPipelineTicking) {
    scope.quantPipelineTicking = true;
    void tickPipelineScheduler()
      .catch((error) => {
        // The diagnostics registry currently uses this event for scheduler failures.
        recordRuntimeError("scheduler-tick", error);
      })
      .finally(() => {
        scope.quantPipelineTicking = false;
      });
  }
}
