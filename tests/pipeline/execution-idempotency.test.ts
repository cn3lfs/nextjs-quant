import { join } from "node:path";
import Database from "better-sqlite3";
import { extractVenueAccountKey, type VenueBinding } from "trading-strategies";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createDeployment,
  setGlobalAutoLiveEnabled,
  setGlobalAutoSimEnabled,
  type CreateDeploymentInput,
} from "~/server/db/deployment-repository";
import { migrate } from "~/server/db/migrations";
import {
  claimIntentForSubmission,
  getOrCreatePipelineRun,
  getPipelineRun,
  insertOrderIntents,
  listExecutionAuditEvents,
  listIntentsByRun,
  transitionIntentStatus,
  updatePipelineRunStage,
  type InsertOrderIntentInput,
  type OrderIntentRecord,
} from "~/server/db/pipeline-repository";
import { SimAccountRepository } from "~/server/db/sim-account-repository";
import {
  approveAndExecuteIntent,
  executePipelineRun,
  reconcilePendingIntents,
  type PipelineQuoteSnapshot,
} from "~/server/execution/pipeline-executor";
import {
  registerLiveVenueAdapter,
  resolveVenueAdapter,
  unregisterLiveVenueAdapter,
  type ExecutionVenueAdapter,
} from "~/server/execution/venue-router";
import {
  createSimAccount,
  executePipelineSimOrder,
  getSimAccountDetail,
} from "~/server/portfolio/sim-accounts/service";

const stockA = "sh600001";
const stockB = "sh600002";
const decisionDate = "2024-04-15";
const executeDate = "2024-04-16";
const sessionNow = () => Date.parse(`${executeDate}T08:00:00Z`);
const ths = { kind: "ths_mock", accountTag: "default" } as const;
const broker = {
  kind: "cn_broker_live",
  broker: "http_bridge",
  accountId: "wave-c-broker",
} as const;
const crypto = {
  kind: "crypto_live",
  venue: "binance",
  accountId: "wave-c-crypto",
} as const;
const cryptoSim = { ...crypto, kind: "crypto_sim" } as const;

type Order = Pick<
  InsertOrderIntentInput,
  "symbol" | "side" | "phase" | "quantity" | "referencePrice"
>;
const buyB = {
  symbol: stockB,
  side: "BUY",
  phase: 2,
  quantity: 100,
  referencePrice: 10,
} as const satisfies Order;
const sellA = {
  symbol: stockA,
  side: "SELL",
  phase: 1,
  quantity: 100,
  referencePrice: 11,
} as const satisfies Order;
const buyBitcoin = {
  ...buyB,
  symbol: "cxBTCUSDT",
  quantity: 0.001,
  referencePrice: 60_000,
};

let db: Database.Database;
const unexpectedFetch = vi.fn<typeof fetch>();
const registeredKeys = new Set<string>();

beforeEach(() => {
  unexpectedFetch.mockReset().mockRejectedValue(new Error("离线测试禁止联网"));
  vi.stubGlobal("fetch", unexpectedFetch);
  db = new Database(":memory:");
  migrate(db);
});

afterEach(() => {
  for (const key of registeredKeys) unregisterLiveVenueAdapter(key);
  registeredKeys.clear();
  if (db.open) db.close();
  vi.unstubAllGlobals();
  expect(unexpectedFetch).not.toHaveBeenCalled();
});

function createRun(
  executionMode: CreateDeploymentInput["executionMode"],
  venueBinding: VenueBinding,
  orders: readonly Order[] = [buyB],
) {
  const deployment = createDeployment(
    {
      name: "执行安全测试",
      market:
        venueBinding.kind === "crypto_live" ||
        venueBinding.kind === "crypto_sim"
          ? "crypto"
          : "cn-equity",
      status: "active",
      executionMode,
      strategySpec: { kind: "study-rule", strategyId: "breakout" },
      universeSpec: {
        kind: "fixed-symbols",
        symbols: orders.map(({ symbol }) => symbol),
      },
      regimeGate: { kind: "none" },
      riskPolicy: { maxGapPct: 0.02 },
      venueBinding,
      schedule: { kind: "manual_only" },
      provenance: { sourceKind: "manual" },
    },
    db,
  );
  const { run } = getOrCreatePipelineRun(
    {
      deploymentId: deployment.id,
      decisionDate,
      executeDate,
      triggerKind: "manual",
    },
    db,
  );
  updatePipelineRunStage(run.id, { stage: "risk_checked" }, db);
  const intents = insertOrderIntents(
    run.id,
    orders.map((order) => ({
      ...order,
      runId: run.id,
      deploymentId: deployment.id,
      venueKind: venueBinding.kind,
    })),
    db,
  );
  return { runId: run.id, executeDate, intents };
}

