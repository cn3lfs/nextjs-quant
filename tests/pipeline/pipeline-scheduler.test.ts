import { planningAccount } from "~/server/pipeline/account-coordinator";
import { upsertSleeveHolding } from "~/server/db/sleeve-holding-repository";
import octoberCalendar from "../fixtures/gf-calendar-202610.json";
import { cnTradingCalendar } from "~/server/pipeline/cn-trading-calendar";
import * as gfCalendar from "~/server/data-sources/gf/gf-calendar";
import Database from "better-sqlite3";
import type { Bar } from "trading-strategy-core/bars";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createDeployment,
  getDeployment,
  setGlobalAutoLiveEnabled,
  setGlobalAutoSimEnabled,
  updateDeploymentConfig,
  type CreateDeploymentInput,
} from "~/server/db/deployment-repository";
import { migrate } from "~/server/db/migrations";
import {
  appendExecutionAuditEvent,
  findPipelineRun,
  getOrCreatePipelineRun,
  insertOrderIntents,
  listExecutionAuditEvents,
  listIntentsByRun,
  listPipelineRuns,
  transitionIntentStatus,
} from "~/server/db/pipeline-repository";
import { getActivePoolEntries } from "~/server/db/pool-repository";
import {
  resolveVenueAdapter,
  type ExecutionVenueAdapter,
} from "~/server/execution/venue-router";
import {
  computeCryptoRunSlot,
  tickPipelineScheduler,
  type PipelineSchedulerDeps,
} from "~/server/pipeline/pipeline-scheduler";
import { runPipelinePlanning } from "~/server/pipeline/signal-risk-runner";
import {
  createSimAccount,
  getSimAccountDetail,
} from "~/server/portfolio/sim-accounts/service";
import { listAccountSleeveHoldings } from "~/server/db/sleeve-holding-repository";

const decisionDay = "2024-04-19";
const executeDay = "2024-04-22";
const followingDay = "2024-04-23";
const buyStock = "sh600001";
const heldStock = "sh600002";
const bitcoin = "BTCUSDT";
const broker = {
  kind: "cn_broker_live",
  broker: "http_bridge",
  accountId: "test",
  endpointUrl: "https://broker.example.invalid/bridge",
} as const;
const cryptoLive = {
  kind: "crypto_live",
  venue: "binance",
  accountId: "test",
} as const;
const dayMs = 86_400_000;
const closeTick = Date.parse(`${decisionDay}T15:35:00+08:00`);
const openTick = Date.parse(`${executeDay}T09:35:00+08:00`);
const account = {
  cash: 100_000,
  equity: 100_000,
  drawdownPct: 0,
  positions: [],
};

let db: Database.Database;
let deploymentCount: number;
const fetchAttempt = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.spyOn(gfCalendar, "gfCalendarReference").mockRejectedValue(
    new Error("offline"),
  );
  fetchAttempt.mockReset().mockRejectedValue(new Error("离线测试禁止联网"));
  vi.stubGlobal("fetch", fetchAttempt);
  db = new Database(":memory:");
  deploymentCount = 0;
  migrate(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  vi.unstubAllGlobals();
  expect(fetchAttempt).not.toHaveBeenCalled();
});

function bar(date: string, close: number, volume = 100): Bar {
  return {
    date,
    close,
    open: close,
    high: close + 1,
    low: close - 1,
    volume,
    amount: close * volume,
  };
}

function stockHistory(date: string, close: number) {
  const end = Date.parse(date);
  const history = Array.from({ length: 60 }, (_, i) =>
    bar(new Date(end - (60 - i) * dayMs).toISOString().slice(0, 10), 10),
  );
  return [...history, bar(date, close, 800)];
}

function createStock(overrides: Partial<CreateDeploymentInput> = {}) {
  const dep = createDeployment(
    {
      name: `收盘突破 ${++deploymentCount}`,
      market: "cn-equity",
      status: "active",
      executionMode: "auto_sim",
      strategySpec: { kind: "study-rule", strategyId: "breakout" },
      universeSpec: { kind: "fixed-symbols", symbols: [buyStock] },
      regimeGate: { kind: "none", unlockAvoidanceDays: 0 },
      riskPolicy: {},
      venueBinding: { kind: "ths_mock", accountTag: "default" },
      schedule: { kind: "post_close_auto" },
      provenance: { sourceKind: "manual" },
      ...overrides,
    },
    db,
  );
  if (
    dep.status === "active" &&
    dep.market === "cn-equity" &&
    dep.schedule.kind !== "manual_only"
  ) {
    upsertSleeveHolding(
      {
        ...planningAccount(dep.venueBinding),
        ownerKind: "deployment",
        ownerId: dep.id,
        symbol: heldStock,
        quantity: 500,
        entryDate: "2024-04-16",
        avgEntryPrice: 10,
        updatedAt: Date.parse("2024-04-16T15:00:00+08:00"),
      },
      db,
    );
  }
  return dep;
}

function createCrypto(overrides: Partial<CreateDeploymentInput> = {}) {
  return createStock({
    name: "加密双均线",
    market: "crypto",
    strategySpec: { kind: "crypto-dual-ma", fast: 2, slow: 3, period: "15m" },
    universeSpec: { kind: "fixed-symbols", symbols: [bitcoin] },
    venueBinding: { kind: "crypto_sim", venue: "binance", accountId: "test" },
    schedule: { kind: "crypto_interval", intervalMinutes: 15 },
    ...overrides,
  });
}

function stockDeps() {
  const tradingDays = [decisionDay, executeDay, followingDay];
  return {
    readQuote: (symbol: string, tradeDate: string) => ({
      symbol,
      tradeDate,
      openPrice: null,
      lastPrice: symbol === buyStock ? 15 : 6,
      prevClose: 10,
      upperLimit: 20,
      lowerLimit: 4,
      suspended: false,
    }),
    isTradingDay: vi.fn((date: string) => tradingDays.includes(date)),
    nextTradingDay: vi.fn(
      (date: string) => tradingDays.find((day) => day > date) ?? null,
    ),
    isPostCloseDataReady: vi.fn(() => true),
    universe: {
      readBars: (symbol, date) =>
        stockHistory(date, symbol === buyStock ? 15 : 6),
    },
    readAccountState: vi.fn(() => ({
      ...account,
      positions: [
        { symbol: heldStock, quantity: 500, sellable: 500, lastPrice: 6 },
      ],
    })),
  } satisfies PipelineSchedulerDeps;
}

function filled(quantity: number, price: number) {
  return {
    status: "filled" as const,
    venueOrderId: "offline-order",
    filledQuantity: quantity,
    averageFillPrice: price,
  };
}

