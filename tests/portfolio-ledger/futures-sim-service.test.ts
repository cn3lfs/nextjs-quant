import { basename, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { futuresContracts } from "~/lib/market/futures";
import type { FuturesSimOrderConfirm } from "~/lib/portfolio/futures-sim";
import { put, sqlite } from "~/server/db";
import {
  confirmFuturesSimOrder,
  createFuturesSimAccount,
  listFuturesSimAccounts,
  previewFuturesSimOrder,
} from "~/server/portfolio/futures-sim-service";

let connection: ReturnType<typeof sqlite> | undefined;

beforeAll(() => {
  // tests/setup-data-dir.ts creates a fresh directory before this file runs.
  const dataDir = process.env.QUANT_DATA_DIR;
  if (!dataDir || !basename(dataDir).startsWith("quant-test-")) {
    throw new Error("Futures ledger tests require a Vitest QUANT_DATA_DIR");
  }
  connection = sqlite();
  expect(connection.name).toBe(join(dataDir, "quant.sqlite"));
});

afterAll(() => connection?.close());

const createCnyAccount = (initialCapital = "1000000") =>
  createFuturesSimAccount({
    name: "人民币模拟盘",
    currency: "CNY",
    initialCapital,
  });

const createUsdAccount = (initialCapital = "100000") =>
  createFuturesSimAccount({
    name: "美元模拟盘",
    currency: "USD",
    initialCapital,
  });

function readAccount(id: string) {
  const account = listFuturesSimAccounts().find((row) => row.id === id);
  if (!account) throw new Error(`Missing persisted futures account ${id}`);
  return account;
}

const domesticOrder = {
  symbol: "fuAUM",
  action: "buy_open",
  price: "600",
  quantity: 5,
  marginRate: 0.15,
} as const satisfies Omit<
  FuturesSimOrderConfirm,
  "accountId" | "clientRequestId"
>;

describe("futures simulated ledger (R3, BR1–BR2)", () => {
  it("defines each supported lot in units of its quoted price", () => {
    expect(
      Object.fromEntries(
        futuresContracts.map(({ symbol, contractMultiplier }) => [
          symbol,
          contractMultiplier,
        ]),
      ),
    ).toEqual({
      fuGC00Y: 100,
      fuAUM: 1000,
      fuSI00Y: 5000,
      fuAGM: 15,
      fuHG00Y: 25000,
      fuCUM: 5,
      fuALM: 5,
      fuALI: 25,
      fuRBM: 10,
      fuIM: 100,
      fuJMM: 60,
      fuJM: 100,
      fuCL00Y: 1000,
      fuB00Y: 1000,
      fuSCM: 1000,
    });
  });

  it("persists separate CNY and USD accounts with their opening cash", () => {
    const cny = createCnyAccount();
    const usd = createUsdAccount();
    expect(cny.id).not.toBe(usd.id);

    for (const [id, currency, capital] of [
      [cny.id, "CNY", "1000000.00"],
      [usd.id, "USD", "100000.00"],
    ] as const) {
      expect(readAccount(id)).toMatchObject({
        currency,
        initialCapital: capital,
        cash: capital,
        frozenMargin: "0.00",
        realizedPnl: "0.00",
        positions: [],
        trades: [],
      });
    }
  });

  it("freezes the exact opening margin and releases it proportionally when a long closes", () => {
    const account = createCnyAccount();
    const opening = { ...domesticOrder, accountId: account.id };

    // Five 1,000-gram lots at 600 CNY/g cost 3,000,000 CNY.
    expect(previewFuturesSimOrder(opening)).toMatchObject({
      contractMultiplier: 1000,
      notional: "3000000.00",
      requiredMargin: "450000.00",
      releasedMargin: "0.00",
      fee: "300.00",
      cashBefore: "1000000.00",
      cashAfter: "549700.00",
      positionQtyBefore: 0,
      positionQtyAfter: 5,
    });
    expect(readAccount(account.id)).toEqual(account);

    const opened = confirmFuturesSimOrder({
      ...opening,
      clientRequestId: "open-long",
    });
    expect(opened).toMatchObject({
      action: "buy_open",
      marginDelta: "450000.00",
      fee: "300.00",
      realizedPnl: "0.00",
    });
    const position = {
      symbol: "fuAUM",
      side: "long",
      quantity: 5,
      avgEntryPrice: "600.00",
      margin: "450000.00",
      marginRate: "0.15",
      contractMultiplier: 1000,
      costBasis: "3000000",
    };
    expect(readAccount(account.id)).toMatchObject({
      cash: "549700.00",
      frozenMargin: "450000.00",
      positions: [position],
      trades: [opened],
    });

    const partialClose = {
      ...opening,
      action: "sell_close",
      price: "650",
      quantity: 2,
    } as const;
    // Release two fifths of 450,000. Closing 2,000 grams earns 100,000 before fees.
    expect(previewFuturesSimOrder(partialClose)).toMatchObject({
      requiredMargin: "0.00",
      releasedMargin: "180000.00",
      fee: "130.00",
      estimatedPnl: "99870.00",
      cashAfter: "829570.00",
      positionQtyBefore: 5,
      positionQtyAfter: 3,
    });
    const partlyClosed = confirmFuturesSimOrder({
      ...partialClose,
      clientRequestId: "partially-close-long",
    });
    expect(partlyClosed).toMatchObject({
      action: "sell_close",
      marginDelta: "-180000.00",
      fee: "130.00",
      realizedPnl: "99870.00",
    });
    expect(readAccount(account.id)).toMatchObject({
      cash: "829570.00",
      frozenMargin: "270000.00",
      realizedPnl: "99870.00",
      positions: [
        { ...position, quantity: 3, margin: "270000.00", costBasis: "1800000" },
      ],
      trades: [partlyClosed, opened],
    });

    // Closing the remaining 3,000 grams at entry costs only the 180 CNY fee.
    const closed = confirmFuturesSimOrder({
      ...partialClose,
      price: "600",
      quantity: 3,
      clientRequestId: "close-remaining-long",
    });
    expect(closed).toMatchObject({
      marginDelta: "-270000.00",
      fee: "180.00",
      realizedPnl: "-180.00",
    });
    expect(readAccount(account.id)).toMatchObject({
      cash: "1099390.00",
      frozenMargin: "0.00",
      realizedPnl: "99690.00",
      positions: [],
      trades: [closed, partlyClosed, opened],
    });
  });

  it("settles the exact cost of two 1,000-gram lots despite a rounded display price", () => {
    const { id: accountId } = createCnyAccount();
    const order = {
      ...domesticOrder,
      accountId,
      quantity: 1,
      marginRate: "0.101",
    };
    expect(previewFuturesSimOrder(order)).toMatchObject({
      marginRate: "0.101",
      notional: "600000.00",
      requiredMargin: "60600.00",
    });
    confirmFuturesSimOrder({ ...order, clientRequestId: "first-lot" });
    expect(readAccount(accountId).positions[0]?.costBasis).toBe("600000");
    confirmFuturesSimOrder({
      ...order,
      price: "600.01",
      clientRequestId: "second-lot",
    });
    expect(readAccount(accountId)).toMatchObject({
      positions: [{ costBasis: "1200010", margin: "121201.01" }],
    });

    const close = {
      ...order,
      action: "sell_close",
      quantity: 2,
      price: "600.01",
    } as const;
    expect(previewFuturesSimOrder(close)).toMatchObject({
      notional: "1200020.00",
      grossPnl: "10.00",
      fee: "120.00",
      estimatedPnl: "-110.00",
    });
    expect(
      confirmFuturesSimOrder({ ...close, clientRequestId: "both-lots" }),
    ).toMatchObject({
      contractMultiplier: 1000,
      grossPnl: "10.00",
      realizedPnl: "-110.00",
      marginDelta: "-121201.01",
    });
    expect(readAccount(accountId)).toMatchObject({
      cash: "999770.00",
      frozenMargin: "0.00",
      positions: [],
    });
  });

  it("allocates a repeating fractional basis on a partial close and consumes its remainder on the last close", () => {
    const { id: accountId } = createCnyAccount();
    const order = { ...domesticOrder, accountId, quantity: 1, marginRate: 0.1 };
    confirmFuturesSimOrder({ ...order, clientRequestId: "one-lot" });
    confirmFuturesSimOrder({
      ...order,
      quantity: 2,
      price: "600.01",
      clientRequestId: "two-lots",
    });
    const close = { ...order, action: "sell_close", price: "600.01" } as const;
    expect(
      confirmFuturesSimOrder({ ...close, clientRequestId: "first-close" }),
    ).toMatchObject({
      grossPnl: "3.33",
      marginDelta: "-60000.67",
    });
    expect(
      confirmFuturesSimOrder({
        ...close,
        quantity: 2,
        clientRequestId: "last-close",
      }),
    ).toMatchObject({
      grossPnl: "6.67",
      marginDelta: "-120001.33",
    });
    expect(readAccount(accountId)).toMatchObject({
      cash: "999650.00",
      frozenMargin: "0.00",
      positions: [],
    });
  });

  it("keeps repeated partial closes exact on repeating-decimal cost basis (COMEX aluminum)", () => {
    const { id: accountId } = createUsdAccount("200000.00");
    confirmFuturesSimOrder({
      accountId,
      symbol: "fuALI",
      action: "buy_open",
      quantity: 1,
      price: "2500.00",
      marginRate: "0.1",
      clientRequestId: "ali-open-1",
    });
    confirmFuturesSimOrder({
      accountId,
      symbol: "fuALI",
      action: "buy_open",
      quantity: 5,
      price: "2500.25",
      marginRate: "0.1",
      clientRequestId: "ali-open-2",
    });
    confirmFuturesSimOrder({
      accountId,
      symbol: "fuALI",
      action: "sell_close",
      quantity: 1,
      price: "2500.25",
      marginRate: "0.1",
      clientRequestId: "ali-close-1",
    });
    confirmFuturesSimOrder({
      accountId,
      symbol: "fuALI",
      action: "sell_close",
      quantity: 1,
      price: "2500.25",
      marginRate: "0.1",
      clientRequestId: "ali-close-2",
    });
    const thirdClose = confirmFuturesSimOrder({
      accountId,
      symbol: "fuALI",
      action: "sell_close",
      quantity: 3,
      price: "2500.25",
      marginRate: "0.1",
      clientRequestId: "ali-close-3",
    });
    // Exact gross PnL = 3 * 25 * (2500.25 - (2500 + 5*2500.25)/6) = 3.125 -> 3.13
    expect(thirdClose.grossPnl).toBe("3.13");
  });

  it("closes a legacy position coherently at its original unit scale and blocks adding mixed-multiplier lots", () => {
    const account = createCnyAccount();
    put("futures-sim-account", account.id, {
      ...account,
      cash: "999939.94",
      frozenMargin: "60.00",
      positions: [
        {
          symbol: "fuAUM",
          name: "沪金主连",
          side: "long",
          quantity: 1,
          avgEntryPrice: "600.00",
          margin: "60.00",
          marginRate: 0.1,
        },
      ],
    });
    expect(readAccount(account.id).positions[0]).toMatchObject({
      contractMultiplier: 1,
      costBasis: "600",
    });
    expect(() =>
      previewFuturesSimOrder({
        ...domesticOrder,
        accountId: account.id,
        quantity: 1,
        price: "600.00",
        action: "buy_open",
      }),
    ).toThrow("旧版无乘数持仓");
    expect(
      confirmFuturesSimOrder({
        ...domesticOrder,
        accountId: account.id,
        quantity: 1,
        price: "650.00",
        action: "sell_close",
        clientRequestId: "close-old-position",
      }),
    ).toMatchObject({
      contractMultiplier: 1,
      grossPnl: "50.00",
      fee: "0.07",
      realizedPnl: "49.93",
      marginDelta: "-60.00",
    });
    expect(readAccount(account.id)).toMatchObject({
      frozenMargin: "0.00",
      cash: "1000049.87",
      positions: [],
    });
  });

  it("allows cash equal to the settled margin and fee when rounding removes a fraction of a cent", () => {
    const { id: accountId } = createCnyAccount("60660.12");
    // 600,000 × 0.101000201 = 60,600.1206, plus exactly 60 in fees.
    const preview = previewFuturesSimOrder({
      ...domesticOrder,
      accountId,
      quantity: 1,
      marginRate: "0.101000201",
    });
    expect(preview).toMatchObject({
      requiredMargin: "60600.12",
      fee: "60.00",
      cashAfter: "0.00",
    });
  });

  it.each([
    "",
    "NaN",
    "10.1%",
    "0.0499999999999999999",
    "1.0000000000000000001",
    NaN,
    Infinity,
  ])(
    "rejects invalid or out-of-range margin rate %s before booking a trade",
    (marginRate) => {
      const account = createCnyAccount();
      expect(() =>
        confirmFuturesSimOrder({
          ...domesticOrder,
          accountId: account.id,
          marginRate,
          clientRequestId: "invalid-rate",
        }),
      ).toThrow();
      expect(readAccount(account.id)).toEqual(account);
    },
  );

  it.each([
    {
      move: "up",
      close: "2450",
      fee: "49.00",
      pnl: "-10049.00",
      cash: "89903.00",
    },
    {
      move: "down",
      close: "2350",
      fee: "47.00",
      pnl: "9953.00",
      cash: "109905.00",
    },
  ])(
    "settles the signed net PnL when a USD short closes $move",
    ({ close, fee, pnl, cash }) => {
      const account = createUsdAccount();
      const opened = confirmFuturesSimOrder({
        accountId: account.id,
        symbol: "fuGC00Y",
        action: "sell_open",
        price: "2400",
        quantity: 2,
        marginRate: 0.1,
        clientRequestId: "open-short",
      });
      expect(opened).toMatchObject({
        contractMultiplier: 100,
        notional: "480000.00",
        marginDelta: "48000.00",
        fee: "48.00",
      });
      expect(readAccount(account.id)).toMatchObject({
        cash: "51952.00",
        frozenMargin: "48000.00",
        positions: [
          {
            symbol: "fuGC00Y",
            side: "short",
            quantity: 2,
            avgEntryPrice: "2400.00",
            margin: "48000.00",
          },
        ],
      });

      // Two COMEX lots are 200 ounces. A $50 move settles $10,000 before fees.
      const closed = confirmFuturesSimOrder({
        accountId: account.id,
        symbol: "fuGC00Y",
        action: "buy_close",
        price: close,
        quantity: 2,
        clientRequestId: "close-short",
      });
      expect(closed).toMatchObject({
        action: "buy_close",
        marginDelta: "-48000.00",
        fee,
        realizedPnl: pnl,
      });
      expect(readAccount(account.id)).toMatchObject({
        cash,
        frozenMargin: "0.00",
        realizedPnl: pnl,
        positions: [],
        trades: [closed, opened],
      });
    },
  );

  it.each([
    {
      scenario: "a USD contract in a CNY account",
      symbol: "fuGC00Y",
      capital: "1000000",
      error: "合约币种与期货模拟账户币种不匹配",
    },
    // The balance covers margin alone but falls short of the 450,300 total.
    {
      scenario: "cash that covers margin but falls short after fee",
      symbol: "fuAUM",
      capital: "450000",
      error: "可用资金不足",
    },
    {
      scenario: "an unknown contract",
      symbol: "fuUNKNOWN",
      capital: "1000000",
      error: "不支持的期货品种",
    },
  ])(
    "rejects $scenario without changing the ledger",
    ({ symbol, capital, error }) => {
      const account = createCnyAccount(capital);
      const order = { ...domesticOrder, accountId: account.id, symbol };
      expect(() => previewFuturesSimOrder(order)).toThrow(error);
      expect(() =>
        confirmFuturesSimOrder({ ...order, clientRequestId: "rejected" }),
      ).toThrow(error);
      expect(readAccount(account.id)).toEqual(account);
    },
  );

  it("rejects closing more than the held long quantity without changing the ledger", () => {
    const { id: accountId } = createCnyAccount();
    confirmFuturesSimOrder({
      ...domesticOrder,
      accountId,
      clientRequestId: "open-before-over-close",
    });
    const before = readAccount(accountId);
    const order = {
      ...domesticOrder,
      accountId,
      action: "sell_close",
      quantity: 6,
    } as const;

    expect(() => previewFuturesSimOrder(order)).toThrow("可平仓数量不足");
    expect(() =>
      confirmFuturesSimOrder({ ...order, clientRequestId: "over-close" }),
    ).toThrow("可平仓数量不足");
    expect(readAccount(accountId)).toEqual(before);
  });

  it("replays the original trade for a repeated clientRequestId without a second charge or fill", () => {
    const { id: accountId } = createCnyAccount();
    const order = {
      ...domesticOrder,
      accountId,
      clientRequestId: "retry-open",
    };
    const original = confirmFuturesSimOrder(order);
    const afterFirstFill = readAccount(accountId);
    expect(original.clientRequestId).toBe(order.clientRequestId);
    expect(afterFirstFill).toMatchObject({
      cash: "549700.00",
      frozenMargin: "450000.00",
      positions: [{ symbol: "fuAUM", side: "long", quantity: 5 }],
      trades: [original],
    });

    expect(confirmFuturesSimOrder(order)).toEqual(original);
    expect(readAccount(accountId)).toEqual(afterFirstFill);
  });
});
