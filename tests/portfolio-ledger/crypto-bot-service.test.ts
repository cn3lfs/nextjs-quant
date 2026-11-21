import { beforeEach, expect, it, vi } from "vitest";
import Big from "big.js";
import type {
  Order,
  Snapshot,
  SpotAdapter,
} from "../../src/server/crypto-trading/model";
const fixture = vi.hoisted(() => ({
  secrets: new Map<string, unknown>(),
  now: Date.UTC(2026, 10, 11, 12),
  cross: false,
  down: false,
  partial: false,
  baseFee: "0.0001",
  snapshotWait: null as Promise<void> | null,
  failSend: false,
  sends: 0,
  balances: { USDT: "1000", BTC: "0", ETH: "0" } as Record<string, string>,
  remote: new Map<string, Order>(),
  waitPrice: null as null | Promise<void>,
  releasePrice: null as null | (() => void),
}));
vi.mock("../../src/server/vault", () => ({
  readSecret: async (id: string) => fixture.secrets.get(id),
  saveSecret: async (id: string, value: unknown) => {
    fixture.secrets.set(id, value);
  },
}));
vi.mock("../../src/server/crypto-trading/adapter", () => ({
  createSpotAdapter: (): SpotAdapter => ({
    serverNow: () => Date.now(),
    snapshot: async (): Promise<Snapshot> => {
      await fixture.snapshotWait;
      return {
        balances: Object.entries(fixture.balances).map(([asset, free]) => ({
          asset,
          free,
          total: free,
        })),
        openOrders: [],
      };
    },
    rules: async () => ({
      step: "0.0001",
      min: "0.0001",
      max: "1000",
      minValue: "5",
    }),
    candles: async (_symbol, minutes, limit) =>
      Array.from({ length: limit }, (_, i) => ({
        time:
          Math.floor(fixture.now / (minutes * 60000)) * (minutes * 60000) -
          (limit - i) * minutes * 60000,
        close:
          i === limit - 1 && fixture.cross
            ? 200
            : i === limit - 1 && fixture.down
              ? 50
              : 100,
      })),
    price: async () => {
      await fixture.waitPrice;
      return "200";
    },
    place: async (order) => {
      fixture.sends++;
      if (fixture.failSend) throw new Error("socket timeout");
      const asset = order.symbol.slice(0, -4),
        quantity = new Big(order.quantity).times(fixture.partial ? "0.5" : "1");
      const buy = order.side === "BUY",
        fee = buy ? fixture.baseFee : "0.1",
        feeAsset = buy ? asset : "USDT";
      fixture.balances[asset] = new Big(fixture.balances[asset] ?? "0")
        .plus(quantity.times(buy ? 1 : -1))
        .minus(buy ? fee : "0")
        .toFixed();
      fixture.balances.USDT = new Big(fixture.balances.USDT!)
        .plus(quantity.times(200).times(buy ? -1 : 1))
        .minus(buy ? "0" : fee)
        .toFixed();
      fixture.remote.set(order.clientId, {
        ...order,
        state: fixture.partial ? "PARTIALLY_FILLED" : "FILLED",
        executedQuantity: quantity.toFixed(),
        exchangeId: "123",
        fills: [
          {
            id: `fill-${asset}-${order.clientId}`,
            quantity: quantity.toFixed(),
            price: "200",
            fee,
            feeAsset,
          },
        ],
      });
      return { exchangeId: "123", raw: { status: "NEW" } };
    },
    reconcile: async (order) => fixture.remote.get(order.clientId) ?? null,
    cancel: async () => {},
  }),
}));
const { sqlite, put } = await import("../../src/server/db");
const service = await import("../../src/server/crypto-trading/service");
const config = {
  venue: "binance",
  network: "demo",
  minutes: 60,
  fast: 5,
  slow: 20,
  allocation: 0.4,
} as const;
async function start() {
  await service.saveCryptoBot(config);
  await service.saveCryptoBotCredential({
    id: "binance-demo",
    apiKey: "key",
    apiSecret: "secret",
  });
  await service.controlCryptoBot({ id: "binance-demo", action: "start" });
  await service.tickCryptoBots();
}
beforeEach(() => {
  sqlite()
    .prepare("DELETE FROM records WHERE kind LIKE 'crypto-%' OR kind='lease'")
    .run();
  fixture.secrets.clear();
  fixture.remote.clear();
  fixture.now = Date.UTC(2026, 10, 11, 12);
  fixture.cross = false;
  fixture.down = false;
  fixture.partial = false;
  fixture.baseFee = "0.0001";
  fixture.snapshotWait = null;
  fixture.failSend = false;
  fixture.sends = 0;
  fixture.balances = { USDT: "1000", BTC: "0", ETH: "0" };
  fixture.waitPrice = null;
  fixture.releasePrice = null;
  vi.spyOn(Date, "now").mockImplementation(() => fixture.now);
});
it("starts from baseline, freezes shared budgets and applies base-asset commission without repeat orders", async () => {
  await start();
  expect(fixture.sends).toBe(0);
  fixture.now += 3600000;
  fixture.cross = true;
  await service.tickCryptoBots();
  // A gap >90s simulates sleep and must rebuild its signal baseline.
  expect(fixture.sends).toBe(0);
  fixture.cross = false;
  fixture.now += 3600000;
  await service.tickCryptoBots();
  fixture.now += 3590000;
  await service.tickCryptoBots();
  fixture.now += 10000;
  fixture.cross = true;
  await service.tickCryptoBots();
  expect(fixture.sends).toBe(2);
  let status = await service.cryptoBotStatus("binance-demo");
  expect(status.bot?.initialUsdt).toBe("1000");
  expect(status.bot?.positions.BTCUSDT).toBe("1.9799");
  expect(status.orders[0]?.quoteBudget).toBe("396.00");
  expect(status.orders[0]?.decision).toMatchObject({
    strategyId: "crypto-dual-ma-v1",
  });
  await service.tickCryptoBots();
  expect(fixture.sends).toBe(2);
  status = await service.cryptoBotStatus("binance-demo");
  expect(status.bot?.status).toBe("running");
});
it("does not resend a persisted uncertain intent and pauses until exchange evidence is available", async () => {
  await start();
  fixture.now += 3590000;
  await service.tickCryptoBots();
  fixture.now += 10000;
  fixture.cross = true;
  fixture.failSend = true;
  await service.tickCryptoBots();
  expect(fixture.sends).toBe(1);
  await service.tickCryptoBots();
  expect(fixture.sends).toBe(1);
  const status = await service.cryptoBotStatus("binance-demo");
  expect(status.bot?.status).toBe("paused");
  expect(status.orders[0]?.state).toBe("UNKNOWN");
  await expect(
    service.controlCryptoBot({ id: "binance-demo", action: "start" }),
  ).rejects.toThrow("订单结果尚未确认");
});
it("detects external balance changes rather than adopting external holdings", async () => {
  await start();
  fixture.balances.BTC = "1";
  await service.tickCryptoBots();
  const status = await service.cryptoBotStatus("binance-demo");
  expect(status.bot?.status).toBe("paused");
  expect(status.bot?.positions.BTCUSDT).toBe("0");
  expect(status.bot?.error).toContain("余额与策略成交不一致");
});
it("a pause during price lookup blocks admission when that lookup returns", async () => {
  await start();
  fixture.now += 3590000;
  await service.tickCryptoBots();
  fixture.now += 10000;
  fixture.cross = true;
  fixture.waitPrice = new Promise<void>((resolve) => {
    fixture.releasePrice = resolve;
  });
  const tick = service.tickCryptoBots();
  // Allow the asynchronous adapter sequence to reach its quote request.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const pause = service.controlCryptoBot({
    id: "binance-demo",
    action: "pause",
  });
  fixture.releasePrice!();
  await Promise.all([tick, pause]);
  expect(fixture.sends).toBe(0);
  expect((await service.cryptoBotStatus("binance-demo")).bot?.status).toBe(
    "paused",
  );
});
it("does not expose secrets from status and refuses a changed account identity after first start", async () => {
  await start();
  await service.controlCryptoBot({ id: "binance-demo", action: "stop" });
  expect(
    JSON.stringify(await service.cryptoBotStatus("binance-demo")),
  ).not.toContain("secret");
  await expect(
    service.saveCryptoBotCredential({
      id: "binance-demo",
      apiKey: "other",
      apiSecret: "other",
    }),
  ).rejects.toThrow("不能替换凭证");
});

