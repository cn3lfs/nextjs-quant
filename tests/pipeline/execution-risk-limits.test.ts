import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createDeployment,
  setGlobalAutoSimEnabled,
} from "~/server/db/deployment-repository";
import { migrate } from "~/server/db/migrations";
import type { VenueBinding } from "trading-strategies";
import { SimAccountRepository } from "~/server/db/sim-account-repository";
import { executePipelineSimOrder } from "~/server/portfolio/sim-accounts/service";
import {
  getOrCreatePipelineRun,
  insertOrderIntents,
  listExecutionAuditEvents,
  listIntentsByRun,
  transitionIntentStatus,
} from "~/server/db/pipeline-repository";
import { executePipelineRun } from "~/server/execution/pipeline-executor";
import type { ExecutionVenueAdapter } from "~/server/execution/venue-router";
import {
  planOrderIntents,
  runPipelinePlanning,
  type PipelineAccountState,
} from "~/server/pipeline/signal-risk-runner";

const A = "sh600001",
  B = "sh600002";
const decisionDate = "2024-04-30",
  executeDate = "2024-05-06";
const clock = Date.parse(executeDate + "T09:35:00+08:00");
const binding = { kind: "ths_mock", accountTag: "default" } as const;
let db: Database.Database;
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  setGlobalAutoSimEnabled(true, db);
});
afterEach(() => db.close());

function deploy(
  id: string,
  maxSymbolWeight = 0.2,
  venueBinding: VenueBinding = binding,
  maxTotalExposure = 0.95,
) {
  return createDeployment(
    {
      id,
      name: id,
      market: "cn-equity",
      status: "active",
      executionMode: "auto_sim",
      strategySpec: { kind: "macro-clock" },
      universeSpec: { kind: "fixed-symbols", symbols: [A] },
      regimeGate: { kind: "none", unlockAvoidanceDays: 0 },
      riskPolicy: { maxSymbolWeight, maxTotalExposure },
      venueBinding,
      schedule: { kind: "manual_only" },
      provenance: { sourceKind: "manual" },
    },
    db,
  );
}
function order(
  deploymentId: string,
  symbol: string,
  quantity: number,
  venueKind: VenueBinding["kind"] = binding.kind,
) {
  const { run } = getOrCreatePipelineRun(
    { deploymentId, decisionDate, executeDate, triggerKind: "manual" },
    db,
  );
  return insertOrderIntents(
    run.id,
    [
      {
        deploymentId,
        runId: run.id,
        venueKind,
        phase: 2,
        side: "BUY",
        symbol,
        quantity,
        referencePrice: 10,
      },
    ],
    db,
  )[0]!;
}
const position = (symbol: string, quantity: number, lastPrice: number) => ({
  symbol,
  quantity,
  sellable: quantity,
  lastPrice,
});
const executionCalendar = {
  session: async () => true,
  nextConfirmedSession: async () => executeDate,
};
function quote(symbol: string, price: number) {
  return {
    symbol,
    tradeDate: executeDate,
    observedAt: clock,
    lastPrice: price,
    openPrice: price,
    prevClose: price,
    upperLimit: price + 1,
    lowerLimit: price - 1,
    suspended: false,
  };
}
function plan(
  deploymentId: string,
  state: PipelineAccountState,
  weight: number,
) {
  return runPipelinePlanning(
    {
      deploymentId,
      decisionDate,
      executeDate,
      triggerKind: "manual",
      deps: {
        readAccountState: () => state,
        readReferencePrice: () => 10,
        universe: { readBars: () => [] },
        strategy: {
          readTradingSessions: () => ["2024-04-29", decisionDate, executeDate],
          resolveMacroClock: () => ({
            regime: "recovery",
            targets: { [A]: weight },
          }),
        },
      },
    },
    db,
  );
}

