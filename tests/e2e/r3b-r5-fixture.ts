import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AlertRepository } from "../../src/server/db/alert-repository";
import { DeliveryStore } from "../../src/server/db/delivery-store";
import { parseDeliveryTable } from "../../src/lib/research/evidence/delivery-table";
import { importDeliveryTable } from "../../src/lib/research/evidence/delivery-import";
import { alertKey, type AlertEvent } from "../../src/lib/strategy-facts/alerts";
import { settingsSchema, type Bar } from "../../src/lib/domain";
import { defaultBacktestCosts } from "../../src/lib/backtest/backtest-costs";

/** R3b round-5 fixture: a real delivery-table import plus two same-day,
 * same-symbol manual trades. Synthetic QA data only, never forward evidence. */
const symbols = Array.from({ length: 21 }, (_, index) => `sh${600000 + index}`);
const account = "QA-r5-券商";
const deliveryDate = "2003-08-20";
const sameDay = "2025-03-06";

function dayFile(bars: readonly Bar[]) {
  return Buffer.concat(
    bars.map((bar) => {
      const row = Buffer.alloc(32);
      row.writeUInt32LE(Number(bar.date.replaceAll("-", "")), 0);
      [bar.open, bar.high, bar.low, bar.close].forEach((value, index) =>
        row.writeUInt32LE(Math.round(value * 100), 4 + index * 4),
      );
      row.writeFloatLE(bar.amount, 20);
      row.writeUInt32LE(bar.volume, 24);
      return row;
    }),
  );
}

export async function seedR3bR5Fixture(db: Database.Database, root: string) {
  const now = Date.now();
  // The base fixture pins an explicit user calendar; the delivery replay
  // requires it to cover the imported fill date.
  const settingsRow = db
    .prepare("SELECT payload FROM records WHERE id='settings'")
    .get() as { payload: string };
  const config = settingsSchema.parse(JSON.parse(settingsRow.payload));
  config.calendar = [...new Set([...config.calendar, deliveryDate])].sort();
  db.prepare("UPDATE records SET payload=? WHERE id='settings'").run(
    JSON.stringify(config),
  );
  // sh600000 keeps the base fixture's 2023-2025 bars (price visible, value
  // unknown for uncertified corporate actions). 19 symbols get old completed
  // bars whose last date is inside the fixture GBBQ coverage; sh600020 has no
  // bar file at all, so its missing price stays explicitly unknown.
  await mkdir(join(root, "vipdoc/sh/lday"), { recursive: true });
  for (const symbol of symbols.slice(1, 20)) {
    await writeFile(
      join(root, "vipdoc/sh/lday", `${symbol}.day`),
      dayFile(
        ["2003-08-29", "2003-09-01"].map((date) => ({
          date,
          open: 10,
          high: 10.5,
          low: 9.8,
          close: 10,
          volume: 100000,
          amount: 1000000,
        })),
      ),
    );
  }
  const header = [
    "成交日期",
    "证券代码",
    "证券名称",
    "买卖标志",
    "成交价格",
    "成交数量",
    "成交金额",
    "发生金额",
    "成交编号",
  ];
  const rows = symbols.map((symbol, index) => [
    deliveryDate,
    symbol.slice(2),
    `R5_${symbol.slice(2)}`,
    "买入",
    "10",
    "1000",
    "10000",
    "-10000",
    `R5-D-${index + 1}`,
  ]);
  const csv = [header, ...rows].map((cells) => cells.join(",")).join("\n");
  const table = parseDeliveryTable(csv);
  const parsed = importDeliveryTable(table);
  new DeliveryStore(db).commitImport({
    account,
    source: "generic",
    fileHash: createHash("sha256").update(csv).digest("hex"),
    fileName: "QA-r5-delivery.csv",
    importedAt: now,
    parsed,
    rawRows: table.rows,
    sourceHeader: table.header,
    format: table.format,
    encoding: table.encoding,
  });

  // Two manual trades on one day share symbol/side/price; their stable ids are
  // what distinguish them. One carries a normal suggestion, the other is
  // linked manually without plan/alert.
  for (const [suffix, quantity] of [
    ["a", 110],
    ["b", 120],
  ] as const) {
    const id = `QA-r5-sameday-${suffix}`;
    db.prepare("INSERT INTO trade_ledger VALUES(?,?,?,?)").run(
      id,
      "sh600001",
      sameDay,
      JSON.stringify({
        id,
        symbol: "sh600001",
        date: sameDay,
        side: "buy",
        price: 10,
        quantity,
        lowerLimit: 1,
        upperLimit: 20,
        limitSource: "QA",
        signalId: null,
        stop: 9,
        note: "QA R5 same-day pair",
        createdAt: Date.parse(sameDay),
        methods: [],
        costs: defaultBacktestCosts,
        fees: { commission: 0, tax: 0, slippage: 0, total: 0 },
      }),
    );
  }
  const repo = new AlertRepository(db);
  const strategy = repo
    .definitions()
    .find((s) => s.id === "QA-r3b-decay" && s.version === 1);
  if (!strategy) throw new Error("R3b R5 fixture requires the R3b seed");
  const identity = {
    strategyId: strategy.id,
    version: 1,
    market: "cn-equity" as const,
    symbol: "sh600001",
    bar: sameDay,
  };
  const observedAt = Date.parse(sameDay) - 86400000;
  const event: AlertEvent = {
    ...identity,
    key: alertKey(identity),
    type: "entry",
    price: 10,
    stop: 9,
    target: 20,
    sleeve: "swing",
    observedAt,
    mode: "shadow",
    status: "shadow",
    reason: "QA R5 synthetic same-day pair",
    source: "fixed QA",
    wouldSend: false,
    outcomes: [],
  };
  repo.record(strategy, event);
  repo.savePlan(
    {
      id: "QA-r5-plan",
      strategyId: strategy.id,
      strategyVersion: 1,
      market: "cn-equity",
      symbol: "sh600001",
      sleeve: "swing",
      triggerKey: event.key,
      entry: 10,
      stop: 9,
      target: 20,
      quantity: 230,
      tranches: 1,
      status: "open",
      expiresAt: null,
      createdAt: observedAt,
    },
    observedAt,
  );
}