function mockVenue(
  kind: "ths_mock" | "cn_broker_live" | "crypto_live" | "crypto_sim",
) {
  const submitOrder = vi.fn<ExecutionVenueAdapter["submitOrder"]>(
    async (intent, { executePrice }) => ({
      status: "filled",
      venueOrderId: `venue-${intent.symbol}`,
      filledQuantity: intent.quantity,
      averageFillPrice: executePrice,
    }),
  );
  return {
    kind,
    isLive: kind === "cn_broker_live" || kind === "crypto_live",
    submitOrder,
    reconcileOrder: vi.fn<ExecutionVenueAdapter["reconcileOrder"]>(),
    readAccountState: vi.fn<ExecutionVenueAdapter["readAccountState"]>(),
    cancelOrder: vi.fn<ExecutionVenueAdapter["cancelOrder"]>(),
  } satisfies ExecutionVenueAdapter;
}

function registerVenue(binding: VenueBinding, adapter: ExecutionVenueAdapter) {
  const key = extractVenueAccountKey(binding);
  registerLiveVenueAdapter(key, adapter);
  registeredKeys.add(key);
}

function auditFor(intent: OrderIntentRecord) {
  return listExecutionAuditEvents(
    { deploymentId: intent.deploymentId, runId: intent.runId },
    db,
  ).items;
}

it("先卖 A 再用回款买 B，精确结算且重跑不新增成交", async () => {
  const { id: accountId } = createSimAccount(
    { name: "换仓账户", market: "cn-equity", initialCapital: "1005.50" },
    db,
  );
  executePipelineSimOrder(
    {
      accountId,
      clientRequestId: "opening-position",
      symbol: stockA,
      side: "buy",
      tradeDate: decisionDate,
      price: 10,
      quantity: 100,
    },
    db,
  );
  const repo = new SimAccountRepository(db);
  const ledger = () =>
    getSimAccountDetail({ accountId, currentTradeDate: executeDate }, db);
  expect(repo.account(accountId).cash_atoms).toBe(0n);
  expect(ledger().positions).toMatchObject([
    {
      symbol: stockA,
      quantity: "100",
      sellableQuantity: "100",
      costBasis: "1005.50",
    },
  ]);

  setGlobalAutoSimEnabled(true, db);
  // Insert the buy first so insertion order cannot accidentally satisfy the phase rule.
  const {
    intents: [buy, sell],
    ...input
  } = createRun("auto_sim", { kind: "local_sim", simAccountId: accountId }, [
    buyB,
    sellA,
  ]);
  expect(await executePipelineRun(input, db)).toMatchObject({
    skipped: false,
    stage: "completed",
  });

  const completed = getPipelineRun(input.runId, db);
  expect(completed).toMatchObject({
    stage: "completed",
    finishedAt: expect.any(Number),
  });
  const after = ledger();
  // Sell: 1100 - 5 commission - 0.55 tax - 0.55 slippage = 1093.90.
  // Buy: 1000 + 5 commission + 0.50 slippage = 1005.50.
  expect(repo.account(accountId).cash_atoms).toBe(8_840n);
  expect(after.positions).toMatchObject([
    {
      symbol: stockB,
      quantity: "100",
      sellableQuantity: "0",
      costBasis: "1005.50",
    },
  ]);
  expect(Array.from(repo.fills(accountId))).toMatchObject([
    { symbol: stockA, side: "buy", quantity_atoms: 100n },
    { symbol: stockA, side: "sell", quantity_atoms: 100n },
    { symbol: stockB, side: "buy", quantity_atoms: 100n },
  ]);
  expect(after.cashFlows.map(({ delta }) => delta)).toEqual([
    "-1005.50",
    "1093.90",
    "-1005.50",
    "1005.50",
  ]);
  const settled = listIntentsByRun(input.runId, db);
  expect(settled).toMatchObject([
    {
      id: sell!.id,
      status: "filled",
      filledQuantity: 100,
      averageFillPrice: 11,
      venueOrderId: after.trades[1]?.orderId,
    },
    {
      id: buy!.id,
      status: "filled",
      filledQuantity: 100,
      averageFillPrice: 10,
      venueOrderId: after.trades[0]?.orderId,
    },
  ]);

  expect(await executePipelineRun(input, db)).toMatchObject({
    skipped: false,
    stage: "completed",
  });
  expect(Array.from(repo.fills(accountId))).toHaveLength(3);
  expect(repo.account(accountId).cash_atoms).toBe(8_840n);
  expect(ledger()).toEqual(after);
  expect(listIntentsByRun(input.runId, db)).toEqual(settled);
  expect(getPipelineRun(input.runId, db)).toEqual(completed);
});

