import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { settingsSchema } from "~/lib/domain";
import { importDeliveryTable } from "~/lib/research/evidence/delivery-import";
import { parseDeliveryTable } from "~/lib/research/evidence/delivery-table";
import { put, sqlite } from "~/server/db";
import { AccountWorkspaceRepository } from "~/server/db/account-workspace-repository";
import { DeliveryStore } from "~/server/db/delivery-store";
import { PaperRepository } from "~/server/db/paper-repository";
import {
  loadAccountBook,
  pageAccountBook,
} from "~/server/portfolio/account-workspace-service";
import {
  createFuturesSimAccount,
  confirmFuturesSimOrder,
} from "~/server/portfolio/futures-sim-service";
import { evaluateAccountPortfolioRisk } from "~/server/portfolio/portfolio-risk-service";
import {
  createSimAccount,
  confirmSimOrder,
} from "~/server/portfolio/sim-accounts/service";
import * as vault from "~/server/vault";

const today = "2026-11-25";
const lastClose = "2026-11-24";
const now = Date.parse(today + "T10:00:00+08:00");
const calendar = [
  "2026-01-05",
  "2026-01-06",
  "2026-01-07",
  "2026-01-08",
  lastClose,
  today,
];
function writeLocalQuotes(root: string) {
  for (const [symbol, price, scale] of [
    ["sh600000", 10, 100],
    ["sz000001", 11, 100],
    ["sh513100", 1.3, 1000],
  ] as const) {
    const dir = join(root, "vipdoc", symbol.slice(0, 2), "lday");
    mkdirSync(dir, { recursive: true });
    const bars = Buffer.alloc(calendar.length * 32);
    calendar.forEach((date, i) => {
      bars.writeUInt32LE(Number(date.replaceAll("-", "")), i * 32);
      for (const offset of [4, 8, 12, 16])
        bars.writeUInt32LE(
          Math.round((date === today ? 9999 : price) * scale),
          i * 32 + offset,
        );
      bars.writeFloatLE(100000, i * 32 + 20);
      bars.writeUInt32LE(10000, i * 32 + 24);
    });
    writeFileSync(join(dir, symbol + ".day"), bars);
  }
  const dir = join(root, "data/spot/daily/klines/BTCUSDT/1d");
  mkdirSync(dir, { recursive: true });
  for (const [date, price] of [
    [lastClose, 250],
    [today, 9999],
  ] as const) {
    const open = Date.parse(date);
    writeFileSync(
      join(dir, `BTCUSDT-1d-${date}.live.csv`),
      [
        open,
        price,
        price,
        price,
        price,
        100,
        open + 86400000 - 1,
        price * 100,
        1,
        50,
        price * 50,
        0,
      ].join(","),
    );
  }
}

function seedLegacyLedgers(db: ReturnType<typeof sqlite>) {
  const bytes = readFileSync("tests/fixtures/delivery/r3b-account.csv");
  const table = parseDeliveryTable(bytes);
  new DeliveryStore(db).commitImport({
    account: "broker",
    source: "generic",
    fileHash: createHash("sha256").update(bytes).digest("hex"),
    importedAt: 1,
    fileName: "r3b-account.csv",
    parsed: importDeliveryTable(table),
    rawRows: table.rows,
    sourceHeader: table.header,
  });
  new PaperRepository(db).create({
    id: "old-paper",
    market: "cn-equity",
    currency: "CNY",
    sleeve: "swing",
    startedAt: 1,
    initial: 10000,
    candidates: [],
    mirror: { venue: "off" },
    mirrorRevision: "1",
    revision: 0,
    lastBar: lastClose,
    lastRun: null,
    error: null,
    summary: null,
  });
  const lot = {
    symbol: "sh600000",
    strategyId: "old",
    sleeve: "swing",
    quantity: 100,
  };
  db.prepare("INSERT INTO paper_state(account_id,payload) VALUES(?,?)").run(
    "old-paper",
    JSON.stringify({
      request: {
        market: "cn-equity",
        instruments: [],
        strategies: [],
        calendar: [lastClose],
      },
      decisions: [],
      result: {
        fills: [{ ...lot, date: lastClose, price: 10, side: "buy", fee: 0 }],
        positions: [{ ...lot, key: "old:sh600000", cost: 1000, mark: 12.34 }],
        equity: [{ date: lastClose, equity: 10234, cash: 9000 }],
        curve: [],
      },
    }),
  );
}

