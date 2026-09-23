import { expect, it, vi, beforeEach } from "vitest";
import fixture from "../fixtures/hithink-dividends.json";
const state = vi.hoisted(() => ({
  records: new Map<string, unknown>(),
  put: vi.fn(),
  background: vi.fn(),
  worker: vi.fn(),
}));
vi.mock("../../src/server/db/index", () => ({
  get: (id: string) => state.records.get(id),
  put: state.put,
}));
vi.mock("../../src/server/jobs/jobs", () => ({
  background: state.background,
  runWorker: state.worker,
}));
import { cashDividendJob } from "../../src/server/backtest/cash-dividend-job";
import { actionReview } from "../../src/server/backtest/backtest-actions";
import { dividendSchedule } from "../../src/server/data-sources/hithink/hithink-dividends";
import { reconcileDividends } from "../../src/server/backtest/dividend-reconciliation";
import { defaultStrategy, type Snapshot } from "../../src/lib/domain";
import { defaultBacktestCosts } from "../../src/lib/backtest/backtest-costs";
const source: Snapshot = {
  id: "s",
  symbol: "sh600519",
  period: "day",
  source: "tdx-local",
  adjustment: "none",
  hash: "h",
  createdAt: 1,
  dataRoot: "fixture-root",
  bars: ["2025-01-01", "2026-09-08"].map((date) => ({
    date,
    open: 10,
    high: 11,
    low: 9,
    close: 10,
    volume: 100,
    amount: 1000,
  })),
};
const remote = dividendSchedule(source.symbol, fixture.raw, fixture.fetchedAt);
const local = actionReview(
  source,
  remote.events.map((e) => ({
    date: `${String(e.ex).slice(0, 4)}-${String(e.ex).slice(4, 6)}-${String(e.ex).slice(6)}`,
    category: 1,
    name: "除权除息",
    dividend: Math.fround(Number(e.dividend) * 10) / 10,
    bonusRatio: 0,
    rightsRatio: 0,
    rightsPrice: 0,
  })),
  { file: "fixture-root/gbbq", modified: 1, fetchedAt: 2 },
);
const reconciliation = reconcileDividends(local, remote);
const id = `dividend-reconciliation-${reconciliation.hash}`;
const input = {
  snapshotId: "s",
  strategy: defaultStrategy,
  initial: 100000,
  costs: defaultBacktestCosts,
  reconciliationId: id,
  start: "2026-01-01",
  end: "2026-09-08",
  taxBps: 2000,
};
beforeEach(() => {
  state.records.clear();
  state.put.mockReset();
  state.background.mockReset();
  state.worker.mockReset();
  state.records.set("s", structuredClone(source));
  state.records.set(
    `dividend-schedule-${remote.hash}`,
    structuredClone(remote),
  );
  state.records.set(id, {
    local: structuredClone(local),
    remoteArchiveId: `dividend-schedule-${remote.hash}`,
    reconciliation: structuredClone(reconciliation),
  });
});
it("uses verified archived sources and original parameters, saving a separate worker result", async () => {
  cashDividendJob(input);
  expect(state.background.mock.calls[0]![0]).toBe("backtest");
  const run = state.background.mock.calls[0]![2];
  state.worker.mockResolvedValue({
    source: { ...source, id: "new-snapshot" },
    result: { engineVersion: "backtest-4" },
  });
  expect(await run({ id: "job-test" }, new AbortController().signal)).toEqual({
    engineVersion: "backtest-4",
  });
  expect(state.worker.mock.calls[0]![0]).toMatchObject({
    fullRoot: "fixture-root",
    initial: 100000,
    cashDividends: {
      start: input.start,
      end: input.end,
      plan: { taxBps: 2000, reconciliationHash: reconciliation.hash },
    },
  });
  expect(state.put).toHaveBeenCalledWith(
    "snapshot",
    "new-snapshot",
    expect.any(Object),
  );
  expect(state.records.get("s")).toEqual(source);
});
it("does not write a late worker result after cancellation", async () => {
  cashDividendJob(input);
  const controller = new AbortController();
  state.worker.mockImplementation(async () => {
    controller.abort(new Error("cancel"));
    return { source, result: {} };
  });
  await expect(
    state.background.mock.calls[0]![2]({ id: "job-test" }, controller.signal),
  ).rejects.toThrow("cancel");
  expect(state.put).not.toHaveBeenCalled();
});
it("rejects forged identities or archived payloads before queueing", () => {
  const r = state.records.get(id) as { reconciliation: typeof reconciliation };
  r.reconciliation.matchedCash = 999;
  expect(() => cashDividendJob(input)).toThrow("档案内容");
  expect(state.background).not.toHaveBeenCalled();
});
