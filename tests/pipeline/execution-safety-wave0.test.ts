import * as vault from "~/server/vault";
import * as gfCalendar from "~/server/data-sources/gf/gf-calendar";
import * as tradeLedger from "~/server/portfolio/trade-ledger-service";
import * as mockService from "~/server/portfolio/mock/mock-trading-service";
import { fetch as mockTransport } from "undici";
vi.mock(import("undici"), async (original) => ({
  ...(await original()),
  fetch: vi.fn(),
}));
import Database from "better-sqlite3";
import { beforeEach, afterEach, it, vi, expect } from "vitest";
import type { VenueBinding } from "trading-strategies";
import {
  createDeployment,
  setGlobalAutoSimEnabled,
  setGlobalAutoLiveEnabled,
} from "~/server/db/deployment-repository";
import {
  getOrCreatePipelineRun,
  insertOrderIntents,
  listIntentsByRun,
  listExecutionAuditEvents,
  transitionIntentStatus,
} from "~/server/db/pipeline-repository";
import { listFillLinksByIntentIds } from "~/server/db/execution-fill-link-repository";
import {
  listOwnerSleeveHoldings,
  upsertSleeveHolding,
} from "~/server/db/sleeve-holding-repository";
import { migrate } from "~/server/db/migrations";
import { createSimAccount } from "~/server/portfolio/sim-accounts/service";
import { tickPipelineScheduler } from "~/server/pipeline/pipeline-scheduler";
import {
  executePipelineRun,
  reconcilePendingIntents,
} from "~/server/execution/pipeline-executor";
import { createPipelineQuoteReader } from "~/server/execution/pipeline-quote-provider";
import type { ExecutionVenueAdapter } from "~/server/execution/venue-router";

const date = "2024-04-16";
const clock = Date.parse(date + "T09:35:00+08:00");
const ths = { kind: "ths_mock", accountTag: "default" } as const;
let db: Database.Database;
let fixtureNumber = 0;
beforeEach(() => {
  vi.spyOn(gfCalendar, "gfCalendarReference").mockResolvedValue({
    days: ["2024-04-15", date],
    source: "fixture",
    hash: null,
  });
  db = new Database(":memory:");
  migrate(db);
  setGlobalAutoSimEnabled(true, db);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
});
afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  vi.unstubAllGlobals();
});
const buy = {
  symbol: "sh600002",
  side: "BUY",
  phase: 2,
  quantity: 100,
  referencePrice: 10,
} as const;
const sell = { ...buy, symbol: "sh600001", side: "SELL", phase: 1 } as const;
const thsOwner = (ownerId: string) =>
  ({
    accountScope: "ths_mock",
    accountId: ths.accountTag,
    ownerKind: "deployment",
    ownerId,
  }) as const;
function seed(
  binding: VenueBinding,
  orders: Array<{
    symbol: string;
    quantity: number;
    side: "BUY" | "SELL";
    phase: 1 | 2;
    referencePrice: number;
  }> = [buy],
) {
  const dep = createDeployment(
    {
      name: "执行安全 " + ++fixtureNumber,
      market: binding.kind === "crypto_live" ? "crypto" : "cn-equity",
      status: "active",
      executionMode: binding.kind === "crypto_live" ? "auto_live" : "auto_sim",
      strategySpec: { kind: "study-rule", strategyId: "breakout" },
      universeSpec: { kind: "fixed-symbols", symbols: [buy.symbol] },
      regimeGate: { kind: "none" },
      riskPolicy: { maxGapPct: 0.02 },
      venueBinding: binding,
      schedule:
        binding.kind === "crypto_live"
          ? { kind: "manual_only" }
          : {
              kind: "post_close_auto",
              openStartTime: "09:30",
              openCutoffTime: "09:40",
            },
      provenance: { sourceKind: "manual" },
    },
    db,
  );
  const { run } = getOrCreatePipelineRun(
    {
      deploymentId: dep.id,
      decisionDate: "2024-04-15",
      executeDate: date,
      triggerKind: "scheduled",
    },
    db,
  );
  const intents = insertOrderIntents(
    run.id,
    orders.map((o) => ({
      ...o,
      deploymentId: dep.id,
      runId: run.id,
      venueKind: binding.kind,
    })),
    db,
  );
  return { runId: run.id, executeDate: date, intents };
}
function sim(capital: string) {
  const { id } = createSimAccount(
    {
      market: "cn-equity",
      name: "波次零 " + ++fixtureNumber,
      initialCapital: capital,
    },
    db,
  );
  return { kind: "local_sim", simAccountId: id } as const;
}
const fundedAccount = {
  cash: 100000,
  equity: 100000,
  positions: [],
  drawdownPct: 0,
};