function offlineVenue(kind: "ths_mock" | "crypto_sim") {
  return {
    kind,
    isLive: false,
    readAccountState: vi
      .fn<ExecutionVenueAdapter["readAccountState"]>()
      .mockResolvedValue(account),
    submitOrder: vi.fn<ExecutionVenueAdapter["submitOrder"]>(
      async (intent, context) => filled(intent.quantity, context.executePrice),
    ),
    reconcileOrder: vi.fn<ExecutionVenueAdapter["reconcileOrder"]>(
      async (intent) => filled(intent.quantity, intent.referencePrice),
    ),
    cancelOrder: vi.fn<ExecutionVenueAdapter["cancelOrder"]>(),
  } satisfies ExecutionVenueAdapter;
}

it("按 UTC 日期对齐槽位，午夜归入新日期", () => {
  expect(
    computeCryptoRunSlot(Date.parse(`${decisionDay}T17:14:59+08:00`), 15),
  ).toEqual({
    decisionDate: decisionDay,
    runSlot: "09:00",
  });
  expect(
    computeCryptoRunSlot(Date.parse(`${executeDay}T00:00:00Z`), 15),
  ).toEqual({
    decisionDate: executeDay,
    runSlot: "00:00",
  });
});

it("15:35 数据就绪后更新监控池并为池内股票和池外持仓生成下一交易日意图，每日只规划一次", async () => {
  const { id } = createStock();
  const deps = stockDeps();
  deps.isPostCloseDataReady.mockReturnValueOnce(false);
  expect(
    await tickPipelineScheduler({ now: closeTick, deps }, db),
  ).toMatchObject({ plannedRuns: 0 });
  expect(findPipelineRun(id, decisionDay, "daily", db)).toBeNull();
  expect(getActivePoolEntries(id, db)).toEqual([]);
  expect(deps.readAccountState).not.toHaveBeenCalled();

  expect(
    await tickPipelineScheduler({ now: closeTick, deps }, db),
  ).toMatchObject({ plannedRuns: 1, failures: [] });
  const run = findPipelineRun(id, decisionDay, "daily", db)!;
  expect(run).toMatchObject({
    executeDate: executeDay,
    triggerKind: "scheduled",
    stage: "risk_checked",
    signals: {
      signals: expect.arrayContaining([
        expect.objectContaining({ symbol: buyStock, action: "BUY" }),
        expect.objectContaining({ symbol: heldStock, action: "SELL" }),
      ]),
    },
  });
  expect(getActivePoolEntries(id, db)).toMatchObject([
    { symbol: buyStock, lastCheckedDate: decisionDay },
  ]);
  const intents = listIntentsByRun(run.id, db);
  expect(intents).toMatchObject([
    {
      executeDate: executeDay,
      symbol: heldStock,
      side: "SELL",
      status: "planned",
    },
    {
      executeDate: executeDay,
      symbol: buyStock,
      side: "BUY",
      status: "planned",
    },
  ]);
  expect(
    await tickPipelineScheduler({ now: closeTick + 60_000, deps }, db),
  ).toMatchObject({ plannedRuns: 0 });
  expect(
    listPipelineRuns({ deploymentId: id }, db).items.map(({ id }) => id),
  ).toEqual([run.id]);
  expect(listIntentsByRun(run.id, db)).toEqual(intents);
  expect(deps.readAccountState).toHaveBeenCalledTimes(1);
  expect(deps.isPostCloseDataReady).toHaveBeenLastCalledWith(
    decisionDay,
    closeTick,
  );
});

it("默认读取隔离库中的本地交易日历，跳过休市日并使用已确认的下一交易日", async () => {
  const { id } = createStock();
  db.prepare(
    "INSERT INTO records (id, kind, payload, updated_at) VALUES ('settings', 'settings', ?, ?)",
  ).run(JSON.stringify({ calendar: [followingDay, decisionDay] }), closeTick);
  const { universe, readAccountState, isPostCloseDataReady } = stockDeps();
  const deps = { universe, readAccountState, isPostCloseDataReady };
  const closedDay = Date.parse(`${executeDay}T15:35:00+08:00`);
  expect(
    await tickPipelineScheduler({ now: closedDay, deps }, db),
  ).toMatchObject({ plannedRuns: 0, failures: [] });
  expect(isPostCloseDataReady).not.toHaveBeenCalled();
  expect(
    await tickPipelineScheduler({ now: closeTick, deps }, db),
  ).toMatchObject({ plannedRuns: 1, failures: [] });
  expect(findPipelineRun(id, decisionDay, "daily", db)).toMatchObject({
    executeDate: followingDay,
  });
});

it.each([[], [decisionDay]].map((calendar) => ({ calendar })))(
  "默认日历没有未来交易日时，周五收盘为周一生成执行意图 ($calendar)",
  async ({ calendar }) => {
    const { id } = createStock();
    db.prepare(
      "INSERT INTO records (id, kind, payload, updated_at) VALUES ('settings', 'settings', ?, ?)",
    ).run(
      JSON.stringify({ calendar, tdxRoot: process.env.QUANT_DATA_DIR }),
      closeTick,
    );
    const { universe, readAccountState, isPostCloseDataReady } = stockDeps();
    expect(
      await tickPipelineScheduler(
        {
          now: closeTick,
          deps: { universe, readAccountState, isPostCloseDataReady },
        },
        db,
      ),
    ).toMatchObject({ plannedRuns: 1, failures: [] });
    const run = findPipelineRun(id, decisionDay, "daily", db)!;
    expect(
      listExecutionAuditEvents({ deploymentId: id, runId: run.id }, db).items,
    ).toContainEqual(
      expect.objectContaining({
        eventType: "execution_calendar_fallback",
        details: expect.objectContaining({
          warning: expect.stringContaining("待确认"),
        }),
      }),
    );
    expect(run).toMatchObject({
      executeDate: executeDay,
      stage: "risk_checked",
    });
    expect(listIntentsByRun(run.id, db)).toMatchObject([
      { executeDate: executeDay, status: "planned" },
      { executeDate: executeDay, status: "planned" },
    ]);
  },
);