it("preserves legacy CNY books and weights while projecting spot fees, completed marks and separate long/short futures margin", async () => {
  const db = sqlite(),
    repo = new AccountWorkspaceRepository(db);
  const root = join(process.env.QUANT_DATA_DIR!, "sources");
  writeLocalQuotes(root);
  const config = settingsSchema.parse({
    tdxRoot: root,
    binancePublicDataRoot: root,
    industryBlocksRoot: "",
  });
  const read = () =>
    loadAccountBook(repo, config, now, {
      context: {
        today,
        calendar,
        calendarSource: "fixture",
        evidence: () => ({ events: [], coverageEnd: today, source: "fixture" }),
      },
    });
  const fetch = vi.fn(() => {
    throw new Error("unexpected network read");
  });
  const secret = vi
    .spyOn(vault, "readSecret")
    .mockRejectedValue(new Error("unexpected credential read"));
  vi.stubGlobal("fetch", fetch);
  try {
    seedLegacyLedgers(db);
    put("mock-trading-config", "mock-trading-config", { enabled: true });
    const baseline = await read();
    const cache = (path: string, payload: unknown, fetchedAt: number) => {
      const rawBody = JSON.stringify(payload);
      return {
        path,
        rawBody,
        httpStatus: 200,
        failures: [],
        envelope: {
          quality: "validated",
          fetchedAt,
          payloadHash: createHash("sha256")
            .update(JSON.stringify(rawBody))
            .digest("hex"),
        },
      };
    };
    put("mock-diagnostics", "mock-diagnostics", [
      cache(
        "/pt_web_qry_stock",
        {
          result: [
            {
              zqdm: "510300",
              gpsl: "100",
              djsl: "50",
              kysl: "100",
              gpcb: "3.5",
            },
          ],
        },
        now - 2,
      ),
      cache(
        "/pt_qry_busin_nocache",
        {
          result: [
            {
              zqdm: "510300",
              mmlb: "买入",
              cjjg: "3.50",
              cjje: "175",
              cjsl: "50",
              cjsj: "09:45:30",
              fee: "1",
              trade_no: "F2",
              entrust_no: "E1",
            },
          ],
        },
        now - 1,
      ),
      cache("/pt_web_qry_stock", { data: [] }, now + 1),
    ]);
    const local = createSimAccount(
      { name: "股票与 ETF", market: "cn-equity", initialCapital: "10000" },
      db,
    );
    const crypto = createSimAccount(
      { name: "加密现货", market: "crypto", initialCapital: "1000" },
      db,
    );
    const buy = (
      accountId: string,
      symbol: string,
      quantity: string,
      price: string,
    ) =>
      confirmSimOrder(
        {
          accountId,
          symbol,
          side: "buy",
          quantity,
          price,
          tradeDate: lastClose,
          clientRequestId: symbol,
        },
        db,
        now,
      );
    buy(local.id, "sz000001", "100", "10");
    const etfReceipt = buy(local.id, "sh513100", "100", "1.237");
    buy(crypto.id, "BTCUSDT", "0.25", "200");

    const futures = createFuturesSimAccount({
      name: "黄金双向",
      currency: "CNY",
      initialCapital: "300000",
    });
    for (const [action, quantity, price] of [
      ["buy_open", 2, "600"],
      ["sell_open", 1, "610"],
    ] as const)
      confirmFuturesSimOrder({
        accountId: futures.id,
        symbol: "fuAUM",
        action,
        quantity,
        price,
        marginRate: "0.1",
        clientRequestId: action,
      });

    db.pragma("query_only=ON");
    const version = repo.version();
    const book = await read();
    expect(book.facts.thsMock).toMatchObject({
      source: "mock-diagnostics",
      lastRefreshedAt: now - 1,
    });
    expect(book.positions).toContainEqual(
      expect.objectContaining({
        kind: "ths-mock",
        symbol: "sh510300",
        quantity: 150,
        cost: 3.5,
        cacheSource: "/pt_web_qry_stock",
        refreshedAt: now - 2,
      }),
    );
    expect(book.trades).toContainEqual(
      expect.objectContaining({
        kind: "ths-mock",
        symbol: "sh510300",
        side: "buy",
        date: today,
        quantity: 50,
        price: 3.5,
        fees: 1,
        refreshedAt: now - 1,
      }),
    );
    expect(repo.version()).toBe(version);
    expect(fetch).not.toHaveBeenCalled();
    expect(secret).not.toHaveBeenCalled();
    expect(existsSync(join(process.env.QUANT_DATA_DIR!, "bar-store"))).toBe(
      false,
    );
    for (const kind of ["real", "paper", "exchange-simulation"] as const) {
      const page = pageAccountBook(book, { kind });
      expect(page.totals).toEqual(pageAccountBook(baseline, { kind }).totals);
      expect(page.items).toEqual(pageAccountBook(baseline, { kind }).items);
      expect(book.trades.filter((trade) => trade.kind === kind)).toEqual(
        baseline.trades.filter((trade) => trade.kind === kind),
      );
    }
    expect(pageAccountBook(book, { kind: "real" }).totals[0]?.value).toBe(1000);
    expect(pageAccountBook(book, { kind: "paper" }).totals[0]?.value).toBe(
      1234,
    );
    const spot = pageAccountBook(book, { kind: "local-sim" }).items;
    expect(spot).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account: local.id,
          accountName: local.name,
          symbol: "sz000001",
          cost: 10.055,
          quantity: 100,
          value: 1100,
          unrealizedPnl: 94.5,
        }),
        expect.objectContaining({
          account: local.id,
          symbol: "sh513100",
          cost: 1.2876,
          price: 1.3,
          value: 130,
        }),
        expect.objectContaining({
          account: crypto.id,
          market: "crypto",
          currency: "USDT",
          quantity: 0.25,
          price: 250,
          value: 62.5,
        }),
      ]),
    );
    expect(
      book.trades.filter((trade) => trade.kind === "local-sim"),
    ).toHaveLength(3);
    expect(book.trades).toContainEqual(
      expect.objectContaining({
        kind: "local-sim",
        account: local.id,
        time: etfReceipt.executedAt,
        side: "buy",
        price: 1.237,
        fees: 5.06,
      }),
    );
    expect(book.positions.filter((pos) => pos.kind === "futures-sim")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          direction: "long",
          quantity: 2,
          multiplier: 1000,
          marginUsed: 120000,
          notional: 1200000,
        }),
        expect.objectContaining({
          direction: "short",
          quantity: 1,
          multiplier: 1000,
          marginUsed: 61000,
          notional: 610000,
        }),
      ]),
    );
    expect(
      book.trades
        .filter((trade) => trade.kind === "futures-sim")
        .map((trade) => trade.side)
        .sort(),
    ).toEqual(["buy", "sell"]);
    for (const scope of ["real", "paper"] as const) {
      const risk = evaluateAccountPortfolioRisk(book, { scope }, now);
      const previous = evaluateAccountPortfolioRisk(baseline, { scope }, now);
      expect(risk.industries).toEqual(previous.industries);
      expect(risk.instruments).toEqual(previous.instruments);
      expect(risk.equityCny).toBe(previous.equityCny);
      expect(risk.instruments.map(({ key }) => key)).toEqual(["sh600000"]);
      expect(risk.futures).toEqual([
        {
          currency: "CNY",
          basis: "entry-notional",
          positions: 2,
          marginUsed: 181000,
          longNotional: 1200000,
          shortNotional: 610000,
          netNotional: 590000,
        },
      ]);
    }
  } finally {
    db.pragma("query_only=OFF");
    vi.unstubAllGlobals();
    secret.mockRestore();
  }
});