function venue() {
  return {
    kind: "ths_mock",
    isLive: false,
    readAccountState: vi
      .fn<ExecutionVenueAdapter["readAccountState"]>()
      .mockResolvedValue(fundedAccount),
    submitOrder: vi.fn<ExecutionVenueAdapter["submitOrder"]>(
      async (i, ctx) => ({
        status: "filled",
        venueOrderId: i.id,
        fillId: "trade",
        filledQuantity: i.quantity,
        averageFillPrice: ctx.executePrice,
      }),
    ),
    reconcileOrder: vi.fn<ExecutionVenueAdapter["reconcileOrder"]>(),
    cancelOrder: vi.fn<ExecutionVenueAdapter["cancelOrder"]>(),
  } satisfies ExecutionVenueAdapter;
}
const readQuote = (symbol: string) => ({
  symbol,
  tradeDate: date,
  observedAt: clock,
  lastPrice: 10,
  openPrice: 10,
  prevClose: 10,
  upperLimit: 11,
  lowerLimit: 9,
  suspended: false,
});
function quotes({
  seconds = 0,
  state = "00",
  limit = 1100,
  missing = false,
  volume = 100,
  day = date,
}: {
  seconds?: number;
  state?: string;
  limit?: number | null;
  missing?: boolean;
  volume?: number;
  day?: string;
} = {}) {
  const stateRow = Array<string>(33).fill("");
  stateRow[30] = date;
  stateRow[31] = "09:35:00";
  stateRow[32] = state;
  const spy = vi.fn<typeof fetch>(async (input, init) => {
    if (init?.method && init.method !== "GET")
      throw new Error("unexpected submission");
    const url = new URL(String(input));
    if (url.hostname === "hq.sinajs.cn")
      return new Response('var hq_str_sh600002="' + stateRow.join(",") + '";');
    if (url.hostname !== "push2.eastmoney.com")
      throw new Error("unexpected host");
    return Response.json({
      data: missing
        ? null
        : {
            f57: "600002",
            f107: 1,
            f59: 2,
            f86: Date.parse(day + "T09:35:00+08:00") / 1000 - seconds,
            f43: 1020,
            f46: 1020,
            f47: volume,
            f60: 1000,
            f51: limit,
            f52: 900,
          },
    });
  });
  vi.stubGlobal("fetch", spy);
  return spy;
}
it.each([
  [{ missing: true }, "missing-execution-quote"],
  [{ volume: 0 }, "missing-execution-quote"],
  [{ seconds: 301 }, "stale-execution-quote"],
  [{ day: "2024-04-15" }, "execution-quote-date-mismatch"],
  [{ state: "02" }, "suspended"],
  [{ limit: null }, "missing-limit-bounds"],
] as const)("默认报价拒绝无效行情 %j，零提交零成交", async (data, reason) => {
  const fetcher = quotes(data);
  const adapter = venue();
  const run = seed(ths);
  await executePipelineRun(
    { ...run, deps: { now: () => clock, thsAdapter: adapter } },
    db,
  );
  expect(fetcher).toHaveBeenCalled();
  expect(listIntentsByRun(run.runId, db)[0]).toMatchObject({
    status: "rejected",
    errorSummary: reason,
    filledQuantity: null,
  });
  expect(adapter.submitOrder).not.toHaveBeenCalled();
  expect(
    listFillLinksByIntentIds(
      run.intents.map((i) => i.id),
      db,
    ),
  ).toEqual([]);
});

it("正常开盘调度按 10.20 原价成交，两账户同号成交各自只关联一次", async () => {
  quotes();
  // 100 × 10.20 must fit the 20% execution-time cap on each account.
  const runs = [seed(sim("6000")), seed(sim("6000"))];
  const tick = () =>
    tickPipelineScheduler(
      { now: clock, deps: { isTradingDay: () => true } },
      db,
    );
  expect(await tick()).toMatchObject({ executedRuns: 2, failures: [] });
  await tick();
  for (const run of runs) {
    await reconcilePendingIntents(run, db);
    const [intent] = listIntentsByRun(run.runId, db);
    expect(intent).toMatchObject({
      referencePrice: 10,
      status: "filled",
      filledQuantity: 100,
      averageFillPrice: 10.2,
    });
    const links = listFillLinksByIntentIds([intent!.id], db);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      arrivalPrice: 10.2,
      intentId: intent!.id,
      venueOrderId: intent!.venueOrderId,
      fillSource: "sim_fills",
      accountScope: "local_sim",
    });
  }
  expect(db.prepare("SELECT count(*) n FROM sim_fills").get()).toEqual({
    n: 2,
  });
});

it("同一运行第一笔耗时跨窗，第二笔保留 planned 且无认领审计", async () => {
  let now = clock;
  const run = seed(ths, [buy, { ...buy, symbol: "sh600003" }]);
  const adapter = venue();
  adapter.submitOrder.mockImplementationOnce(async (i) => {
    now = Date.parse(date + "T09:41:00+08:00");
    return {
      status: "submitted",
      venueOrderId: i.id,
      filledQuantity: null,
      averageFillPrice: null,
    };
  });
  adapter.reconcileOrder.mockImplementation(async (i) => ({
    status: "submitted",
    venueOrderId: i.venueOrderId,
    filledQuantity: null,
    averageFillPrice: null,
  }));
  await tickPipelineScheduler(
    {
      deps: {
        now: () => now,
        isTradingDay: () => true,
        readQuote,
        thsAdapter: adapter,
      },
    },
    db,
  );
  expect(adapter.submitOrder).toHaveBeenCalledTimes(1);
  expect(
    listIntentsByRun(run.runId, db)
      .map((i) => i.status)
      .sort(),
  ).toEqual(["planned", "submitted"]);
  const blocked = await executePipelineRun(
    {
      ...run,
      deps: {
        executionWindowCheck: () => false,
        readQuote,
        thsAdapter: adapter,
      },
    },
    db,
  );
  expect(blocked).toEqual({ skipped: true, reason: "execution-window-closed" });
  adapter.reconcileOrder.mockResolvedValue({
    status: "filled",
    venueOrderId: adapter.submitOrder.mock.calls[0]![0].id,
    fillId: "late-fill",
    filledQuantity: 100,
    averageFillPrice: 10,
  });
  expect(
    await reconcilePendingIntents(
      { runId: run.runId, deps: { thsAdapter: adapter } },
      db,
    ),
  ).toEqual({ queried: 1 });
  expect(
    listFillLinksByIntentIds(
      run.intents.map((i) => i.id),
      db,
    ),
  ).toHaveLength(1);
});