it("retains valid closed data throughout the hour without trading stale signals", async () => {
  await start();
  fixture.now += 1800000;
  await service.tickCryptoBots();
  expect((await service.cryptoBotStatus("binance-demo")).bot?.status).toBe(
    "running",
  );
  expect(fixture.sends).toBe(0);
});
it("reconstructs a crash-persisted intent from exchange facts without sending again", async () => {
  await start();
  const order = {
    clientId: "crashintent",
    symbol: "BTCUSDT",
    side: "BUY",
    quantity: "1",
    state: "INTENT",
    fills: [],
    createdAt: fixture.now,
    updatedAt: fixture.now,
    candleTime: fixture.now - 3600000,
  } as const;
  put(
    "crypto-orders-binance-demo",
    "crypto-order-binance-demo-crashintent",
    order,
  );
  fixture.remote.set(order.clientId, {
    ...order,
    state: "FILLED",
    executedQuantity: "1",
    fills: [
      {
        id: "recoveredfill",
        quantity: "1",
        price: "200",
        fee: "0.0001",
        feeAsset: "BTC",
      },
    ],
  });
  fixture.balances = { USDT: "800", BTC: "0.9999", ETH: "0" };
  await service.tickCryptoBots();
  expect(fixture.sends).toBe(0);
  expect(
    (await service.cryptoBotStatus("binance-demo")).bot?.positions.BTCUSDT,
  ).toBe("0.9999");
});
it("projects repeated partial fills once, then converges when the remaining execution arrives", async () => {
  await start();
  fixture.now += 3590000;
  await service.tickCryptoBots();
  fixture.now += 10000;
  fixture.cross = true;
  fixture.partial = true;
  await service.tickCryptoBots();
  expect(fixture.sends).toBe(1);
  await service.tickCryptoBots();
  let status = await service.cryptoBotStatus("binance-demo");
  expect(status.bot?.positions.BTCUSDT).toBe("0.9899");
  await service.controlCryptoBot({ id: "binance-demo", action: "pause" });
  const order = fixture.remote.values().next().value!;
  fixture.remote.set(order.clientId, {
    ...order,
    state: "FILLED",
    executedQuantity: "1.98",
    fills: [
      ...order.fills,
      {
        id: "remainder",
        quantity: "0.99",
        price: "200",
        fee: "0.0001",
        feeAsset: "BTC",
      },
    ],
  });
  fixture.balances.BTC = "1.9798";
  fixture.balances.USDT = "604";
  await service.tickCryptoBots();
  status = await service.cryptoBotStatus("binance-demo");
  expect(status.bot?.positions.BTCUSDT).toBe("1.9798");
  expect(fixture.sends).toBe(1);
});
it("a stop during an in-flight startup snapshot wins over its eventual response", async () => {
  await service.saveCryptoBot(config);
  await service.saveCryptoBotCredential({
    id: "binance-demo",
    apiKey: "k",
    apiSecret: "s",
  });
  let release!: () => void;
  fixture.snapshotWait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const starting = service.controlCryptoBot({
    id: "binance-demo",
    action: "start",
  });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await service.controlCryptoBot({ id: "binance-demo", action: "stop" });
  release();
  await expect(starting).rejects.toThrow("启停请求已被更新");
  expect((await service.cryptoBotStatus("binance-demo")).bot?.status).toBe(
    "stopped",
  );
});
it("sells only strategy units while preserving pre-existing BTC", async () => {
  fixture.balances.BTC = "3";
  await start();
  fixture.now += 3590000;
  await service.tickCryptoBots();
  fixture.now += 10000;
  fixture.cross = true;
  await service.tickCryptoBots();
  expect(fixture.balances.BTC).toBe("4.9799");
  // Transition to a flat baseline before the bearish crossing.
  fixture.now += 3590000;
  await service.tickCryptoBots();
  fixture.now += 10000;
  fixture.cross = false;
  await service.tickCryptoBots();
  fixture.now += 3590000;
  await service.tickCryptoBots();
  fixture.now += 10000;
  fixture.down = true;
  await service.tickCryptoBots();
  expect(
    (await service.cryptoBotStatus("binance-demo")).bot?.positions.BTCUSDT,
  ).toBe("0");
  expect(fixture.balances.BTC).toBe("3");
});
it("pauses on an external USDT movement and does not repair the account automatically", async () => {
  await start();
  fixture.balances.USDT = "900";
  await service.tickCryptoBots();
  expect((await service.cryptoBotStatus("binance-demo")).bot?.error).toContain(
    "USDT",
  );
  expect(fixture.sends).toBe(0);
});

