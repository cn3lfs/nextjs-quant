import { expect, it, vi } from "vitest";
import { put } from "~/server/db";
import { AlertRepository } from "~/server/db/alert-repository";
import { alertsRouter } from "~/server/api/routers/alerts";
import { settingsSchema } from "~/lib/domain";
import type { StrategyObjectInput } from "trading-strategies";

it("prepares only a completed formula member with frozen raw evidence; repeated preparation is immutable and zero delivery", async () => {
  const network = vi.fn(() => {
    throw new Error("Unexpected external request");
  });
  vi.stubGlobal("fetch", network);
  try {
    put("settings", "settings", settingsSchema.parse({}));
    const strategy: StrategyObjectInput = {
      id: "workspace-formula-qa",
      version: 1,
      market: "cn-equity",
      period: "day",
      universe: { kind: "all-market" },
      entry: { kind: "constant", value: true },
      exit: {},
      sizing: { kind: "weight", weight: 1 },
      sleeve: "swing",
    };
    const price = {
      date: "2026-11-13",
      open: 10,
      high: 11,
      low: 9,
      close: 10,
      volume: 100,
      amount: 1000,
    };
    put("snapshot", "workspace-snapshot-qa", {
      id: "workspace-snapshot-qa",
      symbol: "sh600000",
      period: "day",
      adjustment: "forward",
      bars: [{ ...price, close: 5 }],
      rawBars: [price],
    });
    const job = {
      id: "workspace-job-qa",
      type: "screen",
      status: "completed",
      input: { type: "formula-screen", strategy },
      result: { candidates: [{ snapshotId: "workspace-snapshot-qa" }] },
    };
    put("job", job.id, job);
    const caller = alertsRouter.createCaller({ headers: new Headers() });
    await expect(
      caller.prepareScreenPlan({ jobId: job.id, snapshotId: "other-snapshot" }),
    ).rejects.toThrow("不属于");
    const first = await caller.prepareScreenPlan({
      jobId: job.id,
      snapshotId: "workspace-snapshot-qa",
    });
    expect(first).toMatchObject({
      symbol: "sh600000",
      price: 10,
      stop: null,
      target: null,
      qualification: "research",
      mode: "shadow",
      wouldSend: false,
    });
    expect(
      await caller.prepareScreenPlan({
        jobId: job.id,
        snapshotId: "workspace-snapshot-qa",
      }),
    ).toEqual(first);
    const repo = new AlertRepository();
    expect(repo.plans()).toEqual([]);
    expect(repo.subscriptions()).toEqual([]);
    expect(repo.records.all("delivery")).toEqual([]);
    expect(network).toHaveBeenCalledTimes(0);
    put("job", job.id, { ...job, status: "failed" });
    await expect(
      caller.prepareScreenPlan({
        jobId: job.id,
        snapshotId: "workspace-snapshot-qa",
      }),
    ).rejects.toThrow("不属于");
  } finally {
    vi.unstubAllGlobals();
  }
});