it.each([
  { status: "submitted", acknowledged: true, expected: 500 },
  { status: "partial_filled", acknowledged: true, expected: 500 },
  { status: "submitted", acknowledged: false, expected: 500 },
  { status: "unknown_reconcile", acknowledged: true, expected: 100 },
] as const)(
  "外部 $status 回执=$acknowledged，可用现金已冻结部分只计一次，仍按剩余委托计算行业敞口",
  async ({ status, acknowledged, expected }) => {
    const dep = deploy("strategy");
    const peer = order(
      deploy("other").id,
      B,
      status === "partial_filled" ? 600 : 500,
    );
    transitionIntentStatus(peer.id, "submitting", {}, db);
    transitionIntentStatus(
      peer.id,
      status,
      {
        venueOrderId: acknowledged ? "venue-order" : null,
        ...(status === "partial_filled" && {
          filledQuantity: 100,
          averageFillPrice: 10,
        }),
      },
      db,
    );
    // Industry cap 25,000 less 15,000 held and 5,000 pending permits exactly 500 shares.
    const result = await plan(
      dep.id,
      {
        cash: 6500,
        equity: 100000,
        drawdownPct: 0,
        positions: [position(B, 1500, 10)],
      },
      0.5,
    );
    expect(result.intents).toMatchObject([{ symbol: A, quantity: expected }]);
    expect(result.run.riskVerdict).toMatchObject({
      theoreticalOrders: [
        {
          symbol: A,
          side: "BUY",
          theoreticalQuantity: 5000,
          referencePrice: 10,
        },
      ],
      clipped: [{ reasons: expect.arrayContaining(["industry_cap"]) }],
    });
  },
);

it("账户回撤完全拦截时，冻结可独立复算的理论股数和决策价", async () => {
  const result = await plan(
    deploy("halted").id,
    { cash: 100000, equity: 100000, drawdownPct: 0.15, positions: [] },
    0.5,
  );
  expect(result.intents).toEqual([]);
  expect(result.run.riskVerdict).toMatchObject({
    theoreticalOrders: [
      { symbol: A, side: "BUY", theoreticalQuantity: 5000, referencePrice: 10 },
    ],
    skipped: [{ symbol: A, reason: "drawdown_pause" }],
  });
});

it("方向信号按部署本身定义的仓位计理论数量，共用账户的更严单票上限只影响可执行数量", async () => {
  const deployment = deploy("directional", 0.2);
  const result = await planOrderIntents({
    deployment,
    accountCaps: { symbol: 0.1, total: 1 },
    run: { id: "test", decisionDate, executeDate },
    proposal: {
      asOf: decisionDate,
      mode: "delta-signals",
      targets: {},
      regimeScale: null,
      disclosure: "",
      signals: [
        {
          symbol: A,
          action: "BUY",
          score: null,
          stopPrice: null,
          targetPrice: null,
          reason: "entry",
        },
      ],
    },
    accountState: {
      cash: 100000,
      equity: 100000,
      drawdownPct: 0,
      positions: [],
    },
    ownerPositions: [],
    regimeVerdict: {
      status: "allow",
      scale: 1,
      allowNewEntries: true,
      reasons: [],
      details: {},
    },
    deps: { readReferencePrice: () => 10 },
  });
  expect(result.riskVerdict.theoreticalOrders).toEqual([
    { symbol: A, side: "BUY", theoreticalQuantity: 2000, referencePrice: 10 },
  ]);
  expect(result.intents).toMatchObject([{ symbol: A, quantity: 1000 }]);
});