it.each(["pending", "universe_done", "signals_done", "failed"] as const)(
  "A 股收盘同日续跑 %s，复用运行和已保存的快照",
  async (stage) => {
    const { id } = createStock();
    const deps = stockDeps();
    const input = {
      deploymentId: id,
      decisionDate: decisionDay,
      executeDate: executeDay,
      triggerKind: "manual" as const,
    };
    if (stage === "failed") {
      deps.readAccountState.mockImplementationOnce(() => {
        throw new Error("账户快照暂不可用");
      });
      expect(
        await tickPipelineScheduler({ now: closeTick, deps }, db),
      ).toMatchObject({
        failures: [{ deploymentId: id, message: "账户快照暂不可用" }],
      });
    } else if (stage === "pending") {
      getOrCreatePipelineRun(input, db);
    } else {
      await runPipelinePlanning(
        {
          ...input,
          stopAfterStage: stage === "universe_done" ? "universe" : "signals",
          deps,
        },
        db,
      );
    }
    const existing = findPipelineRun(id, decisionDay, "daily", db)!;
    expect(existing.stage).toBe(stage);

    expect(
      await tickPipelineScheduler({ now: closeTick + 60_000, deps }, db),
    ).toMatchObject({ plannedRuns: 1, failures: [] });
    const run = findPipelineRun(id, decisionDay, "daily", db)!;
    expect(run).toMatchObject({
      id: existing.id,
      stage: "risk_checked",
      errorSummary: null,
    });
    if (existing.universeSnapshot)
      expect(run.universeSnapshot).toEqual(existing.universeSnapshot);
    if (existing.signals) expect(run.signals).toEqual(existing.signals);
    expect(listIntentsByRun(run.id, db)).toHaveLength(2);
  },
);

it("A 股 15:05 仍对账直至卖单终态，待买单保持排队", async () => {
  const { id } = createStock();
  const venue = offlineVenue("ths_mock");
  const deps = { ...stockDeps(), thsAdapter: venue };
  setGlobalAutoSimEnabled(true, db);
  await tickPipelineScheduler({ now: closeTick, deps }, db);
  const run = findPipelineRun(id, decisionDay, "daily", db)!;
  const [sell, buy] = listIntentsByRun(run.id, db);
  transitionIntentStatus(sell!.id, "submitting", {}, db);
  transitionIntentStatus(
    sell!.id,
    "submitted",
    { venueOrderId: "offline-order" },
    db,
  );
  transitionIntentStatus(buy!.id, "queued", {}, db);

  const late = Date.parse(`${executeDay}T15:05:00+08:00`);
  expect(await tickPipelineScheduler({ now: late, deps }, db)).toMatchObject({
    executedRuns: 0,
    reconciledIntents: 1,
  });
  expect(listIntentsByRun(run.id, db).map((i) => i.status)).toEqual([
    "filled",
    "queued",
  ]);
  expect(venue.submitOrder).not.toHaveBeenCalled();
  expect(
    await tickPipelineScheduler({ now: late + 60000, deps }, db),
  ).toMatchObject({ executedRuns: 0, reconciledIntents: 0 });
  expect(venue.reconcileOrder).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: sell!.id }),
    { db },
  );
});

it.each([
  "submitting",
  "submitted",
  "partial_filled",
  "unknown_reconcile",
] as const)("A 股下一交易日自动对账上个交易日的 %s 委托", async (status) => {
  const { id } = createStock();
  const thsAdapter = offlineVenue("ths_mock");
  const deps = { ...stockDeps(), thsAdapter };
  setGlobalAutoSimEnabled(true, db);
  await tickPipelineScheduler({ now: closeTick, deps }, db);
  const run = findPipelineRun(id, decisionDay, "daily", db)!;
  const [sell, buy] = listIntentsByRun(run.id, db);
  const clock = vi.spyOn(Date, "now").mockReturnValue(openTick);
  try {
    transitionIntentStatus(sell!.id, "submitting", {}, db);
    if (status !== "submitting")
      transitionIntentStatus(
        sell!.id,
        status,
        {
          venueOrderId: "offline-order",
          ...(status === "partial_filled"
            ? { filledQuantity: 100, averageFillPrice: 6 }
            : {}),
        },
        db,
      );
  } finally {
    clock.mockRestore();
  }
  const now = Date.parse(`${followingDay}T09:35:00+08:00`);
  expect(await tickPipelineScheduler({ now, deps }, db)).toMatchObject({
    executedRuns: 0,
    reconciledIntents: 1,
    expiredIntents: 1,
    failures: [],
  });
  expect(thsAdapter.reconcileOrder).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: sell!.id, executeDate: executeDay, status }),
    { db },
  );
  expect(listIntentsByRun(run.id, db)).toMatchObject([
    { id: sell!.id, status: "filled" },
    { id: buy!.id, status: "rejected", errorSummary: "execute-date-expired" },
  ]);
  expect(findPipelineRun(id, decisionDay, "daily", db)?.stage).toBe("partial");
  expect(thsAdapter.submitOrder).not.toHaveBeenCalled();
});

it("所有新 A 股开盘意图先于耗尽开盘窗口的历史对账和加密规划", async () => {
  const historical = createStock({ id: "a-history" });
  const thsAdapter = offlineVenue("ths_mock");
  const cryptoSimAdapter = offlineVenue("crypto_sim");
  const base = stockDeps();
  setGlobalAutoSimEnabled(true, db);
  await tickPipelineScheduler({ now: closeTick, deps: base }, db);
  const oldRun = findPipelineRun(historical.id, decisionDay, "daily", db)!;
  const [historicalSell] = listIntentsByRun(oldRun.id, db);
  updateDeploymentConfig(
    historical.id,
    { schedule: { kind: "manual_only" } },
    db,
  );

  const fresh = ["z-fresh", "m-fresh"].map((id) => {
    const sim = createSimAccount(
      { name: id, market: "cn-equity", initialCapital: "100000" },
      db,
    );
    return createStock({
      id,
      venueBinding: { kind: "local_sim", simAccountId: sim.id },
    });
  });
  const planningOrder: string[] = [];
  const secondClose = Date.parse(`${executeDay}T15:35:00+08:00`);
  await tickPipelineScheduler(
    {
      now: secondClose,
      deps: {
        ...base,
        readAccountState: (binding) => {
          if (binding.kind === "local_sim")
            planningOrder.push(
              fresh.find(
                (dep) =>
                  dep.venueBinding.kind === "local_sim" &&
                  dep.venueBinding.simAccountId === binding.simAccountId,
              )!.id,
            );
          return account;
        },
      },
    },
    db,
  );
  expect(planningOrder).toEqual(["m-fresh", "z-fresh"]);
  transitionIntentStatus(historicalSell!.id, "submitting", {}, db);
  transitionIntentStatus(
    historicalSell!.id,
    "submitted",
    { venueOrderId: "old-id" },
    db,
  );
  createCrypto({ id: "b-crypto" });

  let now = Date.parse(`${followingDay}T09:35:00+08:00`);
  const events: string[] = [];
  const stagesAtReconciliation: string[] = [];
  thsAdapter.reconcileOrder.mockImplementation(async (intent) => {
    events.push("historical-reconciliation");
    for (const dep of fresh)
      stagesAtReconciliation.push(
        findPipelineRun(dep.id, executeDay, "daily", db)!.stage,
      );
    await Promise.resolve();
    now = Date.parse(`${followingDay}T14:56:00+08:00`);
    return filled(intent.quantity, intent.referencePrice);
  });
  const readCryptoBars = vi.fn(async () => {
    if (!events.includes("crypto-planning")) events.push("crypto-planning");
    await Promise.resolve();
    return [];
  });
  const { readAccountState: _readAccountState, ...executionDeps } = base;
  const deps = {
    ...executionDeps,
    now: () => now,
    thsAdapter,
    cryptoSimAdapter,
    strategy: { readBars: readCryptoBars },
  };
  expect(await tickPipelineScheduler({ deps }, db)).toMatchObject({
    executedRuns: 2,
    reconciledIntents: 1,
    plannedRuns: 1,
    failures: [],
  });
  expect(events).toEqual(["historical-reconciliation", "crypto-planning"]);
  expect(readCryptoBars).toHaveBeenCalled();
  expect(stagesAtReconciliation).toEqual(["completed", "completed"]);
  for (const dep of fresh) {
    const run = findPipelineRun(dep.id, executeDay, "daily", db)!;
    expect(listIntentsByRun(run.id, db)).toMatchObject([{ status: "filled" }]);
  }
});