it("卖单提交超时后重开 SQLite 仍绝不重发，查实全成交后才放行买单", async () => {
  const dataDir = process.env.QUANT_DATA_DIR;
  if (!dataDir) throw new Error("重启测试需要 Vitest 提供隔离数据目录");
  const filename = join(dataDir, "execution-restart.sqlite");
  db.close();
  db = new Database(filename);
  migrate(db);

  setGlobalAutoSimEnabled(true, db);
  const {
    intents: [sell, buy],
    ...input
  } = createRun("auto_sim", ths, [sellA, buyB]);
  const adapter = mockVenue(ths.kind);
  adapter.submitOrder.mockRejectedValueOnce(new Error("network timeout"));
  const deps = { thsAdapter: adapter };
  expect(await executePipelineRun({ ...input, deps }, db)).toMatchObject({
    stage: "executing",
  });
  expect(adapter.submitOrder).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      id: sell!.id,
      status: "submitting",
      idempotencyKey: sell!.idempotencyKey,
    }),
    expect.objectContaining({ executeDate, executePrice: 11 }),
  );
  const beforeRestart = listIntentsByRun(input.runId, db);
  expect(beforeRestart).toMatchObject([
    {
      id: sell!.id,
      status: "unknown_reconcile",
      filledQuantity: null,
      venueOrderId: null,
    },
    {
      id: buy!.id,
      status: "planned",
      filledQuantity: null,
      venueOrderId: null,
    },
  ]);

  db.close();
  db = new Database(filename, { fileMustExist: true });
  // Discard application module state while keeping the venue-side call history.
  vi.resetModules();
  const restarted = await import("~/server/execution/pipeline-executor");
  expect(
    await restarted.executePipelineRun({ ...input, deps }, db),
  ).toMatchObject({
    stage: "executing",
  });
  expect(adapter.submitOrder).toHaveBeenCalledTimes(1);
  expect(adapter.reconcileOrder).not.toHaveBeenCalled();
  expect(listIntentsByRun(input.runId, db)).toEqual(beforeRestart);

  adapter.reconcileOrder.mockResolvedValueOnce({
    status: "filled",
    venueOrderId: "reconciled-sell",
    filledQuantity: 100,
    averageFillPrice: 11,
  });
  expect(
    await restarted.reconcilePendingIntents({ ...input, deps }, db),
  ).toEqual({
    queried: 1,
  });
  expect(adapter.reconcileOrder).toHaveBeenCalledExactlyOnceWith(
    beforeRestart[0],
    { db },
  );
  expect(adapter.submitOrder).toHaveBeenCalledTimes(1);
  expect(listIntentsByRun(input.runId, db)).toMatchObject([
    {
      id: sell!.id,
      status: "filled",
      venueOrderId: "reconciled-sell",
      filledQuantity: 100,
      averageFillPrice: 11,
    },
    { id: buy!.id, status: "planned" },
  ]);

  expect(
    await restarted.executePipelineRun({ ...input, deps }, db),
  ).toMatchObject({
    stage: "completed",
  });
  expect(
    adapter.submitOrder.mock.calls.map(([intent]) => intent.idempotencyKey),
  ).toEqual([sell!.idempotencyKey, buy!.idempotencyKey]);
  expect(listIntentsByRun(input.runId, db)).toMatchObject([
    { id: sell!.id, status: "filled", venueOrderId: "reconciled-sell" },
    {
      id: buy!.id,
      status: "filled",
      venueOrderId: `venue-${stockB}`,
      filledQuantity: 100,
    },
  ]);
});