it.each([
  ["2011.00", 200],
  ["1005.49", 0],
] as const)(
  "卖单无回款，可用资金 %s 精确支付 %i 股含费用，执行仍受单票上限约束",
  async (capital, quantity) => {
    const run = seed(sim(capital), [sell, { ...buy, quantity: 300 }]);
    await executePipelineRun(
      { ...run, deps: { now: () => clock, readQuote } },
      db,
    );
    const [sold, bought] = listIntentsByRun(run.runId, db);
    expect(sold?.status).toBe("rejected");
    if (quantity) {
      expect(bought).toMatchObject({
        status: "rejected",
        errorSummary: "instrument_cap",
        filledQuantity: null,
      });
      expect(
        listExecutionAuditEvents(
          { deploymentId: bought!.deploymentId, runId: run.runId },
          db,
        ).items,
      ).toContainEqual(
        expect.objectContaining({
          eventType: "buy_quantity_resized_after_sell",
          details: expect.objectContaining({
            plannedQuantity: 300,
            quantity,
            realizedSellProceeds: 0,
          }),
        }),
      );
    } else
      expect(bought).toMatchObject({
        status: "rejected",
        errorSummary: "insufficient-realized-proceeds",
        filledQuantity: null,
      });
  },
);

it("卖单部分成交后撤单，未到账部分扣一次，后续买单不能重用已占预算", async () => {
  const run = seed(ths, [
    { ...sell, quantity: 300 },
    { ...buy, quantity: 200 },
    { ...buy, symbol: "sh600003", quantity: 200 },
  ]);
  const adapter = venue();
  adapter.readAccountState.mockResolvedValue({
    ...fundedAccount,
    cash: 98000,
    positions: [
      { symbol: sell.symbol, quantity: 200, lastPrice: 10, sellable: 200 },
    ],
  });
  const sale = run.intents[0]!;
  transitionIntentStatus(sale.id, "submitting", {}, db);
  transitionIntentStatus(
    sale.id,
    "partial_filled",
    { venueOrderId: "sell", filledQuantity: 100, averageFillPrice: 10 },
    db,
  );
  const input = {
    ...run,
    deps: { readQuote, now: () => clock, thsAdapter: adapter },
  };
  await executePipelineRun(input, db);
  expect(adapter.submitOrder).not.toHaveBeenCalled();
  transitionIntentStatus(sale.id, "cancelled", {}, db);
  await executePipelineRun(input, db);
  expect(adapter.readAccountState).toHaveBeenCalled();
  expect(
    adapter.submitOrder.mock.calls.reduce((q, [i]) => q + i.quantity, 0),
  ).toBe(200);
  expect(
    listIntentsByRun(run.runId, db)
      .filter((i) => i.phase === 2)
      .map((i) => i.status)
      .sort(),
  ).toEqual(["filled", "rejected"]);
});

it("历史重放须显式配置，交易日不符的快照仍不可用", async () => {
  const fetcher = vi.fn<typeof fetch>();
  expect(
    await createPipelineQuoteReader({ now: () => clock + 86400000, fetcher })(
      buy.symbol,
      date,
    ),
  ).toBeNull();
  expect(fetcher).not.toHaveBeenCalled();
  const replay = createPipelineQuoteReader({
    now: () => clock + 86400000,
    historicalReplay: async (symbol) => ({
      ...readQuote(symbol),
      source: "fixture-raw-open",
    }),
  });
  const run = seed(sim("5100"));
  await executePipelineRun(
    { ...run, deps: { readQuote: replay, now: () => clock + 86400000 } },
    db,
  );
  expect(listIntentsByRun(run.runId, db)[0]?.status).toBe("filled");
  expect(await replay(buy.symbol, "2024-04-15")).toBeNull();
});

it("币种报价按 UTC 最新逐笔成交核时，昨日日线只提供前收", async () => {
  const utc = Date.parse(date);
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    expect(url.searchParams.get("symbol")).toBe("BTCUSDT");
    if (url.pathname.endsWith("/exchangeInfo"))
      return Response.json({
        symbols: [{ symbol: "BTCUSDT", status: "TRADING" }],
      });
    if (url.pathname.endsWith("/trades"))
      return Response.json([{ price: "63001", time: clock - 1000 }]);
    if (
      url.pathname.endsWith("/klines") &&
      url.searchParams.get("endTime") === String(utc - 1)
    )
      return Response.json([
        [
          utc - 86400000,
          "60000",
          "64000",
          "59999",
          "62800",
          "123",
          utc - 1,
          "7500000",
        ],
      ]);
    throw new Error("unexpected request");
  });
  const read = createPipelineQuoteReader({ now: () => clock, fetcher });
  expect(await read("cxBTCUSDT", date)).toMatchObject({
    symbol: "cxBTCUSDT",
    observedAt: clock - 1000,
    tradeDate: date,
    source: "binance-spot",
    lastPrice: 63001,
    prevClose: 62800,
  });
});