it("盘前历史对账一直挂起时，下一次分钟调度仍在开盘窗内提交新意图且不重复对账", async () => {
  const dep = createStock();
  const thsAdapter = offlineVenue("ths_mock");
  const deps = { ...stockDeps(), thsAdapter };
  setGlobalAutoSimEnabled(true, db);
  await tickPipelineScheduler({ now: closeTick, deps }, db);
  const old = getOrCreatePipelineRun(
    {
      deploymentId: dep.id,
      decisionDate: "2024-04-18",
      executeDate: decisionDay,
      triggerKind: "manual",
      runSlot: "daily",
    },
    db,
  ).run;
  const [previous] = insertOrderIntents(
    old.id,
    [
      {
        runId: old.id,
        deploymentId: dep.id,
        symbol: "sh600009",
        side: "BUY",
        phase: 2,
        quantity: 100,
        referencePrice: 10,
        venueKind: "ths_mock",
      },
    ],
    db,
  );
  transitionIntentStatus(previous!.id, "submitting", {}, db);
  transitionIntentStatus(
    previous!.id,
    "submitted",
    { venueOrderId: "old" },
    db,
  );
  let resume!: () => void;
  const waiting = new Promise<void>((resolve) => {
    resume = resolve;
  });
  thsAdapter.reconcileOrder.mockImplementation(async () => {
    await waiting;
    return {
      status: "cancelled",
      venueOrderId: "old",
      filledQuantity: 0,
      averageFillPrice: null,
    };
  });
  try {
    const preOpen = Date.parse(executeDay + "T09:29:00+08:00");
    expect(
      await tickPipelineScheduler({ now: preOpen, deps }, db),
    ).toMatchObject({ executedRuns: 0 });
    expect(thsAdapter.reconcileOrder).toHaveBeenCalledTimes(1);
    expect(
      await tickPipelineScheduler({ now: openTick, deps }, db),
    ).toMatchObject({ executedRuns: 1 });
    expect(thsAdapter.submitOrder).toHaveBeenCalledTimes(2);
    expect(thsAdapter.reconcileOrder).toHaveBeenCalledTimes(1);
  } finally {
    resume();
    await vi.waitFor(() =>
      expect(listIntentsByRun(old.id, db)[0]?.status).toBe("cancelled"),
    );
  }
});

it("本地模拟执行采用共享日历已确认开市的日期，只由部署执行链标注成交归属", async () => {
  const sim = createSimAccount(
    { name: "隔离模拟", market: "cn-equity", initialCapital: "100000" },
    db,
  );
  const { id } = createStock({
    venueBinding: { kind: "local_sim", simAccountId: sim.id },
  });
  db.prepare(
    "INSERT INTO records(id,kind,payload,updated_at) VALUES('settings','settings',?,?)",
  ).run(JSON.stringify({ calendar: [decisionDay] }), closeTick);
  vi.mocked(gfCalendar.gfCalendarReference).mockResolvedValue({
    days: [decisionDay, executeDay],
    closedDays: [],
    source: "fixture",
    hash: null,
  });
  const { universe, readQuote, isPostCloseDataReady } = stockDeps();
  const deps = {
    universe,
    readQuote,
    isPostCloseDataReady,
    readAccountState: () => account,
  };
  setGlobalAutoSimEnabled(true, db);
  expect(
    await tickPipelineScheduler({ now: closeTick, deps }, db),
  ).toMatchObject({ plannedRuns: 1, failures: [] });
  const run = findPipelineRun(id, decisionDay, "daily", db)!;
  expect(
    await tickPipelineScheduler({ now: openTick, deps }, db),
  ).toMatchObject({ executedRuns: 1, failures: [] });
  expect(
    await tickPipelineScheduler({ now: openTick, deps }, db),
  ).toMatchObject({ executedRuns: 0 });
  const [intent] = listIntentsByRun(run.id, db);
  expect(intent).toMatchObject({
    status: "filled",
    executeDate: executeDay,
    side: "BUY",
  });
  expect(
    getSimAccountDetail({ accountId: sim.id, currentTradeDate: executeDay }, db)
      .trades,
  ).toHaveLength(1);
  expect(
    listAccountSleeveHoldings(
      { accountScope: "local_sim", accountId: sim.id },
      db,
    ).filter(({ symbol }) => symbol === buyStock),
  ).toMatchObject([
    { ownerKind: "deployment", ownerId: id, quantity: intent!.quantity },
  ]);
});

