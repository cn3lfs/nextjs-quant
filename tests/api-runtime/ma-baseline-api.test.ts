import { beforeEach, expect, it } from "vitest";
import { appRouter } from "~/server/api/root";
import { createTRPCContext } from "~/server/api/trpc";
import { get, put, sqlite } from "~/server/db";
import { maBaselineInputSchema, replayFiveMinute } from "quant-backtest";
import type { Bar } from "quant-backtest";
import type { MaBaselineArchive } from "~/server/backtest/ma-baseline-work";
import { defaultStrategy } from "~/lib/domain";

const input = maBaselineInputSchema.parse({
  symbol: "sh600519",
  start: "2026-10-12",
  end: "2026-10-12",
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
const bars: Bar[] = Array.from({ length: 40 }, (_, i) => {
  const m = 575 + (i % 20) * 5;
  return {
    date: `${i < 20 ? "2026-10-09" : "2026-10-12"}T${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00+08:00`,
    open: 10,
    high: 12,
    low: 9,
    close: i < 20 ? 10 : 11,
    volume: 100,
    amount: 1000,
  };
});
function archiveFixture(): MaBaselineArchive {
  const result = replayFiveMinute(input, bars);
  // Controlled repeated records exercise paging, not strategy performance.
  result.fills = Array.from({ length: 60 }, (_, i) => ({
    ...result.fills[0]!,
    orderId: i + 1,
  }));
  return {
    result,
    manifest: {
      version: "ma-baseline-input-1",
      symbol: input.symbol,
      period: "5m",
      adjustment: "none",
      executionAdjustment: "none",
      adjustmentReference: null,
      sourceFileHash: "source",
      dataHash: "frozen-window",
      calendarHash: "calendar",
      actionHash: "actions",
      start: bars[20]!.date,
      end: bars.at(-1)!.date,
      warmupBars: 20,
      sourceMs: 1,
      computeMs: 2,
    },
    inputSnapshot: {
      bars,
      calendar: [input.start],
      actions: {
        version: "backtest-actions-1",
        status: "partial",
        symbol: input.symbol,
        start: "2026-10-09",
        end: input.end,
        events: [],
        warnings: [],
      },
    },
  };
}
function save(status = "completed") {
  const archive = archiveFixture();
  put("job", "job-baseline-fixture", {
    id: "job-baseline-fixture",
    type: "backtest",
    status,
    progress: 100,
    createdAt: 1,
    updatedAt: 2,
    input: { type: "ma-baseline", input },
    result: archive,
  });
  return archive;
}
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
});