it.each([0, 100])(
  "已有 %i 股时，分次成交按边际价入仓，重复回报只关联一次",
  async (existing) => {
    const run = seed(ths);
    const owner = thsOwner(run.intents[0]!.deploymentId);
    if (existing)
      upsertSleeveHolding(
        {
          ...owner,
          symbol: buy.symbol,
          quantity: existing,
          avgEntryPrice: 8,
          entryDate: "2024-04-10",
        },
        db,
      );
    const adapter = venue();
    const evidence = {
      venueOrderId: "v",
      averageFillPrice: 10.125,
    };
    adapter.submitOrder.mockResolvedValue({
      status: "partial_filled",
      ...evidence,
      filledQuantity: 40,
      fillId: "a",
    });
    const deps = { now: () => clock, readQuote, thsAdapter: adapter };
    await executePipelineRun({ ...run, deps }, db);
    const entryDate = existing ? "2024-04-10" : date;
    expect(listOwnerSleeveHoldings(owner, db)).toMatchObject([
      {
        quantity: existing + 40,
        avgEntryPrice: (existing * 8 + 405) / (existing + 40),
        entryDate,
      },
    ]);
    adapter.reconcileOrder
      .mockResolvedValueOnce({
        status: "partial_filled",
        ...evidence,
        filledQuantity: 40,
        fillId: "a",
      })
      .mockResolvedValueOnce({
        status: "filled",
        ...evidence,
        filledQuantity: 100,
        averageFillPrice: 10.2,
        fillIds: ["a", "b"],
      });
    for (let n = 0; n < 3; n++)
      await reconcilePendingIntents({ runId: run.runId, deps }, db);
    // 40 @ 10.125 = 405. The next 60 cost 615, or 10.25 per share.
    const [holding] = listOwnerSleeveHoldings(owner, db);
    expect(holding).toMatchObject({ quantity: existing + 100, entryDate });
    expect(holding!.avgEntryPrice).toBeCloseTo(existing ? 9.1 : 10.2, 13);
    const deltas = listExecutionAuditEvents(
      { deploymentId: owner.ownerId, runId: run.runId },
      db,
    ).items.filter((event) => event.eventType === "sleeve_fill_delta");
    expect(deltas.map((event) => event.details)).toEqual([
      expect.objectContaining({ quantityDelta: 60, fillPrice: 10.25 }),
      expect.objectContaining({ quantityDelta: 40, fillPrice: 10.125 }),
    ]);
    const links = listFillLinksByIntentIds(
      run.intents.map((i) => i.id),
      db,
    );
    expect(links.map((link) => JSON.parse(link.fillId).at(-1)).sort()).toEqual([
      "a",
      "b",
    ]);
    expect(
      links.every(
        (link) => link.arrivalPrice === 10 && link.venueOrderId === "v",
      ),
    ).toBe(true);
  },
);

it("认领成功后到达截止时间，已认领的一笔明确拒绝且未调用通道", async () => {
  const run = seed(ths);
  const adapter = venue();
  // The clock advances exactly when the durable claim becomes visible.
  const check = () => listIntentsByRun(run.runId, db)[0]?.status === "planned";
  const deps = {
    now: () => clock,
    readQuote,
    thsAdapter: adapter,
    executionWindowCheck: check,
  };
  expect(await executePipelineRun({ ...run, deps }, db)).toEqual({
    skipped: true,
    reason: "execution-window-closed",
  });
  expect(adapter.submitOrder).not.toHaveBeenCalled();
  expect(listIntentsByRun(run.runId, db)[0]).toMatchObject({
    status: "rejected",
    errorSummary: "execution-window-closed",
  });
});

it.each(["okx", "bybit"] as const)(
  "使用所选 %s 交易场所自己的状态、成交时间和前收",
  async (venue) => {
    const day = Date.parse(date);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const u = new URL(String(input));
      const ok = venue === "okx";
      expect(u.hostname).toBe(ok ? "www.okx.com" : "api.bybit.com");
      const wrap = (rows: unknown[]) =>
        Response.json(
          ok
            ? { code: "0", data: rows }
            : { retCode: 0, result: { category: "spot", list: rows } },
        );
      if (u.pathname.includes("instruments"))
        return wrap([
          ok
            ? { instType: "SPOT", instId: "BTC-USDT", state: "live" }
            : { symbol: "BTCUSDT", status: "Trading" },
        ]);
      if (u.pathname.includes("trade"))
        return wrap([
          ok
            ? { instId: "BTC-USDT", ts: String(clock), px: "63001" }
            : { symbol: "BTCUSDT", time: String(clock), price: "63001" },
        ]);
      return wrap([
        [
          String(day - 86400000),
          "61000",
          "64000",
          "60500",
          "62500",
          "50",
          "3500000",
          "3500000",
          "1",
        ],
      ]);
    });
    const reader = createPipelineQuoteReader({
      venue,
      fetcher,
      now: () => clock,
    });
    expect(await reader("BTCUSDT", date)).toMatchObject({
      lastPrice: 63001,
      prevClose: 62500,
      source: venue + "-spot",
      observedAt: clock,
      suspended: false,
    });
  },
);

it("外部现金快照未刷新时，两笔买单合计不能超过首次确认的可用现金", async () => {
  const run = seed(ths, [
    sell,
    { ...buy, quantity: 300 },
    { ...buy, symbol: "sh600003", quantity: 300 },
  ]);
  transitionIntentStatus(run.intents[0]!.id, "rejected", {}, db);
  const adapter = venue();
  adapter.readAccountState.mockResolvedValue({
    cash: 2050,
    equity: 100000,
    positions: [],
    drawdownPct: null,
  });
  await executePipelineRun(
    { ...run, deps: { now: () => clock, thsAdapter: adapter, readQuote } },
    db,
  );
  expect(
    adapter.submitOrder.mock.calls.map(([order]) => order.quantity),
  ).toEqual([200]);
  expect(
    listIntentsByRun(run.runId, db).filter(
      (i) => i.errorSummary === "insufficient-realized-proceeds",
    ),
  ).toHaveLength(1);
});