it.each(["holiday", "next-opening"] as const)(
  "暂定休市日顺延一次，按确认日提交 (%s)",
  async (wake) => {
    const { id } = createStock();
    const thsAdapter = offlineVenue("ths_mock");
    const sessions = new Map<string, boolean>([[decisionDay, true]]);
    const deps = {
      ...stockDeps(),
      nextTradingDay: undefined,
      isTradingDay: (date: string) => sessions.get(date) ?? null,
      thsAdapter,
    };
    setGlobalAutoSimEnabled(true, db);
    await tickPipelineScheduler({ now: closeTick, deps }, db);
    const run = findPipelineRun(id, decisionDay, "daily", db)!;
    const original = listIntentsByRun(run.id, db);
    expect(run.executeDate).toBe(executeDay);
    expect(original).toHaveLength(2);

    if (wake === "holiday") {
      expect(
        await tickPipelineScheduler({ now: openTick, deps }, db),
      ).toMatchObject({
        rolledOverRuns: 0,
        executedRuns: 0,
        expiredIntents: 0,
      });
      sessions.set(executeDay, false);
      expect(
        await tickPipelineScheduler({ now: openTick, deps }, db),
      ).toMatchObject({
        rolledOverRuns: 0,
        executedRuns: 0,
        expiredIntents: 0,
      });
      expect(listIntentsByRun(run.id, db)).toEqual(original);
      expect(thsAdapter.submitOrder).not.toHaveBeenCalled();
    }

    sessions.set(executeDay, false);
    sessions.set(followingDay, true);
    const opening = Date.parse(`${followingDay}T09:35:00+08:00`);
    expect(
      await tickPipelineScheduler(
        { now: wake === "holiday" ? openTick : opening, deps },
        db,
      ),
    ).toMatchObject({
      rolledOverRuns: 1,
      executedRuns: wake === "holiday" ? 0 : 1,
      expiredIntents: 0,
    });
    expect(
      await tickPipelineScheduler({ now: opening, deps }, db),
    ).toMatchObject({
      rolledOverRuns: 0,
      executedRuns: wake === "holiday" ? 1 : 0,
      expiredIntents: 0,
    });
    expect(
      await tickPipelineScheduler({ now: opening + 60_000, deps }, db),
    ).toMatchObject({
      rolledOverRuns: 0,
      executedRuns: 0,
      expiredIntents: 0,
    });
    expect(findPipelineRun(id, decisionDay, "daily", db)).toMatchObject({
      id: run.id,
      executeDate: followingDay,
      stage: "completed",
    });
    const intents = listIntentsByRun(run.id, db);
    expect(intents.map(({ id }) => id)).toEqual(original.map(({ id }) => id));
    for (const [index, intent] of intents.entries()) {
      expect(intent).toMatchObject({
        executeDate: followingDay,
        status: "filled",
      });
      expect(intent.idempotencyKey).not.toBe(original[index]!.idempotencyKey);
      expect(JSON.parse(intent.idempotencyKey)).toContain(followingDay);
    }
    expect(thsAdapter.submitOrder).toHaveBeenCalledTimes(2);
    expect(
      listExecutionAuditEvents(
        { deploymentId: id, runId: run.id },
        db,
      ).items.filter(
        (event) => event.eventType === "execution_calendar_rollover",
      ),
    ).toMatchObject([
      {
        details: {
          from: executeDay,
          to: followingDay,
          intents: 2,
          reason: "provisional-date-confirmed-closed",
        },
      },
    ]);
  },
);

it("定时复查会顺延 manual_only 的暂定计划，确认日开盘仍等待人工批准", async () => {
  const dep = createStock({
    executionMode: "manual_confirm",
    schedule: { kind: "manual_only" },
  });
  const thsAdapter = offlineVenue("ths_mock");
  const deps = {
    ...stockDeps(),
    isTradingDay: (date: string) => date !== executeDay,
    thsAdapter,
  };
  const planned = await runPipelinePlanning(
    {
      deploymentId: dep.id,
      decisionDate: decisionDay,
      executeDate: executeDay,
      triggerKind: "manual",
      calendarWarning: "暂定执行日",
      deps,
    },
    db,
  );
  expect(planned.intents.length).toBeGreaterThan(0);
  expect(
    await tickPipelineScheduler({ now: openTick, deps }, db),
  ).toMatchObject({
    rolledOverRuns: 1,
    executedRuns: 0,
  });
  expect(
    await tickPipelineScheduler(
      { now: Date.parse(followingDay + "T09:35:00+08:00"), deps },
      db,
    ),
  ).toMatchObject({
    rolledOverRuns: 0,
    executedRuns: 0,
  });
  expect(listIntentsByRun(planned.run.id, db)).toMatchObject(
    planned.intents.map(({ id }) => ({
      id,
      executeDate: followingDay,
      status: "planned",
    })),
  );
  expect(thsAdapter.submitOrder).not.toHaveBeenCalled();
});

it("已确认执行日后来被改为休市时，不借决策日警告顺延", async () => {
  const { id } = createStock();
  const thsAdapter = offlineVenue("ths_mock");
  const days = new Map<string, boolean>([
    [executeDay, true],
    [followingDay, true],
  ]);
  const deps = {
    ...stockDeps(),
    isTradingDay: (date: string) => days.get(date) ?? null,
    thsAdapter,
  };
  setGlobalAutoSimEnabled(true, db);
  expect(
    await tickPipelineScheduler({ now: closeTick, deps }, db),
  ).toMatchObject({ plannedRuns: 1, failures: [] });
  const run = findPipelineRun(id, decisionDay, "daily", db)!;
  expect(run.executeDate).toBe(executeDay);
  expect(
    listExecutionAuditEvents({ deploymentId: id, runId: run.id }, db).items,
  ).not.toContainEqual(
    expect.objectContaining({ eventType: "execution_calendar_fallback" }),
  );
  appendExecutionAuditEvent(
    {
      deploymentId: id,
      runId: run.id,
      eventType: "execution_calendar_fallback",
      details: {
        executeDate: executeDay,
        warning: "决策日交易日历缺失，暂按工作日和收盘数据回执规划",
      },
    },
    db,
  );
  days.set(executeDay, false);
  expect(
    await tickPipelineScheduler({ now: openTick, deps }, db),
  ).toMatchObject({ rolledOverRuns: 0, executedRuns: 0 });
  expect(
    await tickPipelineScheduler(
      { now: Date.parse(`${followingDay}T09:35:00+08:00`), deps },
      db,
    ),
  ).toMatchObject({ rolledOverRuns: 0, expiredIntents: 2, executedRuns: 0 });
  expect(thsAdapter.submitOrder).not.toHaveBeenCalled();
});

it.each([false, null])(
  "暂定日状态为 %s 时，开盘日历迟到仍可在同一开盘窗内恢复",
  async (originalSession) => {
    const { id } = createStock();
    const thsAdapter = offlineVenue("ths_mock");
    const sessions = new Map<string, boolean>([[decisionDay, true]]);
    const deps = {
      ...stockDeps(),
      nextTradingDay: undefined,
      isTradingDay: (date: string) => sessions.get(date) ?? null,
      thsAdapter,
    };
    setGlobalAutoSimEnabled(true, db);
    await tickPipelineScheduler({ now: closeTick, deps }, db);
    const run = findPipelineRun(id, decisionDay, "daily", db)!;
    const original = listIntentsByRun(run.id, db);
    expect(original).toHaveLength(2);

    if (originalSession !== null) sessions.set(executeDay, originalSession);
    const opening = Date.parse(`${followingDay}T09:31:00+08:00`);
    expect(
      await tickPipelineScheduler({ now: opening, deps }, db),
    ).toMatchObject({
      rolledOverRuns: 0,
      expiredIntents: 0,
      executedRuns: 0,
    });
    expect(listIntentsByRun(run.id, db)).toEqual(original);
    expect(thsAdapter.submitOrder).not.toHaveBeenCalled();

    sessions.set(executeDay, false);
    sessions.set(followingDay, true);
    expect(
      await tickPipelineScheduler({ now: opening + 60_000, deps }, db),
    ).toMatchObject({ rolledOverRuns: 1, expiredIntents: 0, executedRuns: 1 });
    expect(listIntentsByRun(run.id, db).map(({ status }) => status)).toEqual([
      "filled",
      "filled",
    ]);
  },
);

