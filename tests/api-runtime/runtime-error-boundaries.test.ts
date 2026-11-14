import { afterEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({
  recover: vi.fn(),
  rps: vi.fn(),
  drain: vi.fn(),
  crypto: vi.fn(),
}));
vi.mock("~/server/jobs/jobs", () => ({
  recoverJobs: calls.recover,
  background: vi.fn(),
  runWorker: vi.fn(),
}));
vi.mock("~/server/screening/rps-client", () => ({ scheduleRps: calls.rps }));
vi.mock("~/server/crypto-trading/service", () => ({
  tickCryptoBots: calls.crypto,
}));
vi.mock("~/server/infra/notifications", () => ({
  recoverDeliveries: vi.fn(),
  drain: calls.drain,
  enqueue: vi.fn(),
}));
vi.mock("~/server/infra/lease", () => ({ acquireScheduler: () => true }));
import { startRuntime } from "~/server/runtime";
import { recentRuntimeErrors } from "~/server/infra/runtime-errors";
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

it("records startup and interval failures without starting real providers or duplicating startup", async () => {
  vi.useFakeTimers();
  const original = new Error("startup secret");
  calls.recover.mockImplementationOnce(() => {
    throw original;
  });
  expect(() => startRuntime()).toThrow(original);
  expect(recentRuntimeErrors().entries).toEqual([
    expect.objectContaining({ event: "runtime-start" }),
  ]);
  calls.rps.mockImplementation(() => {
    throw Object.assign(new Error("rps secret"), { code: "SQLITE_BUSY" });
  });
  calls.drain.mockRejectedValue(new Error("webhook secret"));
  calls.crypto.mockRejectedValue(new Error("account secret"));
  startRuntime();
  startRuntime();
  await vi.advanceTimersByTimeAsync(30000);
  const report = recentRuntimeErrors();
  expect(report.entries.map((entry) => entry.event)).toEqual(
    expect.arrayContaining([
      "runtime-start",
      "scheduler-tick",
      "notification-drain",
      "crypto-tick",
    ]),
  );
  expect(
    report.entries
      .filter((entry) => entry.event === "crypto-tick")
      .reduce((n, row) => n + row.count, 0),
  ).toBe(4);
  expect(calls.recover).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(report)).not.toContain("secret");
});