it.each([date, "2024-04-17", null])(
  "交易所逐笔明细稍后可用，对账恢复真实成交号，首笔成交日为 %s",
  async (fillDate) => {
    setGlobalAutoLiveEnabled(true, db);
    const run = seed(
      { kind: "crypto_live", venue: "binance", accountId: "fixture" },
      [{ ...buy, symbol: "BTCUSDT", quantity: 1 }],
    );
    let clientId = "";
    let tradePolls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v3/account" && init?.method === "GET")
        return Response.json({
          canTrade: true,
          balances: [{ asset: "USDT", free: "10000", locked: "0" }],
        });
      if (url.pathname === "/api/v3/order" && init?.method === "POST") {
        clientId = url.searchParams.get("newClientOrderId")!;
        return Response.json({ clientOrderId: clientId, orderId: 123 });
      }
      if (url.pathname === "/api/v3/order" && init?.method === "GET")
        return Response.json({
          orderId: 123,
          clientOrderId: clientId,
          symbol: "BTCUSDT",
          side: "BUY",
          origQty: "1",
          status: "FILLED",
          executedQty: "1",
          cummulativeQuoteQty: "10",
        });
      if (url.pathname === "/api/v3/myTrades" && init?.method === "GET") {
        tradePolls++;
        return Response.json(
          tradePolls === 1
            ? []
            : [
                {
                  id: 999,
                  orderId: 123,
                  symbol: "BTCUSDT",
                  qty: "1",
                  isBuyer: true,
                  ...(fillDate && {
                    time: Date.parse(fillDate + "T00:00:04Z"),
                  }),
                },
              ],
        );
      }
      throw new Error("unexpected request");
    });
    const deps = {
      now: () => clock,
      readQuote,
      fetchImpl,
      readCredential: async () => ({
        apiKey: "fixture-key",
        apiSecret: "fixture-secret",
      }),
    };
    await executePipelineRun({ ...run, deps }, db);
    const pollDeps = {
      ...deps,
      now: () => (fillDate === date ? clock : clock + 86400000),
    };
    await reconcilePendingIntents({ runId: run.runId, deps: pollDeps }, db);
    expect(listIntentsByRun(run.runId, db)[0]).toMatchObject({
      status: "unknown_reconcile",
      filledQuantity: 1,
    });
    const owner = {
      accountScope: "real",
      accountId: "crypto_live:binance:fixture",
      ownerKind: "deployment",
      ownerId: run.intents[0]!.deploymentId,
    } as const;
    expect(listOwnerSleeveHoldings(owner, db)).toEqual([]);
    await reconcilePendingIntents({ runId: run.runId, deps: pollDeps }, db);
    expect(listIntentsByRun(run.runId, db)[0]?.status).toBe("filled");
    expect(listOwnerSleeveHoldings(owner, db)).toMatchObject([
      { quantity: 1, entryDate: fillDate, avgEntryPrice: 10 },
    ]);
    const links = listFillLinksByIntentIds(
      run.intents.map((i) => i.id),
      db,
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      accountScope: "real",
      accountId: "crypto_live:binance:fixture",
      venueOrderId: "123",
      arrivalPrice: 10,
      fillSource: "real_fills",
    });
    expect(JSON.parse(links[0]!.fillId).at(-1)).toBe("999");
  },
);

it("首笔账户快照缺失时拒单，第二笔按恢复后的余额缩到可支付股数", async () => {
  const run = seed(ths, [
    sell,
    { ...buy, quantity: 300 },
    { ...buy, symbol: "sh600003", quantity: 300 },
  ]);
  transitionIntentStatus(run.intents[0]!.id, "rejected", {}, db);
  const adapter = venue();
  adapter.readAccountState
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      cash: 2011,
      equity: 100000,
      positions: [],
      drawdownPct: null,
    });
  await executePipelineRun(
    { ...run, deps: { now: () => clock, readQuote, thsAdapter: adapter } },
    db,
  );
  expect(adapter.submitOrder.mock.calls.map(([i]) => i.quantity)).toEqual([
    200,
  ]);
  const [first] = adapter.submitOrder.mock.calls[0]!;
  expect(listIntentsByRun(run.runId, db)).toContainEqual(
    expect.objectContaining({
      status: "rejected",
      errorSummary: "execution-risk-evidence-missing",
    }),
  );
  expect(
    listExecutionAuditEvents(
      { deploymentId: first.deploymentId, runId: run.runId },
      db,
    ).items,
  ).toContainEqual(
    expect.objectContaining({
      eventType: "buy_cash_after_sell",
      details: { cash: 2011, coveredFills: {} },
    }),
  );
});

it.each([
  [1996, 0],
  [2006, 200],
  [2017, 201],
] as const)("科创板可用资金 %i，成交 %i 股", async (cash, quantity) => {
  const run = seed(ths, [sell, { ...buy, symbol: "sh688001", quantity: 400 }]);
  transitionIntentStatus(run.intents[0]!.id, "rejected", {}, db);
  const adapter = venue();
  adapter.readAccountState.mockResolvedValue({
    cash,
    equity: 100000,
    positions: [],
    drawdownPct: null,
  });
  await executePipelineRun(
    { ...run, deps: { now: () => clock, readQuote, thsAdapter: adapter } },
    db,
  );
  if (quantity)
    expect(adapter.submitOrder.mock.calls.map(([i]) => i.quantity)).toEqual([
      quantity,
    ]);
  else {
    expect(adapter.submitOrder).not.toHaveBeenCalled();
    expect(listIntentsByRun(run.runId, db)[1]).toMatchObject({
      status: "rejected",
      errorSummary: "insufficient-realized-proceeds",
    });
  }
});