it("滞留的 submitting 卖单在宽限期后恢复对账，查实成交前不会放行买单", async () => {
  setGlobalAutoSimEnabled(true, db);
  const {
    intents: [sell, buy],
    ...input
  } = createRun("auto_sim", ths, [sellA, buyB]);
  const claimedAt = sessionNow();
  const claim = claimIntentForSubmission(sell!.id, claimedAt, db);
  if (!claim.claimed) throw new Error(claim.reason);
  const adapter = mockVenue(ths.kind);
  const deps = { thsAdapter: adapter, now: () => claimedAt + 60_000 };

  expect(
    await reconcilePendingIntents(
      { ...input, deps: { ...deps, now: () => claimedAt } },
      db,
    ),
  ).toEqual({ queried: 0 });
  expect(adapter.reconcileOrder).not.toHaveBeenCalled();
  expect(await executePipelineRun({ ...input, deps }, db)).toMatchObject({
    stage: "executing",
  });
  expect(adapter.submitOrder).not.toHaveBeenCalled();

  adapter.reconcileOrder.mockRejectedValueOnce(new Error("场所暂不可用"));
  expect(await reconcilePendingIntents({ ...input, deps }, db)).toEqual({
    queried: 1,
  });
  expect(adapter.reconcileOrder).toHaveBeenCalledExactlyOnceWith(claim.intent, {
    db,
  });
  expect(listIntentsByRun(input.runId, db)).toMatchObject([
    { id: sell!.id, status: "unknown_reconcile" },
    { id: buy!.id, status: "planned" },
  ]);
  expect(adapter.submitOrder).not.toHaveBeenCalled();

  adapter.reconcileOrder.mockResolvedValueOnce({
    status: "filled",
    venueOrderId: "recovered-sell",
    filledQuantity: sell!.quantity,
    averageFillPrice: sell!.referencePrice,
  });
  expect(await reconcilePendingIntents({ ...input, deps }, db)).toEqual({
    queried: 1,
  });
  expect(await executePipelineRun({ ...input, deps }, db)).toMatchObject({
    stage: "completed",
  });
  expect(adapter.submitOrder).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: buy!.id, status: "submitting" }),
    expect.objectContaining({ db }),
  );
});

it("只开实盘总开关时依然拦截 auto_sim", async () => {
  setGlobalAutoSimEnabled(false, db);
  setGlobalAutoLiveEnabled(true, db);
  const {
    intents: [intent],
    ...input
  } = createRun("auto_sim", ths);
  const thsAdapter = mockVenue(ths.kind);
  expect(
    await executePipelineRun({ ...input, deps: { thsAdapter } }, db),
  ).toEqual({
    skipped: true,
    reason: "kill-switch-off",
  });
  expect(thsAdapter.submitOrder).not.toHaveBeenCalled();
  expect(listIntentsByRun(input.runId, db)).toEqual([intent]);
  expect(auditFor(intent!)).toContainEqual(
    expect.objectContaining({
      eventType: "execution_blocked",
      details: { reason: "kill-switch-off" },
    }),
  );
});

it.each([
  { binding: broker, order: buyB },
  { binding: crypto, order: buyBitcoin },
])("只开模拟盘总开关时依然拦截 $binding.kind", async ({ binding, order }) => {
  setGlobalAutoSimEnabled(true, db);
  setGlobalAutoLiveEnabled(false, db);
  const {
    intents: [intent],
    ...input
  } = createRun("auto_live", binding, [order]);
  const adapter = mockVenue(binding.kind);
  registerVenue(binding, adapter);

  expect(await executePipelineRun(input, db)).toEqual({
    skipped: true,
    reason: "live-kill-switch-off",
  });
  expect(adapter.submitOrder).not.toHaveBeenCalled();
  expect(listIntentsByRun(input.runId, db)).toEqual([intent]);
  expect(auditFor(intent!)).toContainEqual(
    expect.objectContaining({
      eventType: "execution_blocked",
      details: { reason: "live-kill-switch-off" },
    }),
  );
});