it.each([
  { original: null, firstOpen: true, wake: "2024-04-23T09:35:00+08:00" },
  { original: true, firstOpen: true, wake: "2024-04-23T09:35:00+08:00" },
  { original: false, firstOpen: null, wake: "2024-04-24T09:35:00+08:00" },
  { original: false, firstOpen: true, wake: "2024-04-23T14:56:00+08:00" },
  { original: false, firstOpen: true, wake: "2024-04-24T09:35:00+08:00" },
])(
  "已逾期的暂定计划只拒绝一次 ($original, $firstOpen, $wake)",
  async ({ original, firstOpen, wake }) => {
    const { id } = createStock();
    const thsAdapter = offlineVenue("ths_mock");
    const sessions = new Map<string, boolean | null>([[decisionDay, true]]);
    const deps = {
      ...stockDeps(),
      nextTradingDay: undefined,
      isTradingDay: (date: string) => sessions.get(date) ?? null,
      thsAdapter,
    };
    setGlobalAutoSimEnabled(true, db);
    await tickPipelineScheduler({ now: closeTick, deps }, db);
    const run = findPipelineRun(id, decisionDay, "daily", db)!;
    const old = listIntentsByRun(run.id, db);
    sessions.set(executeDay, original);
    sessions.set(followingDay, firstOpen);
    sessions.set("2024-04-24", true);
    const now = Date.parse(wake);
    expect(await tickPipelineScheduler({ now, deps }, db)).toMatchObject({
      rolledOverRuns: 0,
      executedRuns: 0,
      expiredIntents: 2,
    });
    expect(await tickPipelineScheduler({ now, deps }, db)).toMatchObject({
      rolledOverRuns: 0,
      executedRuns: 0,
      expiredIntents: 0,
    });
    expect(findPipelineRun(id, decisionDay, "daily", db)).toMatchObject({
      executeDate: executeDay,
      stage: "failed",
    });
    expect(listIntentsByRun(run.id, db)).toMatchObject(
      old.map(({ id, idempotencyKey }) => ({
        id,
        idempotencyKey,
        status: "rejected",
        errorSummary: "execute-date-expired",
      })),
    );
    expect(
      listExecutionAuditEvents(
        { deploymentId: id, runId: run.id },
        db,
      ).items.filter(
        (event) => event.eventType === "execution_calendar_overdue",
      ),
    ).toMatchObject([
      {
        details: {
          executeDate: executeDay,
          intents: 2,
          reason: "execute-date-expired",
        },
      },
    ]);
    expect(thsAdapter.submitOrder).not.toHaveBeenCalled();
  },
);

it("加密 09:00 与 09:15 独立规划和执行，同槽重复调用不会重建或重发意图", async () => {
  const { id } = createCrypto();
  const venue = offlineVenue("crypto_sim");
  const firstSlot = Date.parse(`${decisionDay}T09:00:00Z`);
  const secondSlot = firstSlot + 15 * 60_000;
  let now = firstSlot;
  const prices = [10, 10, 10, 12, 5];
  const history = prices.map((price, index) =>
    bar(new Date(firstSlot + (index - 4) * 15 * 60_000).toISOString(), price),
  );
  venue.readAccountState.mockImplementation(async () =>
    now < secondSlot
      ? account
      : {
          ...account,
          positions: [
            { symbol: bitcoin, quantity: 1, sellable: 1, lastPrice: 5 },
          ],
        },
  );
  const deps: PipelineSchedulerDeps = {
    readQuote: (symbol, tradeDate) => ({
      symbol,
      tradeDate,
      openPrice: null,
      lastPrice: now < secondSlot ? 12 : 5,
      prevClose: 10,
      upperLimit: null,
      lowerLimit: null,
      suspended: false,
    }),
    cryptoSimAdapter: venue,
    strategy: {
      readBars: () => history.filter(({ date }) => Date.parse(date) < now),
    },
    readReferencePrice: () => (now < secondSlot ? 12 : 5),
  };
  setGlobalAutoSimEnabled(true, db);
  const { run: checkpoint } = await runPipelinePlanning(
    {
      deploymentId: id,
      decisionDate: decisionDay,
      executeDate: decisionDay,
      runSlot: "09:00",
      triggerKind: "manual",
      stopAfterStage: "universe",
      deps,
    },
    db,
  );
  expect(checkpoint.stage).toBe("universe_done");

  expect(await tickPipelineScheduler({ now, deps }, db)).toMatchObject({
    plannedRuns: 1,
    executedRuns: 1,
    failures: [],
  });
  now = secondSlot;
  expect(await tickPipelineScheduler({ now, deps }, db)).toMatchObject({
    plannedRuns: 1,
    executedRuns: 1,
    failures: [],
  });
  const first = findPipelineRun(id, decisionDay, "09:00", db)!;
  const second = findPipelineRun(id, decisionDay, "09:15", db)!;
  expect(first.id).toBe(checkpoint.id);
  expect(first.id).not.toBe(second.id);
  const firstIntents = listIntentsByRun(first.id, db);
  const secondIntents = listIntentsByRun(second.id, db);
  expect(firstIntents).toMatchObject([
    {
      symbol: bitcoin,
      side: "BUY",
      status: "filled",
      executeDate: decisionDay,
    },
  ]);
  expect(secondIntents).toMatchObject([
    {
      symbol: bitcoin,
      side: "SELL",
      status: "filled",
      executeDate: decisionDay,
    },
  ]);
  expect(firstIntents[0]!.idempotencyKey).not.toBe(
    secondIntents[0]!.idempotencyKey,
  );
  expect(JSON.parse(firstIntents[0]!.idempotencyKey).at(-1)).toBe("09:00");
  expect(JSON.parse(secondIntents[0]!.idempotencyKey).at(-1)).toBe("09:15");
  now += 60_000;
  expect(await tickPipelineScheduler({ now, deps }, db)).toMatchObject({
    plannedRuns: 0,
    executedRuns: 0,
  });
  expect(listPipelineRuns({ deploymentId: id }, db).items).toHaveLength(2);
  expect(venue.submitOrder).toHaveBeenCalledTimes(2);
});