it.each([
  "execution-window-closed",
  "kill-switch-off",
  "execute-date-expired",
  "stale-execution-quote",
] as const)("同花顺最后一次读取凭证期间发生 %s，零场所委托", async (reason) => {
  let now = clock;
  let windowOpen = true;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.spyOn(gfCalendar, "gfCalendarReference").mockResolvedValue({
    days: [date],
    source: "fixture",
    hash: null,
  });
  vi.spyOn(tradeLedger, "tradeContext").mockResolvedValue({
    today: date,
    calendar: [],
    calendarSource: "fixture",
    evidence: () => {
      throw new Error("unexpected evidence request");
    },
  });
  mockService.setMockEnabled(true);
  const transport = vi.mocked(mockTransport).mockReset();
  transport.mockImplementation(async (url) => {
    if (new URL(String(url)).pathname !== "/pt_web_qry_stock")
      throw new Error("unexpected order submission");
    return new (await import("undici")).Response(
      JSON.stringify({
        errorcode: 0,
        data: [{ zqdm: sell.symbol.slice(2), gpsl: 100, kysl: 100, gpcb: 10 }],
      }),
    );
  });
  vi.spyOn(vault, "readSecret").mockImplementation(async () => {
    // The position lookup has finished; request() now awaits the final identity read.
    if (transport.mock.calls.length) {
      if (reason === "kill-switch-off") setGlobalAutoSimEnabled(false, db);
      if (reason === "execution-window-closed") windowOpen = false;
      if (reason === "execute-date-expired") now += 86400000;
      if (reason === "stale-execution-quote") now += 301000;
    }
    return {
      username: "fixture",
      state: "ready",
      account: "fixture-account",
      shareholders: [{ scdm: "2", gddm: "fixture-share" }],
    };
  });
  const input = seed(ths, [sell]);
  upsertSleeveHolding(
    {
      ...thsOwner(input.intents[0]!.deploymentId),
      symbol: sell.symbol,
      quantity: 100,
      avgEntryPrice: 10,
      entryDate: "2024-04-15",
    },
    db,
  );
  const result = await executePipelineRun(
    {
      ...input,
      deps: {
        now: () => now,
        readQuote,
        executionWindowCheck: () => windowOpen,
      },
    },
    db,
  );
  expect(
    transport.mock.calls.map(([url]) => new URL(String(url)).pathname),
  ).toEqual(["/pt_web_qry_stock"]);
  expect(result).toEqual({ skipped: true, reason });
  expect(listIntentsByRun(input.runId, db)[0]).toMatchObject({
    status: "rejected",
    venueOrderId: null,
    errorSummary: reason,
  });
});

it.each([
  [0, 1000, "actual"],
  [20, 980, "actual"],
  [undefined, 994, "estimated"],
  ["mixed", 987, "estimated"],
] as const)(
  "同花顺回报费用 %s，累计实收为 %i，费用依据 %s",
  async (fee, netProceeds, feeBasis) => {
    const run = seed(ths, [sell, { ...buy, quantity: 300 }]);
    const sale = run.intents[0]!;
    transitionIntentStatus(sale.id, "submitting", {}, db);
    transitionIntentStatus(
      sale.id,
      "submitted",
      { venueOrderId: "venue-sell" },
      db,
    );
    const row = {
      zqdm: sell.symbol.slice(2),
      mmlb: "S",
      cjg: 10,
      cje: 1000,
      cjsl: 100,
      cjsj: "09:35:00",
      fee: typeof fee === "number" ? fee : undefined,
      tradeNo: "fill",
      entrustNo: "v",
    };
    const rows =
      fee === "mixed"
        ? [
            { ...row, cje: 500, cjsl: 50, fee: 10 },
            { ...row, cje: 500, cjsl: 50, tradeNo: "other" },
          ]
        : [row, row];
    vi.spyOn(mockService, "queryMockOrderStatus").mockResolvedValue({
      state: "accepted",
      entrustNos: ["v"],
      attributable: true,
      fillStatus: "matched",
      rows,
    });
    await reconcilePendingIntents({ runId: run.runId }, db);
    expect(
      listExecutionAuditEvents(
        { deploymentId: sale.deploymentId, runId: run.runId },
        db,
      ).items,
    ).toContainEqual(
      expect.objectContaining({
        eventType: "sell_settlement",
        details: expect.objectContaining({ feeBasis, netProceeds }),
      }),
    );
    const adapter = venue();
    await executePipelineRun(
      { ...run, deps: { now: () => clock, readQuote, thsAdapter: adapter } },
      db,
    );
    expect(adapter.submitOrder.mock.calls.map(([i]) => i.quantity)).toEqual([
      netProceeds < 994 ? 200 : 300,
    ]);
  },
);

it("获取 SQLite 写锁后窗口已关，意图不被认领且零提交", async () => {
  const run = seed(ths);
  const adapter = venue();
  const check = vi.fn(() => !db.inTransaction);
  const result = await executePipelineRun(
    {
      ...run,
      deps: {
        now: () => clock,
        readQuote,
        thsAdapter: adapter,
        executionWindowCheck: check,
      },
    },
    db,
  );
  expect(result).toEqual({ skipped: true, reason: "execution-window-closed" });
  expect(adapter.submitOrder).not.toHaveBeenCalled();
  expect(listIntentsByRun(run.runId, db)[0]?.status).toBe("planned");
  expect(
    listExecutionAuditEvents(
      { deploymentId: run.intents[0]!.deploymentId, runId: run.runId },
      db,
    ).items.some((e) => e.eventType === "intent_claimed"),
  ).toBe(false);
});