it("未配置券商桥接地址时拒单，不读取凭证、不联网且不写模拟账本", async () => {
  setGlobalAutoSimEnabled(true, db);
  setGlobalAutoLiveEnabled(true, db);
  const { id: accountId } = createSimAccount(
    {
      name: "与券商同 ID 的模拟账户",
      market: "cn-equity",
      initialCapital: "10000",
    },
    db,
  );
  const repo = new SimAccountRepository(db);
  const accounts = repo.list();
  const {
    intents: [intent],
    ...input
  } = createRun("auto_live", { ...broker, accountId });
  const thsAdapter = mockVenue(ths.kind);
  const fetchImpl = vi.fn<typeof fetch>();
  const readCredential = vi.fn(async () => null);

  expect(
    await executePipelineRun(
      {
        ...input,
        deps: { fetchImpl, readCredential, thsAdapter, now: sessionNow },
      },
      db,
    ),
  ).toMatchObject({ skipped: false, stage: "failed" });
  expect(listIntentsByRun(input.runId, db)).toMatchObject([
    {
      id: intent!.id,
      status: "rejected",
      errorSummary: expect.stringContaining("live_venue_not_configured"),
      filledQuantity: null,
      venueOrderId: null,
    },
  ]);
  expect(readCredential).not.toHaveBeenCalled();
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(thsAdapter.submitOrder).not.toHaveBeenCalled();
  expect(repo.list()).toEqual(accounts);
  expect(Array.from(repo.fills(accountId))).toEqual([]);
});

it("实盘开关启用时券商桥接通过 POST /orders 携带幂等键并落库成交", async () => {
  setGlobalAutoLiveEnabled(true, db);
  const endpointUrl = "https://broker.example.invalid";
  const {
    intents: [intent],
    ...input
  } = createRun("auto_live", { ...broker, endpointUrl });
  const fill = {
    status: "filled",
    venueOrderId: "bridge-fill",
    filledQuantity: 100,
    averageFillPrice: 10,
  };
  const fetchImpl = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json(fill));
  const token = "bridge-test-token";

  expect(
    await executePipelineRun(
      {
        ...input,
        deps: {
          fetchImpl,
          readCredential: async () => ({ token }),
          now: sessionNow,
        },
      },
      db,
    ),
  ).toMatchObject({ skipped: false, stage: "completed" });
  expect(fetchImpl).toHaveBeenCalledExactlyOnceWith(
    `${endpointUrl}/orders`,
    expect.objectContaining({ method: "POST" }),
  );
  const request = fetchImpl.mock.calls[0]?.[1];
  expect(new Headers(request?.headers).get("Idempotency-Key")).toBe(
    intent!.idempotencyKey,
  );
  expect(new Headers(request?.headers).get("Authorization")).toBe(
    `Bearer ${token}`,
  );
  expect(JSON.parse(String(request?.body))).toEqual({
    accountId: broker.accountId,
    symbol: stockB,
    side: "BUY",
    quantity: 100,
    price: 10,
    executeDate,
    idempotencyKey: intent!.idempotencyKey,
  });
  expect(listIntentsByRun(input.runId, db)).toMatchObject([
    { id: intent!.id, ...fill },
  ]);
});

