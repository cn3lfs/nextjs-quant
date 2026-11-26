import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chartCost } from "~/lib/chart/chart-view";
import { parseTradeReviewRef } from "~/lib/chart/chart-trade-marks";
import { parseDeliveryTable } from "~/lib/research/evidence/delivery-table";
import { importDeliveryTable } from "~/lib/research/evidence/delivery-import";
import { marketRouter } from "~/server/api/routers/market";
import { accountsRouter } from "~/server/api/routers/accounts";
import { barReplayRouter } from "~/server/api/routers/bar-replay";
import { put, sqlite } from "~/server/db";
import { DeliveryStore } from "~/server/db/delivery-store";
import {
  confirmSimOrder,
  createSimAccount,
} from "~/server/portfolio/sim-accounts/service";

it("reads an open local cost and a closed account-specific B/S round with fees and raw daily extremes", async () => {
  const symbol = "sh600000",
    dates = ["2026-01-05", "2026-01-06"];
  const db = sqlite();
  const root = join(process.env.QUANT_DATA_DIR!, "chart-sources");
  const directory = join(root, "vipdoc/sh/lday");
  mkdirSync(directory, { recursive: true });
  const bytes = Buffer.alloc(64);
  dates.forEach((date, i) => {
    const offset = i * 32;
    bytes.writeUInt32LE(Number(date.replaceAll("-", "")), offset);
    const ohlc = i === 0 ? [1000, 1100, 900, 1000] : [1100, 1200, 1000, 1100];
    ohlc.forEach((value, j) =>
      bytes.writeUInt32LE(value, offset + 4 * (j + 1)),
    );
    bytes.writeFloatLE(100000, offset + 20);
    bytes.writeUInt32LE(1000, offset + 24);
  });
  writeFileSync(join(directory, symbol + ".day"), bytes);
  put("settings", "settings", { tdxRoot: root, calendar: dates });
  const headers = new Headers();
  const market = marketRouter.createCaller({ headers });
  const review = barReplayRouter.createCaller({ headers });
  const account = createSimAccount(
    { name: "图表复盘", market: "cn-equity", initialCapital: "10000" },
    db,
  );
  const trade = (
    accountId: string,
    side: "buy" | "sell",
    date: string,
    price: string,
  ) =>
    confirmSimOrder(
      {
        accountId,
        side,
        tradeDate: date,
        price,
        symbol,
        quantity: "100",
        clientRequestId: side,
      },
      db,
    );
  const entry = trade(account.id, "buy", dates[0]!, "10");
  const open = await market.chartPosition(symbol);
  expect(open).toMatchObject({
    source: "local-sim",
    account: account.id,
    quantity: 100,
    adjustedCost: 10.055,
  });
  expect(chartCost(open ?? undefined)).toBe(10.055);
  for (const adjustment of ["forward", "backward"] as const)
    expect(await market.chartPosition({ symbol, adjustment })).toBeNull();
  const exit = trade(account.id, "sell", dates[1]!, "11");
  expect(await market.chartPosition(symbol)).toBeNull();
  const second = createSimAccount(
    { name: "独立账户", market: "cn-equity", initialCapital: "10000" },
    db,
  );
  trade(second.id, "buy", dates[0]!, "9");
  const page = await accountsRouter.createCaller({ headers }).accountTrades({
    kind: "local-sim",
    symbol,
    tradeId: `local-sim:${account.id}:${exit.fillId}`,
  });
  const href = new URL(page.trades[0]!.chartHref!, "http://localhost");
  expect(href.pathname).toBe("/scan");
  const ref = parseTradeReviewRef(href.searchParams);
  expect(ref?.accountId).toBe(account.id);
  const evidence = await review.chartTradeReview(ref!);
  expect(evidence.adjustment).toBe("none");
  expect(
    evidence.fills.map((f) => [f.date, f.side, f.price, f.tradeId]),
  ).toEqual([
    [dates[0], "buy", 10, `local-sim:${account.id}:${entry.fillId}`],
    [dates[1], "sell", 11, `local-sim:${account.id}:${exit.fillId}`],
  ]);
  expect(evidence.boxes).toHaveLength(1);
  const box = evidence.boxes[0]!;
  expect(box).toMatchObject({
    entryPrice: 10,
    exitPrice: 11,
    maeDate: dates[0],
    maePrice: 9,
    mfeDate: dates[1],
    mfePrice: 12,
    holdingDays: 2,
  });
  expect(box.pnlAmount).toBeCloseTo(88.4, 10);
  expect(box.maePct).toBeCloseTo(-10);
  expect(box.mfePct).toBeCloseTo(20);

  const raw = readFileSync("tests/fixtures/delivery/r3b-account.csv");
  const table = parseDeliveryTable(raw);
  new DeliveryStore(db).commitImport({
    account: "broker",
    source: "generic",
    fileHash: createHash("sha256").update(raw).digest("hex"),
    fileName: "delivery.csv",
    importedAt: 1,
    parsed: importDeliveryTable(table),
    rawRows: table.rows,
    sourceHeader: table.header,
  });
  expect(await market.chartPosition(symbol)).toMatchObject({
    source: "real",
    account: "broker",
    quantity: 100,
    accounts: expect.arrayContaining([
      expect.objectContaining({ account: second.id, source: "local-sim" }),
    ]),
  });
});