it.each(["planned", "submitted"] as const)(
  "旧 %s 卖单不能动用其他分仓的同标的库存",
  async (status) => {
    const run = seed(ths, [sell]);
    const sale = run.intents[0]!;
    const peer = thsOwner(seed(ths).intents[0]!.deploymentId);
    const otherHolding = upsertSleeveHolding(
      {
        ...peer,
        symbol: sale.symbol,
        quantity: 200,
        avgEntryPrice: 9,
        entryDate: "2024-04-10",
      },
      db,
    );
    const adapter = venue();
    const deps = { now: () => clock, readQuote, thsAdapter: adapter };
    if (status === "submitted") {
      transitionIntentStatus(sale.id, "submitting", {}, db);
      transitionIntentStatus(sale.id, "submitted", { venueOrderId: "old" }, db);
      adapter.reconcileOrder.mockResolvedValue({
        status: "filled",
        filledQuantity: 100,
        averageFillPrice: 10,
        venueOrderId: "old",
        fillId: "old-trade",
      });
      await reconcilePendingIntents({ runId: run.runId, deps }, db);
      expect(listIntentsByRun(run.runId, db)[0]).toMatchObject({
        status: "filled",
        filledQuantity: 100,
      });
      expect(listFillLinksByIntentIds([sale.id], db)).toHaveLength(1);
      expect(
        listExecutionAuditEvents(
          { deploymentId: sale.deploymentId, runId: run.runId },
          db,
        ).items,
      ).toContainEqual(
        expect.objectContaining({
          eventType: "sleeve_fill_delta",
          details: expect.objectContaining({
            quantityDelta: 0,
            unattributedQuantity: 100,
          }),
        }),
      );
    } else {
      await executePipelineRun({ ...run, deps }, db);
      expect(listIntentsByRun(run.runId, db)[0]).toMatchObject({
        status: "rejected",
        errorSummary: "insufficient-sleeve-quantity",
      });
    }
    expect(adapter.submitOrder).not.toHaveBeenCalled();
    expect(listOwnerSleeveHoldings(thsOwner(sale.deploymentId), db)).toEqual(
      [],
    );
    expect(listOwnerSleeveHoldings(peer, db)).toEqual([otherHolding]);
  },
);

it("分仓减仓保留成本与首笔日期，部分成交重放后全部卖出清零", async () => {
  const run = seed(ths, [sell]);
  const owner = thsOwner(run.intents[0]!.deploymentId);
  upsertSleeveHolding(
    {
      ...owner,
      symbol: sell.symbol,
      quantity: 100,
      avgEntryPrice: 8.25,
      entryDate: "2024-04-10",
    },
    db,
  );
  const adapter = venue();
  const deps = { now: () => clock, readQuote, thsAdapter: adapter };
  const partial = {
    status: "partial_filled",
    filledQuantity: 40,
    averageFillPrice: 10,
    venueOrderId: "s",
    fillId: "s1",
  } as const;
  adapter.submitOrder.mockResolvedValue(partial);
  await executePipelineRun({ ...run, deps }, db);
  adapter.reconcileOrder.mockResolvedValueOnce(partial).mockResolvedValueOnce({
    ...partial,
    status: "filled",
    filledQuantity: 100,
    averageFillPrice: 11.2,
    fillId: "s2",
  });
  await reconcilePendingIntents({ runId: run.runId, deps }, db);
  expect(listOwnerSleeveHoldings(owner, db)).toMatchObject([
    { quantity: 60, avgEntryPrice: 8.25, entryDate: "2024-04-10" },
  ]);
  await reconcilePendingIntents({ runId: run.runId, deps }, db);
  expect(listOwnerSleeveHoldings(owner, db)).toEqual([]);
  expect(listFillLinksByIntentIds([run.intents[0]!.id], db)).toHaveLength(2);
});

it("另一运行的卖单结果待核对时，不能再次提交同一分仓的库存", async () => {
  const run = seed(ths, [sell]);
  const sale = run.intents[0]!;
  upsertSleeveHolding(
    {
      ...thsOwner(sale.deploymentId),
      symbol: sell.symbol,
      quantity: 100,
      avgEntryPrice: 8.25,
      entryDate: "2024-04-10",
    },
    db,
  );
  const previous = getOrCreatePipelineRun(
    {
      deploymentId: sale.deploymentId,
      decisionDate: "2024-04-12",
      executeDate: "2024-04-15",
      triggerKind: "manual",
    },
    db,
  ).run;
  const [sent] = insertOrderIntents(
    previous.id,
    [
      {
        ...sell,
        runId: previous.id,
        deploymentId: sale.deploymentId,
        venueKind: ths.kind,
      },
    ],
    db,
  );
  transitionIntentStatus(sent!.id, "submitting", {}, db);
  transitionIntentStatus(
    sent!.id,
    "unknown_reconcile",
    { filledQuantity: 100, averageFillPrice: null },
    db,
  );
  const adapter = venue();
  await executePipelineRun(
    { ...run, deps: { now: () => clock, readQuote, thsAdapter: adapter } },
    db,
  );
  expect(adapter.submitOrder).not.toHaveBeenCalled();
  expect(listIntentsByRun(run.runId, db)[0]).toMatchObject({
    status: "rejected",
    errorSummary: "insufficient-sleeve-quantity",
  });
  expect(
    listOwnerSleeveHoldings(thsOwner(sale.deploymentId), db),
  ).toMatchObject([{ quantity: 100 }]);
});

