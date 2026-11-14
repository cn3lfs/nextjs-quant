import { beforeEach, expect, it, vi } from "vitest";
import type {
  AccountReadContext,
  PlatformTrade,
} from "../../src/server/crypto-trading/account-model";
import type { Symbol } from "../../src/server/crypto-trading/model";
const fixture = vi.hoisted(() => ({
  now: Date.UTC(2026, 10, 12, 12),
  revision: "revision-a",
  venue: "binance" as "binance" | "okx" | "bybit",
  snapshotFailure: false,
  priceFailure: false,
  historyFailure: false,
  snapshotCalls: 0,
  calls: [] as { symbol: string; from: number; to: number }[],
  trades: [] as PlatformTrade[],
  historyWait: null as Promise<void> | null,
}));
vi.mock("../../src/server/crypto-trading/service", () => ({
  getCryptoAccountReadContext: async (): Promise<AccountReadContext> => ({
    config: {
      venue: fixture.venue,
      network: "demo",
      minutes: 60,
      fast: 5,
      slow: 20,
      allocation: 0.4,
    },
    credential: { apiKey: "fixture-key", apiSecret: "fixture-secret" },
    revision: fixture.revision,
  }),
}));
vi.mock("../../src/server/crypto-trading/adapter", () => ({
  createSpotAdapter: () => ({
    snapshot: async () => {
      fixture.snapshotCalls++;
      if (fixture.snapshotFailure) throw new Error("balance offline");
      return {
        balances: [
          { asset: "BTC", total: "2", free: "1.5" },
          { asset: "ETH", total: "3", free: "3" },
          { asset: "USDT", total: "1000", free: "900" },
        ],
        openOrders: [],
      };
    },
    price: async (symbol: Symbol) => {
      if (fixture.priceFailure && symbol === "ETHUSDT")
        throw new Error("quote offline");
      return symbol === "BTCUSDT" ? "80000" : "4000";
    },
    tradeHistory: async (symbol: Symbol, from: number, to: number) => {
      fixture.calls.push({ symbol, from, to });
      await fixture.historyWait;
      if (fixture.historyFailure && symbol === "BTCUSDT")
        throw new Error("history offline");
      return fixture.trades.filter(
        (x) => x.symbol === symbol && x.time >= from && x.time < to,
      );
    },
  }),
}));
const { put, sqlite } = await import("../../src/server/db");
const { credentialRevisionKey } =
  await import("../../src/server/crypto-trading/account-model");
const { appendAccountTrades } =
  await import("../../src/server/db/account-store");
const service = await import("../../src/server/crypto-trading/account-service");
const day = 86400000,
  id = "binance-demo";