it.each([
  {
    label: "单标的",
    held: A,
    heldQty: 200,
    peerSymbol: A,
    planned: 1700,
    expected: 1600,
    reason: "instrument_cap",
  },
  {
    label: "行业",
    held: B,
    heldQty: 2300,
    peerSymbol: B,
    planned: 100,
    expected: 0,
    reason: "industry_cap",
  },
])(
  "上涨 2% 后重新计算 $label 额度，计入其他委托并排除本单，可买 $expected 股",
  async ({ held, heldQty, peerSymbol, planned, expected, reason }) => {
    const dep = deploy("strategy");
    const i = order(dep.id, A, planned);
    order(deploy("other").id, peerSymbol, 100);
    const submitOrder = vi.fn<ExecutionVenueAdapter["submitOrder"]>(
      async (intent) => ({
        status: "submitted",
        venueOrderId: intent.id,
        filledQuantity: null,
        averageFillPrice: null,
      }),
    );
    const adapter: ExecutionVenueAdapter = {
      kind: "ths_mock",
      isLive: false,
      cnBuyStep: 100,
      readAccountState: async () => ({
        equity: 100000,
        cash: 70000,
        drawdownPct: null,
        positions: [position(held, heldQty, held === A ? 10.2 : 10)],
      }),
      submitOrder,
      reconcileOrder: vi.fn(),
      cancelOrder: vi.fn(),
    };
    await executePipelineRun(
      {
        runId: i.runId,
        executeDate,
        deps: {
          now: () => clock,
          thsAdapter: adapter,
          executionCalendar,
          readQuote: (symbol) => quote(symbol, 10.2),
        },
      },
      db,
    );
    expect(submitOrder.mock.calls.map(([intent]) => intent.quantity)).toEqual(
      expected ? [expected] : [],
    );
    expect(listIntentsByRun(i.runId, db)[0]).toMatchObject(
      expected
        ? { status: "submitted", quantity: expected }
        : { status: "rejected", errorSummary: reason },
    );
    expect(
      listExecutionAuditEvents({ deploymentId: dep.id, runId: i.runId }, db)
        .items,
    ).toContainEqual(
      expect.objectContaining({
        eventType: "execution_risk_limit",
        details: expect.objectContaining({
          reason,
          quantity: expected,
          plannedQuantity: planned,
          executePrice: 10.2,
        }),
      }),
    );
  },
);

it.each([
  {
    sale: "rejected",
    held: A,
    heldQty: 1600,
    price: 10,
    totalCap: 0.95,
    // 1,600 held + 100 in flight + 300 new would reach 20% before fees.
    expected: 200,
    reason: "instrument_cap",
  },
  {
    sale: "cancelled",
    held: B,
    heldQty: 2200,
    price: 9,
    totalCap: 0.95,
    expected: 200,
    reason: "industry_cap",
  },
  {
    sale: "rejected",
    held: B,
    heldQty: 1600,
    price: 9,
    totalCap: 0.18,
    expected: 100,
    reason: "total_exposure_cap",
  },
  {
    sale: "cancelled",
    held: B,
    heldQty: 2400,
    price: 10,
    totalCap: 0.95,
    expected: 0,
    reason: "industry_cap",
  },
] as const)(
  "卖单 $sale 后按实仓和在途重验，执行价 $price 时由 $reason 限至 $expected 股",
  async ({ sale, held, heldQty, price, totalCap, expected, reason }) => {
    const dep = deploy("strategy", 0.2, binding, totalCap);
    const buy = order(dep.id, A, 1000);
    const [sell] = insertOrderIntents(
      buy.runId,
      [
        {
          deploymentId: dep.id,
          runId: buy.runId,
          venueKind: binding.kind,
          phase: 1,
          side: "SELL",
          symbol: held,
          quantity: 300,
          referencePrice: 10,
        },
      ],
      db,
    );
    if (sale === "cancelled") {
      transitionIntentStatus(sell!.id, "submitting", {}, db);
      transitionIntentStatus(
        sell!.id,
        "partial_filled",
        {
          filledQuantity: 100,
          averageFillPrice: 10,
          venueOrderId: "partial-sale",
        },
        db,
      );
    }
    transitionIntentStatus(sell!.id, sale, {}, db);
    const peer = order(deploy("peer").id, held, 100);
    transitionIntentStatus(peer.id, "submitting", {}, db);
    transitionIntentStatus(
      peer.id,
      "submitted",
      { venueOrderId: "pending-buy" },
      db,
    );
    const readAccountState = vi.fn(async () => ({
      equity: 100000,
      cash: 100000 - heldQty * 10 - 1000,
      drawdownPct: 0,
      positions: [position(held, heldQty, 10)],
    }));
    const submitOrder = vi.fn<ExecutionVenueAdapter["submitOrder"]>(
      async (intent) => ({
        status: "submitted",
        venueOrderId: intent.id,
        filledQuantity: null,
        averageFillPrice: null,
      }),
    );
    await executePipelineRun(
      {
        runId: buy.runId,
        executeDate,
        deps: {
          now: () => clock,
          readQuote: (symbol) => quote(symbol, price),
          executionCalendar,
          thsAdapter: {
            kind: binding.kind,
            isLive: false,
            cnBuyStep: 100,
            readAccountState,
            submitOrder,
            reconcileOrder: vi.fn(),
            cancelOrder: vi.fn(),
          },
        },
      },
      db,
    );
    expect(readAccountState).toHaveBeenCalledTimes(1);
    expect(submitOrder.mock.calls.map(([i]) => i.quantity)).toEqual(
      expected ? [expected] : [],
    );
    expect(
      listIntentsByRun(buy.runId, db).find((i) => i.id === buy.id),
    ).toMatchObject(
      expected
        ? { status: "submitted", quantity: expected }
        : { status: "rejected", errorSummary: reason },
    );
    expect(
      listExecutionAuditEvents({ runId: buy.runId, deploymentId: dep.id }, db)
        .items,
    ).toContainEqual(
      expect.objectContaining({
        eventType: "execution_risk_limit",
        details: expect.objectContaining({
          reason,
          quantity: expected,
          executePrice: price,
        }),
      }),
    );
  },
);