it("历史卖单已记 60 股，断续对账只扣新增 40 股", async () => {
  const run = seed(ths, [sell]);
  const sale = run.intents[0]!;
  const owner = thsOwner(sale.deploymentId);
  upsertSleeveHolding(
    {
      ...owner,
      symbol: sell.symbol,
      quantity: 200,
      avgEntryPrice: 8,
      entryDate: "2024-04-10",
    },
    db,
  );
  transitionIntentStatus(sale.id, "submitting", {}, db);
  transitionIntentStatus(
    sale.id,
    "partial_filled",
    {
      venueOrderId: "historic",
      filledQuantity: 60,
      averageFillPrice: 10,
    },
    db,
  );
  const adapter = venue();
  adapter.reconcileOrder
    .mockRejectedValueOnce(new Error("offline"))
    .mockResolvedValue({
      status: "filled",
      venueOrderId: "historic",
      filledQuantity: 100,
      averageFillPrice: 10.2,
      fillId: "last",
    });
  const deps = { now: () => clock, thsAdapter: adapter };
  await reconcilePendingIntents({ runId: run.runId, deps }, db);
  await reconcilePendingIntents({ runId: run.runId, deps }, db);
  expect(listOwnerSleeveHoldings(owner, db)).toMatchObject([
    { quantity: 160, avgEntryPrice: 8 },
  ]);
  expect(
    listExecutionAuditEvents(
      { deploymentId: sale.deploymentId, runId: run.runId },
      db,
    ).items,
  ).toContainEqual(
    expect.objectContaining({
      eventType: "sleeve_fill_delta",
      details: expect.objectContaining({ quantityDelta: -40, fillPrice: 10.5 }),
    }),
  );
});

it("成交状态写入失败时回滚分仓和关联，重查无需重发", async () => {
  const run = seed(ths);
  const intent = run.intents[0]!;
  const adapter = venue();
  const deps = { now: () => clock, readQuote, thsAdapter: adapter };
  db.exec(`CREATE TRIGGER fail_status BEFORE UPDATE OF status ON execution_order_intents
    WHEN NEW.status='filled' BEGIN SELECT RAISE(ABORT,'test interruption'); END`);
  await expect(executePipelineRun({ ...run, deps }, db)).rejects.toThrow(
    "test interruption",
  );
  expect(listIntentsByRun(run.runId, db)[0]?.status).toBe("submitting");
  expect(listOwnerSleeveHoldings(thsOwner(intent.deploymentId), db)).toEqual(
    [],
  );
  expect(listFillLinksByIntentIds([intent.id], db)).toEqual([]);
  db.exec("DROP TRIGGER fail_status");
  adapter.reconcileOrder.mockResolvedValue({
    status: "filled",
    venueOrderId: intent.id,
    fillId: "trade",
    filledQuantity: 100,
    averageFillPrice: 10,
  });
  await reconcilePendingIntents(
    { runId: run.runId, deps: { ...deps, now: () => clock + 60000 } },
    db,
  );
  expect(
    listOwnerSleeveHoldings(thsOwner(intent.deploymentId), db),
  ).toMatchObject([{ quantity: 100 }]);
  expect(listFillLinksByIntentIds([intent.id], db)).toHaveLength(1);
  expect(adapter.submitOrder).toHaveBeenCalledTimes(1);
});

it.each(["submitted", "partial_filled", "unknown_reconcile"] as const)(
  "外部买单 %s 后重读可用余额，已确认冻结只扣一次，未知委托保留预算",
  async (status) => {
    const run = seed(ths, [
      sell,
      { ...buy, quantity: 300 },
      { ...buy, symbol: "sh600003", quantity: 300 },
    ]);
    transitionIntentStatus(run.intents[0]!.id, "rejected", {}, db);
    const adapter = venue();
    const deps = { now: () => clock, readQuote, thsAdapter: adapter };
    adapter.readAccountState
      .mockResolvedValueOnce({ ...fundedAccount, cash: 5020 })
      .mockResolvedValue({
        cash: status === "unknown_reconcile" ? 3990 : 2011,
        equity: 100000,
        drawdownPct: null,
        positions: [],
      });
    adapter.submitOrder.mockResolvedValueOnce({
      status,
      venueOrderId: "v",
      filledQuantity:
        status === "submitted" ? null : status === "partial_filled" ? 100 : 300,
      averageFillPrice:
        status === "submitted" ? null : status === "partial_filled" ? 10 : 9.8,
    });
    await executePipelineRun({ ...run, deps }, db);
    await executePipelineRun({ ...run, deps }, db);
    expect(adapter.submitOrder.mock.calls.map(([i]) => i.quantity)).toEqual(
      status === "unknown_reconcile" ? [300] : [300, 200],
    );
  },
);

it("本地模拟盘科创板现金预算可申报 200 股，单票额度不够最小买入量仍拒单", async () => {
  const run = seed(sim("2100"), [
    sell,
    { ...buy, symbol: "sh688001", quantity: 300 },
  ]);
  await executePipelineRun(
    { ...run, deps: { now: () => clock, readQuote } },
    db,
  );
  expect(listIntentsByRun(run.runId, db)[1]).toMatchObject({
    status: "rejected",
    errorSummary: "instrument_cap",
    filledQuantity: null,
  });
  expect(
    listExecutionAuditEvents(
      { deploymentId: run.intents[0]!.deploymentId, runId: run.runId },
      db,
    ).items,
  ).toContainEqual(
    expect.objectContaining({
      eventType: "buy_quantity_resized_after_sell",
      details: expect.objectContaining({ plannedQuantity: 300, quantity: 200 }),
    }),
  );
});