it("actual router removes old execution and exposes the current strategy catalog", async () => {
  const caller = appRouter.createCaller(
    await createTRPCContext({ headers: new Headers() }),
  );
  const catalog = await caller.strategyCenterCatalog();
  expect(catalog.map((v) => v.id)).toEqual(
    expect.arrayContaining(["ma", "research-breakout", "research-chan"]),
  );
  for (const name of ["backtest", "screen", "interpret"]) {
    const removed = caller as unknown as Record<
      string,
      (input: unknown) => Promise<unknown>
    >;
    await expect(
      removed[name]!({
        snapshotId: "missing",
        strategy: defaultStrategy,
        initial: 100000,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  }
  expect(
    sqlite()
      .prepare("SELECT count(*) AS n FROM records WHERE kind='job'")
      .get(),
  ).toEqual({ n: 0 });
});
it("pages fills server-side and exports the exact frozen input only on explicit request", async () => {
  const archive = save();
  const caller = appRouter.createCaller(
    await createTRPCContext({ headers: new Headers() }),
  );
  const first = await caller.maBaselineResult({
    id: "job-baseline-fixture",
    pageIndex: 0,
  });
  const second = await caller.maBaselineResult({
    id: "job-baseline-fixture",
    pageIndex: 1,
  });
  expect(first!.fills).toHaveLength(50);
  expect(first!.fills[0]!.orderId).toBe(1);
  expect(second!.fills).toHaveLength(10);
  expect(second!.fills[0]!.orderId).toBe(51);
  expect(Object.keys(first!)).not.toContain("inputSnapshot");
  expect(Object.keys(first!.summary)).not.toContain("orders");
  const exported = await caller.maBaselineExport("job-baseline-fixture");
  expect(exported).toMatchObject(archive);
  expect(exported.evaluation.version).toBe("performance-report-v2");
  expect(exported.evaluation.trades).toMatchObject({
    closedTrades: 0,
    openTrades: 1,
    winRate: { value: null },
  });
  expect(exported.evaluation.daily).toHaveLength(archive.result.equity.length);
  expect((await caller.maBaselineHistory())[0]).toMatchObject({
    id: "job-baseline-fixture",
    symbol: input.symbol,
    createdAt: 1,
  });
});
it("evaluates only the selected archive, bounds year/period selection and never writes its result", async () => {
  save();
  const before = get("job-baseline-fixture");
  const caller = appRouter.createCaller(
    await createTRPCContext({ headers: new Headers() }),
  );
  for (const frequency of ["year", "quarter", "month"] as const) {
    const result = await caller.maBaselineEvaluation({
      id: "job-baseline-fixture",
      frequency,
    });
    expect(result?.year).toBe(2026);
    expect(result?.months).toHaveLength(1);
    expect(result?.periods).toHaveLength(1);
    expect(result?.overview.days).toBe(1);
    expect(result?.trades).toMatchObject({ closedTrades: 0, openTrades: 1 });
    const selected = await caller.maBaselineEvaluation({
      id: "job-baseline-fixture",
      frequency,
      period: result!.periods[0]!.key,
    });
    expect(selected?.selected?.key).toBe(result!.periods[0]!.key);
    expect(JSON.stringify(result)).not.toContain('"bars"');
  }
  await expect(
    caller.maBaselineEvaluation({ id: "job-baseline-fixture", year: 2020 }),
  ).rejects.toThrow("年份");
  await expect(
    caller.maBaselineEvaluation({
      id: "job-baseline-fixture",
      period: "2026-01",
    }),
  ).rejects.toThrow("期间");
  await expect(caller.maBaselineEvaluation({ id: "missing" })).rejects.toThrow(
    "不存在",
  );
  expect(get("job-baseline-fixture")).toEqual(before);
  save("running");
  expect(
    await caller.maBaselineEvaluation({ id: "job-baseline-fixture" }),
  ).toBeNull();
});

it("returns the same paired trade metrics through evaluation and export without modifying the archive", async () => {
  save();
  const record = get<{ result: MaBaselineArchive }>("job-baseline-fixture")!;
  const archive = record.result;
  const original = archive.result.fills[0]!;
  // Controlled read-only evaluation evidence; not an executable A-share path.
  archive.result.fills = [
    { ...original, side: "buy", price: 10, shares: 100, fee: 1 },
    { ...original, side: "sell", price: 12, shares: 100, fee: 1 },
    { ...original, side: "buy", price: 10, shares: 100, fee: 1 },
    { ...original, side: "sell", price: 9, shares: 100, fee: 1 },
    { ...original, side: "buy", price: 10, shares: 100, fee: 1 },
  ];
  put("job", "job-baseline-fixture", { ...record, result: archive });
  const before = get("job-baseline-fixture");
  const caller = appRouter.createCaller(
    await createTRPCContext({ headers: new Headers() }),
  );
  const queried = await caller.maBaselineEvaluation({
    id: "job-baseline-fixture",
  });
  const exported = await caller.maBaselineExport("job-baseline-fixture");
  expect(queried!.trades).toEqual(exported.evaluation.trades);
  expect(queried!.trades).toMatchObject({
    closedTrades: 2,
    openTrades: 1,
    averageWin: { value: 198 },
    averageLoss: { value: 102 },
    winRate: { value: 0.5 },
    expectancy: { value: 48 },
  });
  expect(get("job-baseline-fixture")).toEqual(before);
});
it("deletion refuses active/foreign work and retains the research audit fact", async () => {
  const caller = appRouter.createCaller(
    await createTRPCContext({ headers: new Headers() }),
  );
  save("running");
  await expect(caller.maBaselineRemove("job-baseline-fixture")).rejects.toThrow(
    "先取消",
  );
  put("job", "foreign", {
    id: "foreign",
    status: "completed",
    input: { type: "backtest" },
  });
  await expect(caller.maBaselineRemove("foreign")).rejects.toThrow("不存在");
  save();
  put("research-attempt", "audit-fixture", { taskId: "job-baseline-fixture" });
  expect(await caller.maBaselineRemove("job-baseline-fixture")).toEqual({
    removed: true,
  });
  expect(get("job-baseline-fixture")).toBeUndefined();
  expect(get("audit-fixture")).toEqual({ taskId: "job-baseline-fixture" });
});
it("does not silently intersect mismatched frozen dates or fabricate absent historical comparisons", async () => {
  const archive = save();
  const caller = appRouter.createCaller(
    await createTRPCContext({ headers: new Headers() }),
  );
  archive.result.equity[0]!.date = "2026-10-13";
  put("job", "job-baseline-fixture", {
    ...get<Record<string, unknown>>("job-baseline-fixture"),
    result: archive,
  });
  await expect(
    caller.maBaselineEvaluation({ id: "job-baseline-fixture" }),
  ).rejects.toThrow("日期不一致");
  const legacy = save();
  legacy.inputSnapshot.bars = [];
  put("job", "job-baseline-fixture", {
    ...get<Record<string, unknown>>("job-baseline-fixture"),
    result: legacy,
  });
  const evaluation = await caller.maBaselineEvaluation({
    id: "job-baseline-fixture",
  });
  expect(evaluation?.overview.benchmarkReturn).toMatchObject({
    value: null,
    reason: "缺少完整同窗持有对照",
  });
  expect(evaluation?.overview.totalReturn.value).not.toBeNull();
});

it("filters orders before server pagination, preserves reasons and refuses foreign or unfinished results", async () => {
  const archive = save();
  archive.result.orders = Array.from({ length: 125 }, (_, i) => ({
    id: i + 1,
    side: "buy",
    signalAt: bars[20]!.date,
    status: i < 60 ? "rejected" : i < 120 ? "filled" : "pending",
    attempts: i < 120 ? 1 : 0,
    reason: i < 60 ? "资金不足以支付一手及费用" : null,
  }));
  put("job", "job-baseline-fixture", {
    id: "job-baseline-fixture",
    type: "backtest",
    status: "completed",
    input: { type: "ma-baseline", input },
    result: archive,
  });
  const caller = appRouter.createCaller(
    await createTRPCContext({ headers: new Headers() }),
  );
  const first = await caller.maBaselineOrders({
    id: "job-baseline-fixture",
    status: "rejected",
  });
  const second = await caller.maBaselineOrders({
    id: "job-baseline-fixture",
    status: "rejected",
    pageIndex: 1,
  });
  expect(first!.rowCount).toBe(60);
  expect(first!.orders).toHaveLength(50);
  expect(first!.orders[0]).toMatchObject({
    id: 1,
    status: "rejected",
    reason: "资金不足以支付一手及费用",
  });
  expect(second!.orders.map((order) => order.id)).toEqual(
    Array.from({ length: 10 }, (_, i) => i + 51),
  );
  const pending = await caller.maBaselineOrders({
    id: "job-baseline-fixture",
    status: "pending",
  });
  expect(pending!.rowCount).toBe(5);
  expect(pending!.orders[0]!.id).toBe(121);
  const filled = await caller.maBaselineOrders({
    id: "job-baseline-fixture",
    status: "filled",
  });
  expect(filled!.orders[0]!.id).toBe(61);
  expect(Object.keys(first!)).toEqual(["orders", "rowCount"]);
  await expect(caller.maBaselineOrders({ id: "foreign" })).rejects.toThrow(
    "不存在",
  );
  await expect(
    caller.maBaselineOrders({ id: "job-baseline-fixture", pageIndex: -1 }),
  ).rejects.toThrow();
  await expect(
    caller.maBaselineOrders({
      id: "job-baseline-fixture",
      status: "invalid" as "all",
    }),
  ).rejects.toThrow();
  for (const status of ["queued", "running", "failed", "cancelled"]) {
    save(status);
    expect(
      await caller.maBaselineOrders({ id: "job-baseline-fixture" }),
    ).toBeNull();
  }
});