it("10 万元本地账户在 10% 单票上限处扣费后缩一手，实际成交仍合规", async () => {
  const accountId = "fee-cap-local";
  const repo = new SimAccountRepository(db);
  repo.open(accountId, accountId, "cn-equity", 10000000n, clock);
  const local = { kind: "local_sim", simAccountId: accountId } as const;
  const dep = deploy("fee-cap", 0.1, local);
  const buy = order(dep.id, A, 1000, local.kind);

  await executePipelineRun(
    {
      runId: buy.runId,
      executeDate,
      deps: {
        now: () => clock,
        executionCalendar,
        readQuote: () => quote(A, 10),
      },
    },
    db,
  );

  expect(listIntentsByRun(buy.runId, db)[0]).toMatchObject({
    status: "filled",
    quantity: 900,
    filledQuantity: 900,
  });
  const equity = Number(repo.account(accountId).cash_atoms) / 100 + 9000;
  expect(equity).toBeLessThan(100000);
  expect(9000 / equity).toBeLessThanOrEqual(0.1);
});

it("本地账户以执行当刻对其他持仓重新估值，行业限额只允许实际成交 1100 股", async () => {
  const accountId = "cap-local";
  const at = Date.parse(decisionDate + "T09:35:00+08:00");
  new SimAccountRepository(db).open(
    accountId,
    accountId,
    "cn-equity",
    10000000n,
    at,
  );
  executePipelineSimOrder(
    {
      accountId,
      clientRequestId: "held",
      symbol: B,
      side: "buy",
      quantity: 1000,
      price: 10,
      tradeDate: decisionDate,
    },
    db,
    at,
  );
  const local = { kind: "local_sim", simAccountId: accountId } as const;
  const dep = deploy("local", 0.2, local);
  const i = order(dep.id, A, 1200, local.kind);
  const readQuote = vi.fn((s: string) => quote(s, s === B ? 15 : 10.2));
  await executePipelineRun(
    {
      runId: i.runId,
      executeDate,
      deps: { now: () => clock, executionCalendar, readQuote },
    },
    db,
  );
  expect(readQuote.mock.calls.map(([symbol]) => symbol)).toEqual([A, B]);
  expect(listIntentsByRun(i.runId, db)[0]).toMatchObject({
    status: "filled",
    quantity: 1100,
    filledQuantity: 1100,
  });
});
