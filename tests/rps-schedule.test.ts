import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { put, sqlite } from "../src/server/db";
import {
  RpsWorkerClient,
  scheduleRps,
} from "../src/server/screening/rps-client";
import { RpsStore } from "../src/server/screening/rps-store";
import { rpsDate, rpsDay, rpsProgress } from "./rps-fixture";
import type { RpsProgress } from "../src/lib/rps";

const scope = globalThis as typeof globalThis & {
  rpsAttempt?: string;
  industryRpsAttempt?: string;
  conceptRpsAttempt?: string;
};
const now = Date.parse(`${rpsDate}T15:05:00+08:00`);
beforeEach(() => {
  delete scope.rpsAttempt;
  delete scope.industryRpsAttempt;
  delete scope.conceptRpsAttempt;
  sqlite().exec(
    "DELETE FROM rps_job; DELETE FROM rps_values; DELETE FROM rps_days",
  );
  put("settings", "settings", { industryBlocksRoot: "fixture" });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => sqlite().close());
function mockWorker() {
  return vi
    .spyOn(RpsWorkerClient.prototype, "start")
    .mockImplementation((request) => {
      const progress: RpsProgress = {
        ...rpsProgress(),
        mode: "forward",
        target: request.target,
        startedAt: now,
      };
      expect(new RpsStore(sqlite()).claim(progress)).toBe(true);
      return { id: progress.id, done: Promise.resolve(progress) };
    });
}
it("after close, stock and configured industry are scheduled serially under one shared lease", () => {
  const worker = mockWorker(),
    store = new RpsStore(sqlite());
  scheduleRps(now - 60000);
  expect(worker).toHaveBeenCalledTimes(0);
  scheduleRps(now);
  expect(worker.mock.calls[0]![0]).toEqual({
    target: "stock",
    mode: "forward",
    days: 1,
  });
  scheduleRps(now);
  expect(worker).toHaveBeenCalledTimes(1);
  store.finish({ ...store.progress()!, status: "complete" });
  scheduleRps(now);
  expect(worker.mock.calls[1]![0]).toEqual({
    target: "industry",
    mode: "forward",
    days: 1,
  });
  store.finish({
    ...store.progress()!,
    status: "failed",
    error: "missing file",
  });
  scheduleRps(now);
  expect(worker).toHaveBeenCalledTimes(3);
  expect(worker.mock.calls[2]![0].target).toBe("concept");
  scheduleRps(now);
  expect(worker).toHaveBeenCalledTimes(3);
});
it("empty configured directory disables automatic industry work without stopping stock RPS", () => {
  put("settings", "settings", { industryBlocksRoot: "" });
  const worker = mockWorker(),
    store = new RpsStore(sqlite());
  scheduleRps(now);
  store.finish({ ...store.progress()!, status: "complete" });
  scheduleRps(now);
  expect(worker).toHaveBeenCalledTimes(1);
  expect(worker.mock.calls[0]![0].target).toBe("stock");
});
it("an already stored stock day does not suppress industry; persisted industry failure is not retried after restart", () => {
  const fixture = rpsDay(),
    store = new RpsStore(sqlite()),
    worker = mockWorker();
  store.saveDay(fixture.day, fixture.rows);
  scheduleRps(now);
  expect(worker.mock.calls[0]![0].target).toBe("industry");
  store.finish({ ...store.progress()!, status: "failed" });
  delete scope.rpsAttempt;
  delete scope.industryRpsAttempt;
  scheduleRps(now);
  expect(worker).toHaveBeenCalledTimes(2);
  expect(worker.mock.calls[1]![0].target).toBe("concept");
});