it.each([null, { token: "   " }])(
  "券商桥接缺少有效鉴权凭证时提交和账户查询均不联网 (%j)",
  async (credential) => {
    setGlobalAutoLiveEnabled(true, db);
    const binding = {
      ...broker,
      endpointUrl: "https://broker.example.invalid",
    };
    const {
      intents: [intent],
      ...input
    } = createRun("auto_live", binding);
    const fetchImpl = vi.fn<typeof fetch>();
    const deps = {
      now: sessionNow,
      fetchImpl,
      readCredential: async () => credential,
    };
    const errorSummary =
      "live_venue_not_configured：请先配置实盘桥接地址与鉴权凭证";

    expect(await executePipelineRun({ ...input, deps }, db)).toMatchObject({
      stage: "failed",
    });
    expect(listIntentsByRun(input.runId, db)).toMatchObject([
      { id: intent!.id, status: "rejected", errorSummary },
    ]);
    await expect(
      resolveVenueAdapter(binding, deps).readAccountState(
        binding,
        executeDate,
        db,
      ),
    ).rejects.toThrow(errorSummary);
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);

it.each([
  {
    binding: { ...broker, endpointUrl: "https://broker.example.invalid" },
    order: buyB,
    auth: { token: "bridge-token" },
  },
  {
    binding: crypto,
    order: buyBitcoin,
    auth: { apiKey: "spot-key", apiSecret: "spot-secret" },
  },
])(
  "$binding.kind 在认领后读取凭证期间关闭实盘总开关时拒单且不联网",
  async ({ binding, order, auth }) => {
    setGlobalAutoLiveEnabled(true, db);
    const {
      intents: [intent],
      ...input
    } = createRun("auto_live", binding, [order]);
    const fetchImpl = vi.fn<typeof fetch>();
    const readCredential = vi.fn(async () => {
      expect(listIntentsByRun(input.runId, db)).toMatchObject([
        { status: "submitting" },
      ]);
      await Promise.resolve();
      setGlobalAutoLiveEnabled(false, db);
      return auth;
    });

    expect(
      await executePipelineRun(
        { ...input, deps: { now: sessionNow, fetchImpl, readCredential } },
        db,
      ),
    ).toEqual({
      skipped: true,
      reason: "live-kill-switch-off",
    });
    expect(readCredential).toHaveBeenCalledTimes(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(listIntentsByRun(input.runId, db)).toMatchObject([
      {
        id: intent!.id,
        status: "rejected",
        errorSummary: "live-kill-switch-off",
      },
    ]);
  },
);

it("resolveVenueAdapter 只向已注册的实盘适配器转发仍处于认领态的委托", async () => {
  setGlobalAutoLiveEnabled(true, db);
  const {
    intents: [intent],
  } = createRun("auto_live", broker);
  const custom = mockVenue(broker.kind);
  registerVenue(broker, custom);
  const routed = resolveVenueAdapter(broker, { now: sessionNow });
  const context = { executeDate, executePrice: 10, db };

  expect(routed).toMatchObject({ kind: broker.kind, isLive: true });
  for (const status of [
    "planned",
    "queued",
    "unknown_reconcile",
    "submitting",
  ] as const) {
    expect(
      await routed.submitOrder({ ...intent!, status }, context),
    ).toMatchObject({
      status: "rejected",
      errorSummary: "intent-not-claimed",
    });
  }
  expect(custom.submitOrder).not.toHaveBeenCalled();
  const claim = claimIntentForSubmission(intent!.id, sessionNow(), db);
  if (!claim.claimed) throw new Error(claim.reason);
  expect(
    await routed.submitOrder({ ...claim.intent, quantity: 200 }, context),
  ).toMatchObject({
    status: "filled",
    filledQuantity: 100,
    venueOrderId: `venue-${stockB}`,
  });
  transitionIntentStatus(intent!.id, "unknown_reconcile", {}, db);
  expect(await routed.submitOrder(claim.intent, context)).toMatchObject({
    status: "rejected",
    errorSummary: "intent-not-claimed",
  });
  expect(custom.submitOrder).toHaveBeenCalledExactlyOnceWith(
    claim.intent,
    context,
  );
});

it("人工审批实盘意图也必须开启实盘总开关", async () => {
  const {
    intents: [intent],
    ...input
  } = createRun("manual_confirm", broker);
  const adapter = mockVenue(broker.kind);
  registerVenue(broker, adapter);
  const approval = {
    intentId: intent!.id,
    executeDate,
    deps: { now: sessionNow },
  };

  expect(await approveAndExecuteIntent(approval, db)).toEqual({
    skipped: true,
    reason: "live-kill-switch-off",
  });
  expect(adapter.submitOrder).not.toHaveBeenCalled();
  expect(listIntentsByRun(input.runId, db)).toEqual([intent]);
  setGlobalAutoLiveEnabled(true, db);
  expect(await approveAndExecuteIntent(approval, db)).toMatchObject({
    stage: "completed",
  });
  expect(adapter.submitOrder).toHaveBeenCalledTimes(1);
});

it.each([
  { binding: broker, order: buyB, rollover: "2024-04-16T16:00:00.000Z" },
  { binding: crypto, order: buyBitcoin, rollover: "2024-04-17T00:00:00.000Z" },
  {
    binding: cryptoSim,
    order: buyBitcoin,
    rollover: "2024-04-17T00:00:00.000Z",
  },
])(
  "$binding.kind 在对应市场日历日跨日后拒绝认领历史意图",
  async ({ binding, order, rollover }) => {
    setGlobalAutoLiveEnabled(true, db);
    setGlobalAutoSimEnabled(true, db);
    const isSim = binding.kind === "crypto_sim";
    const {
      intents: [intent],
      ...input
    } = createRun(isSim ? "auto_sim" : "auto_live", binding, [order]);
    const adapter = mockVenue(binding.kind);
    if (!isSim) registerVenue(binding, adapter);
    const midnight = Date.parse(rollover);
    const deps = { cryptoSimAdapter: adapter, now: () => midnight };

    expect(await executePipelineRun({ ...input, deps }, db)).toEqual({
      skipped: true,
      reason: "execute-date-expired",
    });
    expect(adapter.submitOrder).not.toHaveBeenCalled();
    expect(listIntentsByRun(input.runId, db)).toEqual([intent]);
    expect(
      await executePipelineRun(
        { ...input, deps: { ...deps, now: () => midnight - 1 } },
        db,
      ),
    ).toMatchObject({ stage: "completed" });
    expect(adapter.submitOrder).toHaveBeenCalledTimes(1);
  },
);

const syntheticCredential = {
  token: "test-bridge-token",
  apiKey: "test-spot-key",
  apiSecret: "test-spot-secret",
  passphrase: "test-spot-passphrase",
};

it.each(Object.values(syntheticCredential))(
  "实盘回执中的凭证子串不会写入委托证据 (%s)",
  async (secret) => {
    setGlobalAutoLiveEnabled(true, db);
    const { runId } = createRun("auto_live", broker);
    const adapter = mockVenue(broker.kind);
    const echo = {
      venueOrderId: `order-${secret}-123`,
      errorSummary: `remote echoed ${secret} in a receipt`,
    };
    adapter.submitOrder.mockResolvedValueOnce({
      status: "submitted",
      filledQuantity: null,
      averageFillPrice: null,
      ...echo,
    });
    adapter.reconcileOrder.mockResolvedValueOnce({
      status: "filled",
      filledQuantity: 100,
      averageFillPrice: 10,
      ...echo,
    });
    registerVenue(broker, adapter);
    const deps = {
      now: sessionNow,
      readCredential: async () => syntheticCredential,
    };

    await executePipelineRun({ runId, executeDate, deps }, db);
    expect(listIntentsByRun(runId, db)).toMatchObject([
      { status: "submitted", venueOrderId: null, errorSummary: null },
    ]);
    expect(await reconcilePendingIntents({ runId, deps }, db)).toEqual({
      queried: 1,
    });
    expect(listIntentsByRun(runId, db)).toMatchObject([
      { status: "filled", venueOrderId: null, errorSummary: null },
    ]);
  },
);

it.each(["a".repeat(129), "bridge/order\n", "order-bridge-token-123"])(
  "丢弃超长、含非法字符或回显凭证的桥接委托号",
  async (venueOrderId) => {
    setGlobalAutoLiveEnabled(true, db);
    const { runId } = createRun("auto_live", {
      ...broker,
      endpointUrl: "https://broker.example.invalid",
    });
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({
        status: "submitted",
        venueOrderId,
        filledQuantity: null,
        averageFillPrice: null,
      }),
    );
    const deps = {
      now: sessionNow,
      fetchImpl,
      readCredential: async () => "bridge-token",
    };

    await executePipelineRun({ runId, executeDate, deps }, db);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(listIntentsByRun(runId, db)).toMatchObject([
      { status: "submitted", venueOrderId: null },
    ]);
  },
);

it("shadow 即使开启两个总开关并明确批准也永不发单", async () => {
  setGlobalAutoSimEnabled(true, db);
  setGlobalAutoLiveEnabled(true, db);
  const {
    intents: [intent],
    ...input
  } = createRun("shadow", ths);
  const thsAdapter = mockVenue(ths.kind);
  const deps = { thsAdapter };
  const blocked = { skipped: true, reason: "shadow-mode" };

  expect(await executePipelineRun({ ...input, deps }, db)).toEqual(blocked);
  expect(
    await executePipelineRun({ ...input, manualApproved: true, deps }, db),
  ).toEqual(blocked);
  expect(
    await approveAndExecuteIntent(
      { intentId: intent!.id, executeDate, deps },
      db,
    ),
  ).toEqual(blocked);
  expect(thsAdapter.submitOrder).not.toHaveBeenCalled();
  expect(listIntentsByRun(input.runId, db)).toEqual([intent]);
});

it("manual_confirm 仅成交明确批准的意图，同一 run 的其他买单保持 planned", async () => {
  setGlobalAutoSimEnabled(true, db);
  const {
    intents: [approved, other],
    ...input
  } = createRun("manual_confirm", ths, [buyB, { ...buyB, symbol: stockA }]);
  const thsAdapter = mockVenue(ths.kind);
  const deps = { thsAdapter };

  expect(await executePipelineRun({ ...input, deps }, db)).toEqual({
    skipped: true,
    reason: "manual-approval-required",
  });
  expect(thsAdapter.submitOrder).not.toHaveBeenCalled();
  expect(
    await approveAndExecuteIntent(
      { intentId: approved!.id, executeDate, deps },
      db,
    ),
  ).toMatchObject({ skipped: false, stage: "executing" });
  expect(thsAdapter.submitOrder).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ id: approved!.id, status: "submitting" }),
    expect.objectContaining({ executeDate }),
  );
  const intents = listIntentsByRun(input.runId, db);
  expect(intents.find(({ id }) => id === approved!.id)).toMatchObject({
    status: "filled",
    filledQuantity: 100,
    venueOrderId: `venue-${stockB}`,
  });
  expect(intents.find(({ id }) => id === other!.id)).toEqual(other);
});

