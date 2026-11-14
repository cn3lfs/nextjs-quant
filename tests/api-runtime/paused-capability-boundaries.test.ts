import { expect, it, vi } from "vitest";
const workers = vi.hoisted(() => ({ spawned: vi.fn() }));
vi.mock("node:worker_threads", () => ({
  Worker: class {
    constructor() {
      workers.spawned();
      throw new Error("Paused capability spawned a worker");
    }
  },
}));
import { appRouter } from "~/server/api/root";
import { put, sqlite } from "~/server/db";
import { intradayConfigSchema } from "~/lib/strategy-facts/intraday-schedule";
import { scheduleIntraday } from "~/server/monitoring/intraday-client";
import {
  intradayDependencies,
  runIntradayTick,
} from "~/server/monitoring/intraday-service";
import {
  localLedgerDependencies,
  runSignalLedger,
} from "~/server/monitoring/signal-ledger-job";
import { SignalLedgerStore } from "~/server/monitoring/signal-ledger-store";
import {
  scheduleSignalLedger,
  SignalLedgerWorker,
} from "~/server/monitoring/signal-ledger-client";

it("declares real execution bindings independently of route names", () => {
  for (const [name, capability] of [
    ["formulaScreen", "formulaScreen"],
    ["breakout", "breakout"],
    ["intradayRun", "intraday"],
  ] as const)
    expect(appRouter._def.procedures[name]._def.meta).toEqual({
      capability,
      operation: "compute",
    });
});
it("paused manual API and scheduler calls cannot spawn work or rewrite saved inputs", async () => {
  put(
    "intraday-config",
    "intraday-config",
    intradayConfigSchema.parse({ enabled: true }),
  );
  const before = sqlite().prepare("SELECT * FROM records ORDER BY id").all();
  const caller = appRouter.createCaller({ headers: new Headers() });
  await expect(caller.intradayRun()).rejects.toMatchObject({
    code: "PRECONDITION_FAILED",
    message: expect.stringContaining("暂停"),
  });
  await scheduleIntraday(Date.now(), true);
  scheduleSignalLedger(Date.now());
  await expect(new SignalLedgerWorker().run(Date.now())).rejects.toThrow(
    "暂停",
  );
  await expect(runIntradayTick(intradayDependencies(vi.fn()))).rejects.toThrow(
    "暂停",
  );
  await expect(
    runSignalLedger(
      new SignalLedgerStore(sqlite()),
      localLedgerDependencies("", []),
      Date.parse("2025-03-07T14:00:00+08:00"),
    ),
  ).rejects.toThrow("暂停");
  expect(workers.spawned).not.toHaveBeenCalled();
  expect(sqlite().prepare("SELECT * FROM records ORDER BY id").all()).toEqual(
    before,
  );
  expect((await caller.intradaySummary()).config.enabled).toBe(true);
});
