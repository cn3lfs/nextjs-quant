import { expect, it, vi, afterEach } from "vitest";
import {
  checkIncrementCoverage,
  runCloseIncrementWorkflow,
} from "../src/server/close-increment-workflow";
import * as observations from "../src/server/rps-observation";
import * as increments from "../src/server/tdx-increment-job";
import * as tdx from "../src/server/tdx";
import { settings } from "../src/server/settings";
afterEach(() => vi.restoreAllMocks());

it("reuses a published close before reading securities or downloading again", async () => {
  const existing = { id: "immutable-close" } as observations.RpsObservation;
  const lookup = vi
    .spyOn(observations, "completedRpsObservation")
    .mockReturnValue(existing);
  const download = vi.spyOn(increments, "runIncrementJob");
  const names = vi.spyOn(tdx, "securityNames");
  expect(
    await runCloseIncrementWorkflow(Date.parse("2026-09-11T08:00:00Z")),
  ).toEqual({
    status: "complete",
    observationId: existing.id,
    reused: true,
  });
  expect(lookup).toHaveBeenCalledWith(
    settings().tdxRoot,
    "2026-09-11",
    "close",
  );
  expect(download).not.toHaveBeenCalled();
  expect(names).not.toHaveBeenCalled();
});
import type { IncrementJob } from "../src/server/tdx-increment-job";
import type { DailyIncrementSnapshot } from "../src/server/tdx-daily-cache";
const symbols = Array.from({ length: 10 }, (_, i) => `sh${600000 + i}`);
const job: IncrementJob = {
  id: "job",
  date: "2026-09-11",
  symbols: [...symbols, "sh000001"],
  status: "partial",
  attempts: 1,
  updatedAt: 1,
  nextAttemptAt: 2,
  snapshotIds: ["snapshot"],
  coverage: { available: 10000, unavailable: [] },
};
function snapshot(stocks: string[], reference = true): DailyIncrementSnapshot {
  return {
    id: "snapshot",
    market: "sh",
    date: job.date,
    hash: "hash",
    source: "vendor",
    adjustment: "none",
    observedAt: 1,
    unavailable: [],
    records: [...stocks, ...(reference ? ["sh000001"] : [])].map((symbol) => ({
      symbol,
      volumeUnit: "tdx-raw",
      bar: {
        date: job.date,
        open: 10,
        high: 10,
        low: 10,
        close: 10,
        volume: 100,
        amount: 1000,
      },
    })),
  };
}
it("requires exact universe, a dated reference index and 90 percent actual stock records", () => {
  expect(
    checkIncrementCoverage(job, symbols, () => snapshot(symbols.slice(0, 9)))
      .ready,
  ).toBe(true);
  expect(
    checkIncrementCoverage(job, symbols, () => snapshot(symbols.slice(0, 8)))
      .ready,
  ).toBe(false);
  expect(
    checkIncrementCoverage(job, symbols, () => snapshot(symbols, false)).ready,
  ).toBe(false);
  expect(
    checkIncrementCoverage(
      { ...job, symbols: symbols.slice(0, 5) },
      symbols,
      () => snapshot(symbols),
    ).ready,
  ).toBe(false);
  expect(
    checkIncrementCoverage(
      { ...job, status: "waiting-publication" },
      symbols,
      () => snapshot(symbols),
    ).ready,
  ).toBe(false);
});
it("rejects missing or wrong-date immutable evidence", () => {
  expect(() => checkIncrementCoverage(job, symbols, () => undefined)).toThrow(
    "证据缺失",
  );
  expect(() =>
    checkIncrementCoverage(job, symbols, () => ({
      ...snapshot(symbols),
      date: "2026-09-10",
    })),
  ).toThrow("日期不一致");
});