const trade = (overrides: Partial<PlatformTrade> = {}): PlatformTrade => ({
  id: "trade-1",
  orderId: "order-1",
  symbol: "BTCUSDT",
  side: "BUY",
  time: fixture.now - 3600000,
  quantity: "0.1",
  price: "80000",
  quoteQuantity: "8000",
  fee: "0.0001",
  feeAsset: "BTC",
  ...overrides,
});
beforeEach(() => {
  sqlite().prepare("DELETE FROM records WHERE kind LIKE 'crypto-%'").run();
  fixture.now = Date.UTC(2026, 10, 12, 12);
  fixture.revision = "revision-a";
  fixture.venue = "binance";
  fixture.snapshotFailure = false;
  fixture.priceFailure = false;
  fixture.historyFailure = false;
  fixture.snapshotCalls = 0;
  fixture.calls = [];
  fixture.trades = [trade()];
  fixture.historyWait = null;
  vi.spyOn(Date, "now").mockImplementation(() => fixture.now);
  put(
    "crypto-credential-revision",
    credentialRevisionKey(id),
    fixture.revision,
  );
});
it("syncs current platform quantities independently of strategy inventory and keeps unavailable valuations null", async () => {
  fixture.priceFailure = true;
  await service.syncCryptoAccount({ id });
  const view = await service.cryptoAccountView({ id });
  expect(view.snapshot?.balances.find((x) => x.asset === "USDT")).toMatchObject(
    { free: "900", total: "1000" },
  );
  expect(view.snapshot?.positions[0]).toMatchObject({
    total: "2",
    free: "1.5",
    locked: "0.5",
    price: "80000",
    marketValue: "160000",
  });
  expect(view.snapshot?.positions[1]).toMatchObject({
    total: "3",
    price: null,
    marketValue: null,
    priceAt: null,
  });
  expect(view.snapshot?.warnings[0]).toContain("quote offline");
  expect(view.sync?.status).toBe("success");
  expect(
    sqlite()
      .prepare("SELECT count(*) count FROM records WHERE kind='crypto-bot'")
      .get(),
  ).toEqual({ count: 0 });
});
it("deduplicates overlapping incremental reads and dynamically joins strategy orders beyond the recent200 projection", async () => {
  fixture.trades.push(
    trade({
      id: "trade-2",
      orderId: "other-order",
      side: "SELL",
      symbol: "ETHUSDT",
      feeAsset: "USDT",
    }),
  );
  await service.syncCryptoAccount({ id });
  put(`crypto-orders-${id}`, "old-matching-order", {
    symbol: "BTCUSDT",
    exchangeId: "order-1",
    clientId: "client1",
  });
  for (let i = 0; i < 205; i++)
    put(`crypto-orders-${id}`, `new-order-${i}`, {
      symbol: "BTCUSDT",
      exchangeId: `unrelated-${i}`,
      clientId: `new${i}`,
    });
  fixture.now += 60000;
  fixture.calls = [];
  await service.syncCryptoAccount({ id });
  expect(fixture.calls[0]?.from).toBe(fixture.now - 60000 - 3600000);
  expect((await service.cryptoAccountView({ id })).total).toBe(2);
  const strategy = await service.cryptoAccountView({ id, source: "strategy" });
  expect(strategy.total).toBe(1);
  expect(strategy.rows[0]?.id).toBe("trade-1");
  const platform = await service.cryptoAccountView({
    id,
    source: "platform",
    side: "SELL",
  });
  expect(platform.total).toBe(1);
  expect(platform.rows[0]?.source).toBe("platform");
});
it("uses stable full-set SQL pagination and half-open time filters", async () => {
  appendAccountTrades(
    id,
    fixture.revision,
    Array.from({ length: 205 }, (_, i) =>
      trade({ id: `t${String(i).padStart(3, "0")}` }),
    ),
  );
  const first = await service.cryptoAccountView({ id, pageSize: 100 });
  const second = await service.cryptoAccountView({
    id,
    page: 2,
    pageSize: 100,
  });
  const third = await service.cryptoAccountView({ id, page: 3, pageSize: 100 });
  expect(first.total).toBe(205);
  expect(first.rows[0]?.id).toBe("t000");
  expect(second.rows[0]?.id).toBe("t100");
  expect(third.rows).toHaveLength(5);
  expect(
    (await service.cryptoAccountView({ id, to: fixture.now - 3600000 })).total,
  ).toBe(0);
  expect(
    (await service.cryptoAccountView({ id, from: fixture.now - 3600000 }))
      .total,
  ).toBe(205);
});
it("retains old snapshots and records when later balance and history queries fail", async () => {
  await service.syncCryptoAccount({ id });
  const original = (await service.cryptoAccountView({ id })).snapshot;
  fixture.now += 60000;
  fixture.snapshotFailure = true;
  fixture.historyFailure = true;
  const result = await service.syncCryptoAccount({ id });
  const view = await service.cryptoAccountView({ id });
  expect(view.snapshot).toEqual(original);
  expect(view.total).toBe(1);
  expect(result.status).toBe("partial");
  expect(result.error).toContain("balance offline");
  expect(result.error).toContain("history offline");
  expect(result.lastIncrementalTo).toBe(fixture.now - 60000);
});
it("keeps immutable recorded trades when a later provider response conflicts", async () => {
  await service.syncCryptoAccount({ id });
  fixture.trades[0]!.price = "81000";
  const result = await service.syncCryptoAccount({ id });
  expect(result.status).toBe("partial");
  expect(result.error).toContain("字段发生冲突");
  expect((await service.cryptoAccountView({ id })).rows[0]?.price).toBe(
    "80000",
  );
});
it("does not regress the incremental cursor after explicit historical backfill", async () => {
  const first = await service.syncCryptoAccount({ id });
  const to = fixture.now - 10 * day;
  const backfill = await service.syncCryptoAccount({ id, from: to - day, to });
  expect(backfill.lastIncrementalTo).toBe(first.lastIncrementalTo);
  fixture.now += 60000;
  fixture.calls = [];
  await service.syncCryptoAccount({ id });
  expect(fixture.calls[0]?.from).toBe(first.lastIncrementalTo! - 3600000);
});
it("queries the full requested Bybit Demo range without inferring execution retention from order retention", async () => {
  fixture.venue = "bybit";
  const bybit = "bybit-demo";
  put(
    "crypto-credential-revision",
    credentialRevisionKey(bybit),
    fixture.revision,
  );
  fixture.trades.push(
    trade({ id: "older-trade", time: fixture.now - 8 * day }),
  );
  const result = await service.syncCryptoAccount({ id: bybit });
  expect(result.status).toBe("success");
  expect(result.warnings.join()).toContain("订单保留7天");
  expect(result.warnings.join()).toContain("空响应不能证明没有更早成交");
  expect(fixture.calls).toHaveLength(60);
  expect(result.completedRanges).toEqual([
    { symbol: "BTCUSDT", from: fixture.now - 30 * day, to: fixture.now },
    { symbol: "ETHUSDT", from: fixture.now - 30 * day, to: fixture.now },
  ]);
  expect(result.lastIncrementalTo).toBe(fixture.now);
  const view = await service.cryptoAccountView({ id: bybit });
  expect(view.rows.some((row) => row.id === "older-trade")).toBe(true);
});
it("partitions old credentials and rejects commits from an in-flight older revision", async () => {
  let release!: () => void;
  fixture.historyWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const syncing = service.syncCryptoAccount({ id });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  fixture.revision = "revision-b";
  put(
    "crypto-credential-revision",
    credentialRevisionKey(id),
    fixture.revision,
  );
  release();
  await expect(syncing).rejects.toThrow("凭证版本已更新");
  const view = await service.cryptoAccountView({ id });
  expect(view.snapshot).toBeNull();
  expect(view.sync).toBeNull();
  expect(view.total).toBe(0);
});
it("coalesces concurrent synchronizations under the independent sync lease", async () => {
  let release!: () => void;
  fixture.historyWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = service.syncCryptoAccount({ id });
  for (let i = 0; i < 30; i++) await Promise.resolve();
  const second = await service.syncCryptoAccount({ id });
  expect(second.status).toBe("running");
  expect(fixture.snapshotCalls).toBe(1);
  expect(fixture.calls).toHaveLength(1);
  release();
  await first;
});
it("shows a dead-process running sync as interrupted and allows a fresh retry", async () => {
  const first = await service.syncCryptoAccount({ id });
  put("crypto-account-sync", `crypto-account-sync-${id}-${fixture.revision}`, {
    ...first,
    status: "running",
    finishedAt: null,
  });
  put("crypto-account-sync-lease", `crypto-account-sync-lease-${id}`, {
    owner: "dead",
    pid: 2147483647,
    revision: fixture.revision,
  });
  const interrupted = await service.cryptoAccountView({ id });
  expect(interrupted.sync?.status).toBe("failed");
  expect(interrupted.sync?.error).toContain("已中断");
  expect(interrupted.total).toBe(1);
  expect((await service.syncCryptoAccount({ id })).status).toBe("success");
});
it("rejects malformed ranges before any platform request", async () => {
  await expect(
    service.syncCryptoAccount({
      id,
      from: fixture.now - 91 * day,
      to: fixture.now,
    }),
  ).rejects.toThrow("最多90天");
  expect(fixture.snapshotCalls).toBe(0);
  await expect(
    service.cryptoAccountView({ id, pageSize: 101 }),
  ).rejects.toThrow();
});