it("retains sub-step fee dust and permits the next bullish entry", async () => {
  fixture.baseFee = "0.00001";
  await start();
  fixture.now += 3590000;
  await service.tickCryptoBots();
  fixture.now += 10000;
  fixture.cross = true;
  await service.tickCryptoBots();
  fixture.now += 3590000;
  await service.tickCryptoBots();
  fixture.now += 10000;
  fixture.cross = false;
  await service.tickCryptoBots();
  fixture.now += 3590000;
  await service.tickCryptoBots();
  fixture.now += 10000;
  fixture.down = true;
  await service.tickCryptoBots();
  expect(
    (await service.cryptoBotStatus("binance-demo")).bot?.positions.BTCUSDT,
  ).toBe("0.00009");
  expect((await service.cryptoBotStatus("binance-demo")).bot?.status).toBe(
    "running",
  );
  fixture.now += 3590000;
  await service.tickCryptoBots();
  fixture.now += 10000;
  fixture.down = false;
  fixture.cross = true;
  await service.tickCryptoBots();
  expect(
    (await service.cryptoBotStatus("binance-demo")).bot?.positions.BTCUSDT,
  ).toBe("1.98008");
  expect(fixture.sends).toBe(6);
});
it("pauses on changed immutable partial-fill evidence instead of rewriting history", async () => {
  await start();
  fixture.now += 3590000;
  await service.tickCryptoBots();
  fixture.now += 10000;
  fixture.cross = true;
  fixture.partial = true;
  await service.tickCryptoBots();
  const remote = fixture.remote.values().next().value!;
  fixture.remote.set(remote.clientId, {
    ...remote,
    fills: remote.fills.map((fill) => ({ ...fill, price: "201" })),
  });
  await service.tickCryptoBots();
  expect((await service.cryptoBotStatus("binance-demo")).bot?.error).toContain(
    "成交证据发生变化",
  );
  expect(
    (await service.cryptoBotStatus("binance-demo")).orders[0]?.fills[0]?.price,
  ).toBe("200");
});

it("versions account read contexts without exposing credentials or changing strategy state", async () => {
  await service.saveCryptoBot(config);
  await service.saveCryptoBotCredential({
    id: "binance-demo",
    apiKey: "first",
    apiSecret: "first-secret",
  });
  const first = await service.getCryptoAccountReadContext("binance-demo");
  const again = await service.getCryptoAccountReadContext("binance-demo");
  expect(first.revision).toBe(again.revision);
  expect(first.credential.apiKey).toBe("first");
  await service.saveCryptoBotCredential({
    id: "binance-demo",
    apiKey: "second",
    apiSecret: "second-secret",
  });
  const second = await service.getCryptoAccountReadContext("binance-demo");
  expect(second.revision).not.toBe(first.revision);
  const publicStatus = await service.cryptoBotStatus("binance-demo");
  expect(publicStatus.bot?.initialUsdt).toBeNull();
  expect(publicStatus.bot?.status).toBe("stopped");
  expect(JSON.stringify(publicStatus)).not.toContain("second-secret");
  expect(fixture.sends).toBe(0);
});