it("两种自动模式在各自总开关关闭时仍规划，并在开盘保留待执行意图", async () => {
  const sim = createStock();
  const live = createStock({
    executionMode: "auto_live",
    venueBinding: {
      kind: "cn_broker_live",
      broker: "http_bridge",
      accountId: "test",
    },
  });
  const thsAdapter = offlineVenue("ths_mock");
  const deps = { ...stockDeps(), thsAdapter, readCredential: vi.fn() };
  setGlobalAutoSimEnabled(false, db);
  setGlobalAutoLiveEnabled(false, db);
  expect(
    await tickPipelineScheduler({ now: closeTick, deps }, db),
  ).toMatchObject({ plannedRuns: 2, executedRuns: 0, failures: [] });
  expect(
    await tickPipelineScheduler({ now: openTick, deps }, db),
  ).toMatchObject({ executedRuns: 0, failures: [] });
  for (const { id } of [sim, live]) {
    const run = findPipelineRun(id, decisionDay, "daily", db)!;
    expect(listIntentsByRun(run.id, db).map(({ status }) => status)).toEqual([
      "planned",
      "planned",
    ]);
  }
  expect(thsAdapter.submitOrder).not.toHaveBeenCalled();
  expect(deps.readCredential).not.toHaveBeenCalled();
});

it.each([broker, cryptoLive])(
  "$kind 总开关关闭时既不读取实盘凭证也不联网",
  async (binding) => {
    const readCredential = vi.fn(async () => ({
      token: "offline-token",
      apiKey: "offline-key",
      apiSecret: "offline-secret",
    }));
    const adapter = resolveVenueAdapter(binding, { readCredential });
    await expect(
      adapter.readAccountState(
        binding,
        new Date().toISOString().slice(0, 10),
        db,
      ),
    ).rejects.toThrow("实盘总开关未开启");
    expect(readCredential).not.toHaveBeenCalled();
  },
);

it("定时规划在实盘开关关闭时跳过外部账户读取，不累计部署失败", async () => {
  const { id } = createStock({
    executionMode: "auto_live",
    venueBinding: broker,
  });
  const { universe, isTradingDay, nextTradingDay, isPostCloseDataReady } =
    stockDeps();
  const readCredential = vi.fn(async () => ({ token: "offline-token" }));
  const deps = {
    universe,
    isTradingDay,
    nextTradingDay,
    isPostCloseDataReady,
    readCredential,
  };
  expect(
    await tickPipelineScheduler({ now: closeTick, deps }, db),
  ).toMatchObject({
    plannedRuns: 0,
    failures: [],
  });
  expect(findPipelineRun(id, decisionDay, "daily", db)).toBeNull();
  expect(getDeployment(id, db)).toMatchObject({
    status: "active",
    consecutiveFailures: 0,
  });
  expect(readCredential).not.toHaveBeenCalled();
});

it("读取实盘凭证期间关闭总开关时终止账户请求", async () => {
  setGlobalAutoLiveEnabled(true, db);
  const adapter = resolveVenueAdapter(broker, {
    readCredential: async () => {
      setGlobalAutoLiveEnabled(false, db);
      return { token: "offline-token" };
    },
  });
  await expect(
    adapter.readAccountState(broker, decisionDay, db),
  ).rejects.toThrow("实盘总开关未开启");
});

it.each([
  { endpointUrl: "https://trusted.example.invalid/bridge" },
  { allowedOrigin: "https://broker.example.invalid:8443" },
  { endpointUrl: "invalid-url" },
])("券商凭证来源限制不匹配时拒绝账户与委托请求 (%j)", async (origin) => {
  setGlobalAutoLiveEnabled(true, db);
  const { id } = createStock({
    executionMode: "auto_live",
    venueBinding: broker,
  });
  await tickPipelineScheduler({ now: closeTick, deps: stockDeps() }, db);
  const run = findPipelineRun(id, decisionDay, "daily", db)!;
  const [sell] = listIntentsByRun(run.id, db);
  const intent = transitionIntentStatus(sell!.id, "submitting", {}, db);
  const adapter = resolveVenueAdapter(broker, {
    now: () => openTick,
    readCredential: async () => ({ token: "offline-token", ...origin }),
  });
  await expect(
    adapter.readAccountState(broker, decisionDay, db),
  ).rejects.toThrow("实盘桥接地址");
  await expect(
    adapter.submitOrder(intent, {
      executeDate: executeDay,
      executePrice: 6,
      db,
    }),
  ).resolves.toMatchObject({ status: "rejected" });
  await expect(adapter.reconcileOrder(intent, { db })).resolves.toMatchObject({
    status: "unknown_reconcile",
  });
  await expect(adapter.cancelOrder(intent, { db })).resolves.toMatchObject({
    status: "unknown_reconcile",
  });
});

it("券商凭证绑定同一 origin 时允许向已配置地址读账户", async () => {
  setGlobalAutoLiveEnabled(true, db);
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValue(Response.json(account));
  const adapter = resolveVenueAdapter(broker, {
    fetchImpl,
    readCredential: async () => ({
      token: "offline-token",
      endpointUrl: "https://broker.example.invalid:443/another-path",
    }),
  });
  await expect(
    adapter.readAccountState(broker, decisionDay, db),
  ).resolves.toEqual(account);
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    broker.endpointUrl + "/account",
    expect.objectContaining({
      method: "GET",
      redirect: "error",
      headers: expect.objectContaining({
        Authorization: "Bearer offline-token",
      }),
    }),
  );
});

it("失败部署连续两轮失败后自动暂停，同一轮的正常部署仍完成规划", async () => {
  const healthy = createStock({
    id: "a-healthy",
    venueBinding: { kind: "local_sim", simAccountId: "healthy" },
  });
  const broken = createStock({
    id: "z-broken",
    riskPolicy: { maxConsecutiveFailures: 2 },
  });
  const deps: PipelineSchedulerDeps = {
    ...stockDeps(),
    readAccountState: ({ kind }) => {
      if (kind === "ths_mock") throw new Error("账户快照不可用");
      return account;
    },
  };
  const secondClose = Date.parse(`${executeDay}T15:35:00+08:00`);
  for (const [index, now] of [closeTick, secondClose].entries()) {
    expect(await tickPipelineScheduler({ now, deps }, db)).toMatchObject({
      plannedRuns: 1,
      failures: [{ deploymentId: broken.id, message: "账户快照不可用" }],
    });
    expect(getDeployment(broken.id, db)).toMatchObject({
      consecutiveFailures: index + 1,
      status: index === 0 ? "active" : "paused",
    });
  }
  expect(getDeployment(broken.id, db)?.pauseReason).toBe("账户快照不可用");
  expect(findPipelineRun(healthy.id, decisionDay, "daily", db)?.stage).toBe(
    "risk_checked",
  );
  // The first run still reserves the same symbol and position on the shared account.
  expect(findPipelineRun(healthy.id, executeDay, "daily", db)?.stage).toBe(
    "completed",
  );
  expect(
    await tickPipelineScheduler({ now: secondClose, deps }, db),
  ).toMatchObject({ plannedRuns: 0, failures: [] });
});