it("resumes after a long offline interval without inventing coverage for the skipped old gap", async () => {
  const first = await service.syncCryptoAccount({ id });
  fixture.now += 120 * day;
  fixture.calls = [];
  const next = await service.syncCryptoAccount({ id });
  expect(next.status).toBe("partial");
  expect(next.warnings.join()).toContain("超过90天");
  expect(next.requestedFrom).toBe(fixture.now - 90 * day);
  expect(next.lastIncrementalTo).toBe(fixture.now);
  expect(fixture.calls[0]?.from).toBe(fixture.now - 90 * day);
  expect(
    next.completedRanges.some(
      (range) =>
        range.from === first.requestedFrom && range.to === first.requestedTo,
    ),
  ).toBe(true);
});

it("preserves distinct orders sharing a venue matching trade id with stable order-id pagination", async () => {
  fixture.trades = [
    trade({ id: "matching-trade", orderId: "order-b" }),
    trade({ id: "matching-trade", orderId: "order-a", side: "SELL" }),
  ];
  await service.syncCryptoAccount({ id });
  await service.syncCryptoAccount({ id });
  const first = await service.cryptoAccountView({ id, pageSize: 1 });
  const second = await service.cryptoAccountView({ id, pageSize: 1, page: 2 });
  expect(first.total).toBe(2);
  expect(first.rows[0]?.orderId).toBe("order-a");
  expect(second.rows[0]?.orderId).toBe("order-b");
  fixture.trades[0]!.price = "81000";
  expect((await service.syncCryptoAccount({ id })).status).toBe("partial");
  expect(
    (await service.cryptoAccountView({ id })).rows.find(
      (row) => row.orderId === "order-b",
    )?.price,
  ).toBe("80000");
});