const openingQuote: PipelineQuoteSnapshot = {
  symbol: stockB,
  openPrice: 10,
  lastPrice: 10,
  prevClose: 10,
  upperLimit: 11,
  lowerLimit: 9,
  suspended: false,
};

it.each([
  {
    name: "开盘跳空超过 maxGapPct",
    quote: { openPrice: 10.21, lastPrice: 10.21 },
    reason: "开盘向上跳空超过风控上限",
  },
  { name: "最新价触及涨停", quote: { lastPrice: 11 }, reason: "买入触及涨停" },
  { name: "标的停牌", quote: { suspended: true }, reason: "标的停牌" },
])("$name 时拒绝 BUY 并持久化审计证据", async ({ quote, reason }) => {
  setGlobalAutoSimEnabled(true, db);
  const {
    intents: [intent],
    ...input
  } = createRun("auto_sim", ths);
  const thsAdapter = mockVenue(ths.kind);
  const readQuote = vi.fn(() => ({ ...openingQuote, ...quote }));

  expect(
    await executePipelineRun({ ...input, deps: { thsAdapter, readQuote } }, db),
  ).toMatchObject({ skipped: false, stage: "failed" });
  expect(readQuote).toHaveBeenCalledExactlyOnceWith(stockB, executeDate);
  expect(thsAdapter.submitOrder).not.toHaveBeenCalled();
  expect(listIntentsByRun(input.runId, db)).toMatchObject([
    {
      id: intent!.id,
      status: "rejected",
      errorSummary: expect.stringContaining(reason),
      filledQuantity: null,
      averageFillPrice: null,
      venueOrderId: null,
    },
  ]);
  const audit = auditFor(intent!);
  expect(audit).toContainEqual(
    expect.objectContaining({
      intentId: intent!.id,
      eventType: "intent_status_changed",
      details: expect.objectContaining({ from: "planned", to: "rejected" }),
    }),
  );
  expect(audit.map(({ eventType }) => eventType)).not.toContain(
    "intent_claimed",
  );
});
