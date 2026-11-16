import { afterEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ runWorker: vi.fn() }));
vi.mock("~/server/jobs/jobs", () => ({ runWorker: calls.runWorker }));
import { tickAlerts } from "~/server/alerts/service";
import { executeAlertTick } from "~/server/alerts/tick-work";
import { acquireScheduler, schedulerOwnerId } from "~/server/infra/lease";
import { get, put } from "~/server/db";
import { AlertRepository } from "~/server/db/alert-repository";

afterEach(() => vi.clearAllMocks());

it("dispatches to the task worker once while a scan is pending, then releases the slot", async () => {
  let finish!: () => void;
  calls.runWorker.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const first = tickAlerts();
  const second = tickAlerts();
  expect(second).toBe(first);
  expect(calls.runWorker).toHaveBeenCalledExactlyOnceWith({
    type: "alert-tick",
    schedulerOwner: schedulerOwnerId(),
  });
  finish();
  await first;
  calls.runWorker.mockResolvedValueOnce(undefined);
  await tickAlerts();
  expect(calls.runWorker).toHaveBeenCalledTimes(2);
});

it("does not dispatch or steal another process's live scheduler lease", async () => {
  put("lease", "scheduler-owner", {
    owner: "other-live-host",
    pid: process.pid,
  });
  await tickAlerts();
  expect(calls.runWorker).not.toHaveBeenCalled();
  expect(get<{ owner: string }>("scheduler-owner")?.owner).toBe(
    "other-live-host",
  );
});

it("the worker rejects a stale host identity before evaluating or writing alert state", async () => {
  put("lease", "scheduler-owner", {
    owner: schedulerOwnerId(),
    pid: process.pid,
  });
  expect(acquireScheduler()).toBe(true);
  await executeAlertTick({ type: "alert-tick", schedulerOwner: "stale-host" });
  expect(new AlertRepository().state("runtime")).toBeUndefined();
});

it("clears the single-flight flag after a worker failure so a later tick can retry", async () => {
  calls.runWorker.mockRejectedValueOnce(new Error("fixture worker failed"));
  await expect(tickAlerts()).rejects.toThrow("fixture worker failed");
  calls.runWorker.mockResolvedValueOnce(undefined);
  await tickAlerts();
  expect(calls.runWorker).toHaveBeenCalledTimes(2);
});
