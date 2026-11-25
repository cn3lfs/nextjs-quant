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
  findPipelineRun,
  getOrCreatePipelineRun,
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
  drawdownPct: null,
  positions: [],
};

let db: Database.Database;
let deploymentCount: number;
const fetchAttempt = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchAttempt.mockReset().mockRejectedValue(new Error("离线测试禁止联网"));
  vi.stubGlobal("fetch", fetchAttempt);
  db = new Database(":memory:");
  deploymentCount = 0;
  migrate(db);
});

afterEach(() => {
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
  return createDeployment(
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

it("A 股执行窗内先对账已报卖单再下买单，09:20 与 15:05 均不执行", async () => {
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

  for (const time of ["09:20", "15:05"]) {
    const now = Date.parse(`${executeDay}T${time}:00+08:00`);
    expect(await tickPipelineScheduler({ now, deps }, db)).toMatchObject({
      executedRuns: 0,
      reconciledIntents: 0,
    });
  }
  expect(venue.reconcileOrder).not.toHaveBeenCalled();
  expect(venue.submitOrder).not.toHaveBeenCalled();
  expect(
    await tickPipelineScheduler({ now: openTick, deps }, db),
  ).toMatchObject({ executedRuns: 1, reconciledIntents: 1, failures: [] });
  expect(venue.reconcileOrder).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: sell!.id }),
    { db },
  );
  expect(venue.submitOrder).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: buy!.id }),
    expect.objectContaining({ executeDate: executeDay }),
  );
  expect(venue.reconcileOrder.mock.invocationCallOrder[0]).toBeLessThan(
    venue.submitOrder.mock.invocationCallOrder[0]!,
  );
  expect(listIntentsByRun(run.id, db).map(({ status }) => status)).toEqual([
    "filled",
    "filled",
  ]);
  await tickPipelineScheduler({ now: openTick + 60_000, deps }, db);
  expect(venue.submitOrder).toHaveBeenCalledTimes(1);
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
    failures: [],
  });
  expect(thsAdapter.reconcileOrder).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: sell!.id, executeDate: executeDay, status }),
    { db },
  );
  expect(listIntentsByRun(run.id, db)).toMatchObject([
    { id: sell!.id, status: "filled" },
    { id: buy!.id, status: "planned" },
  ]);
  expect(thsAdapter.submitOrder).not.toHaveBeenCalled();
});

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
  expect(
    listPipelineRuns({ deploymentId: healthy.id }, db).items.map(
      ({ stage }) => stage,
    ),
  ).toEqual(["risk_checked", "risk_checked"]);
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
  const [sell, buy] = listIntentsByRun(run.id, db);
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