it("分页遍历启用部署，manual_only 只对账历史委托并保留待提交的意图", async () => {
  const { id } = createStock({ id: "a-paged" });
  const venue = offlineVenue("ths_mock");
  const deps = { ...stockDeps(), thsAdapter: venue };
  for (let index = 0; index < 51; index++)
    createStock({ id: `z-manual-${index}`, schedule: { kind: "manual_only" } });
  const inactive = createStock({ status: "draft" });
  setGlobalAutoSimEnabled(true, db);
  expect(
    await tickPipelineScheduler({ now: closeTick, deps }, db),
  ).toMatchObject({ plannedRuns: 1 });
  expect(listPipelineRuns({ deploymentId: inactive.id }, db).items).toEqual([]);
  const run = findPipelineRun(id, decisionDay, "daily", db)!;
  const intents = listIntentsByRun(run.id, db);
  expect(intents).toMatchObject([{ side: "SELL" }, { side: "BUY" }]);
  const [sell, buy] = intents;
  transitionIntentStatus(sell!.id, "submitting", {}, db);
  transitionIntentStatus(
    sell!.id,
    "unknown_reconcile",
    { venueOrderId: "offline-order" },
    db,
  );
  updateDeploymentConfig(id, { schedule: { kind: "manual_only" } }, db);

  expect(
    await tickPipelineScheduler(
      { now: Date.parse(`${followingDay}T15:35:00+08:00`), deps },
      db,
    ),
  ).toMatchObject({ plannedRuns: 0, executedRuns: 0, reconciledIntents: 1 });
  expect(listIntentsByRun(run.id, db)).toMatchObject([
    { id: sell!.id, status: "filled" },
    { id: buy!.id, status: "planned" },
  ]);
  expect(venue.submitOrder).not.toHaveBeenCalled();
});

it("重入立即跳过，顶层异常后释放锁", async () => {
  createStock();
  let reportReady!: (ready: boolean) => void;
  const readiness = new Promise<boolean>((resolve) => {
    reportReady = resolve;
  });
  const deps = { ...stockDeps(), isPostCloseDataReady: () => readiness };
  const pending = tickPipelineScheduler({ now: closeTick, deps }, db);
  try {
    expect(await tickPipelineScheduler({ now: closeTick, deps }, db)).toEqual({
      skipped: true,
    });
  } finally {
    reportReady(false);
    await pending;
  }
  const closedDb = new Database(":memory:");
  closedDb.close();
  await expect(
    tickPipelineScheduler({ now: closeTick, deps }, closedDb),
  ).rejects.toThrow();
  expect(
    await tickPipelineScheduler({ now: closeTick, deps }, db),
  ).toMatchObject({ skipped: false, plannedRuns: 0 });
});

it("节前规划与节后开盘均取逐月日历，指数日线只到节前也能执行", async () => {
  const { id } = createStock();
  const last = "2024-09-30",
    next = "2024-10-08";
  db.prepare(
    "INSERT INTO records (id, kind, payload, updated_at) VALUES ('settings','settings',?,?)",
  ).run(
    JSON.stringify({ calendar: [last], tdxRoot: process.env.QUANT_DATA_DIR }),
    closeTick,
  );
  const gf = vi
    .mocked(gfCalendar.gfCalendarReference)
    .mockImplementation(async (ms) => {
      const month = new Date(ms).toISOString().slice(0, 7);
      if (month === "2024-09")
        return { days: [last], closedDays: [], source: "fixture", hash: null };
      if (month === "2024-10")
        return {
          days: [next],
          closedDays: Array.from({ length: 7 }, (_, i) => `2024-10-0${i + 1}`),
          source: "fixture",
          hash: null,
        };
      throw new Error("unexpected month");
    });
  const { universe, readAccountState, readQuote, isPostCloseDataReady } =
    stockDeps();
  const thsAdapter = offlineVenue("ths_mock");
  const deps = {
    universe,
    readAccountState,
    readQuote,
    isPostCloseDataReady,
    thsAdapter,
  };
  setGlobalAutoSimEnabled(true, db);
  expect(
    await tickPipelineScheduler(
      { now: Date.parse(last + "T15:35:00+08:00"), deps },
      db,
    ),
  ).toMatchObject({ plannedRuns: 1, failures: [] });
  const run = findPipelineRun(id, last, "daily", db)!;
  expect(run.executeDate).toBe(next);
  expect(
    await tickPipelineScheduler(
      { now: Date.parse("2024-10-01T09:35:00+08:00"), deps },
      db,
    ),
  ).toMatchObject({ executedRuns: 0 });
  expect(
    await tickPipelineScheduler(
      { now: Date.parse(next + "T09:35:00+08:00"), deps },
      db,
    ),
  ).toMatchObject({ executedRuns: 1, failures: [] });
  expect(
    thsAdapter.submitOrder.mock.calls.map(([intent]) => intent.side),
  ).toEqual(["SELL", "BUY"]);
  expect(gf).toHaveBeenCalled();
});

it("广发服务离线时用已校验的月历缓存跨国庆，未知工作日只可暂定规划", async () => {
  db.prepare(
    "INSERT INTO records(id,kind,payload,updated_at) VALUES(?,?,?,?)",
  ).run(
    "gf-calendar-1-2026-10",
    "calendar",
    JSON.stringify({ raw: octoberCalendar, fetchedAt: 0 }),
    0,
  );
  const calendar = cnTradingCalendar(db, "2026-09-30");
  expect(await calendar.session("2026-10-01")).toBe(false);
  expect(await calendar.nextSession("2026-09-30")).toEqual({
    executeDate: "2026-10-08",
    calendarWarning: null,
  });
  expect(await calendar.session("2026-11-02")).toBeNull();
  expect(await calendar.nextSession("2026-10-30")).toEqual({
    executeDate: "2026-11-02",
    calendarWarning: expect.stringContaining("待确认"),
  });
});
