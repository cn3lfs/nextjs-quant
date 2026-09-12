import Database from "better-sqlite3";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readTradeReviewSnapshot } from "../src/server/trade-review-market";
import { readSnapshot, parseBars } from "../src/server/tdx";
import { classifyCode } from "../src/lib/delivery-import";
import { migrate } from "../src/server/db/migrations";
import { commitDeliveryImport } from "../src/server/delivery-import-service";
import {
  buildTradeReviewSnapshot,
  replayTradeReview,
} from "../src/server/trade-review-service";

const roots: string[] = [];
it("指数点位不与成交均价比较，保留基准读取行为", async () => {
  const root = await fixture(["sh000300"]);
  const file = join(root, "vipdoc/sh/lday/sh000300.day");
  const bytes = await readFile(file);
  bytes.writeFloatLE(1_000_000, 20);
  await writeFile(file, bytes);
  const snapshot = await readTradeReviewSnapshot(root, "sh000300");
  expect(snapshot.bars).toEqual(
    (await readSnapshot(root, "sh000300", "day")).bars,
  );
  expect(snapshot.priceScale).toBeUndefined();
});
it("股票仍除100；共享parseBars和readSnapshot行为不变", async () => {
  const root = await fixture(["sh600000", "sh588200"]);
  const stock = await readTradeReviewSnapshot(root, "sh600000");
  expect(stock.priceScale).toMatchObject({
    divisor: 100,
    trusted: true,
    maxDeviation: 1,
  });
  expect(stock.bars).toEqual(
    (await readSnapshot(root, "sh600000", "day")).bars,
  );
  const bytes = await readFile(join(root, "vipdoc/sh/lday/sh588200.day"));
  expect(parseBars(bytes, "day").map((b) => b.close)).toEqual([100, 110]);
  expect(
    (await readTradeReviewSnapshot(root, "sh588200")).bars.map((b) => b.close),
  ).toEqual([10, 11]);
});

it.each(["deviation", "zero-volume", "quantity-unit"])(
  "不可信依据 %s 进入缺行情，不参与估值且诊断可离线重放",
  async (failure) => {
    const symbol = failure === "quantity-unit" ? "sh113502" : "sh588200";
    const root = await fixture([symbol, "sh000300"]);
    const file = join(root, "vipdoc/sh/lday", `${symbol}.day`);
    const bytes = await readFile(file);
    if (failure === "deviation") bytes.writeFloatLE(100, 20); // close 10 / average 1 = 10x
    if (failure === "zero-volume") {
      bytes.writeUInt32LE(0, 24);
      bytes.writeUInt32LE(0, 56);
    }
    await writeFile(file, bytes);
    const db = new Database(":memory:");
    try {
      migrate(db);
      commitDeliveryImport(
        Buffer.from(
          `成交日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额\n20260105,${symbol.slice(2)},买入,10,10,100,-100`,
        ),
        { account: "R12", source: "generic", fileName: "r12.csv" },
        db,
      );
      const result = await buildTradeReviewSnapshot(
        {
          account: "R12",
          tdxRoot: root,
          openingCash: 1000,
          tradingDays: ["2026-01-05", "2026-01-06"],
        },
        db,
      );
      expect(result.priceDiagnostics[symbol]?.trusted).toBe(false);
      expect(result.missingMarketData).toHaveLength(1);
      expect(result.missingMarketData[0]?.details.join()).toContain(
        "价格口径不可信",
      );
      expect(result.replayInput.trades.bars?.[symbol]).toBeUndefined();
      expect(result.nav.days.map((d) => d.marketValue.value)).toEqual([
        null,
        null,
      ]);
      expect(result.nav.days.map((d) => d.nav.value)).toEqual([null, null]);
      expect(result.replayInput.sources.some((s) => s.key === symbol)).toBe(
        true,
      );
      if (failure === "deviation")
        expect(result.priceDiagnostics[symbol]).toMatchObject({
          maxDeviation: 10,
          worstSample: { close: 10, average: 1 },
        });
      expect(
        replayTradeReview(JSON.parse(JSON.stringify(result.replayInput))),
      ).toEqual(result);
    } finally {
      db.close();
    }
  },
);

it("R12 ETF市值约9.9万，沪市转债按手、深市按张与成交金额一致", async () => {
  const root = await fixture(["sh588200", "sh113050", "sz123001", "sh000300"]);
  for (const [symbol, rawClose] of [
    ["sh588200", 1463],
    ["sh113050", 1449670],
    ["sz123001", 144967],
  ] as const) {
    const file = join(
      root,
      "vipdoc",
      symbol.slice(0, 2),
      "lday",
      `${symbol}.day`,
    );
    const bytes = await readFile(file);
    for (let i = 0; i < 2; i++) {
      for (const offset of [4, 8, 12, 16])
        bytes.writeUInt32LE(rawClose, i * 32 + offset);
      bytes.writeFloatLE((rawClose / 1000) * 100, i * 32 + 20);
    }
    await writeFile(file, bytes);
  }
  const db = new Database(":memory:");
  try {
    migrate(db);
    commitDeliveryImport(
      Buffer.from(
        "成交日期,证券代码,操作,成交价格,成交数量,成交金额,发生金额\n20260105,588200,买入,1.463,67700,99045.1,-99045.1\n20260105,113050,买入,144.967,10,14496.7,-14496.7\n20260105,123001,买入,144.967,100,14496.7,-14496.7",
      ),
      { account: "R12", source: "generic", fileName: "r12.csv" },
      db,
    );
    const result = await buildTradeReviewSnapshot(
      {
        account: "R12",
        tdxRoot: root,
        openingCash: 200000,
        tradingDays: ["2026-01-05", "2026-01-06"],
      },
      db,
    );
    expect(result.missingMarketData).toEqual([]);
    expect(result.replayInput.trades.bars?.sh588200?.[0]?.close).toBeCloseTo(
      1.463,
    );
    expect(result.nav.days[0]?.marketValue.value).toBeCloseTo(
      99045.1 + 14496.7 * 2,
    );
    expect(result.nav.days[0]?.nav.value).toBeCloseTo(200000);
    expect(result.priceDiagnostics.sh113050?.priceUnit).toContain("手");
    expect(result.priceDiagnostics.sz123001?.priceUnit).toBe("元/张");
  } finally {
    db.close();
  }
});
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(symbols: string[]) {
  const root = await mkdtemp(join(tmpdir(), "quant-r6-"));
  roots.push(root);
  for (const symbol of symbols) {
    const bytes = Buffer.alloc(64);
    const kind = classifyCode(symbol).instrument;
    const divisor = kind === "fund" || kind === "convertible" ? 1000 : 100;
    for (let i = 0; i < 2; i++) {
      bytes.writeUInt32LE(20260105 + i, i * 32);
      for (const offset of [4, 8, 12, 16])
        bytes.writeUInt32LE((10 + i) * divisor, i * 32 + offset);
      bytes.writeFloatLE((10 + i) * 100, i * 32 + 20);
      bytes.writeUInt32LE(100, i * 32 + 24);
    }
    const dir = join(root, "vipdoc", symbol.slice(0, 2), "lday");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${symbol}.day`), bytes);
  }
  return root;
}
it.each([
  "sh510300",
  "sz159915",
  "sz160105",
  "sh501001",
  "sh560001",
  "sh588000",
  "sh113502",
  "sz123001",
])("复盘读取合成日线 %s，选股门禁不变", async (symbol) => {
  const root = await fixture([symbol]);
  const snapshot = await readTradeReviewSnapshot(root, symbol);
  expect((await readTradeReviewSnapshot(root, symbol.slice(2))).bars).toEqual(
    snapshot.bars,
  );
  expect(snapshot.bars.map((b) => b.close)).toEqual([10, 11]);
  expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
  expect(snapshot.adjustment).toBe("none");
  expect(snapshot.priceScale).toMatchObject({
    divisor: 1000,
    trusted: true,
    checkedBars: 2,
    maxDeviation: 1,
  });
  for (const bar of snapshot.bars)
    expect(bar.close).toBe(bar.amount / bar.volume);
  await expect(readSnapshot(root, symbol, "day")).rejects.toThrow("仅支持A股");
});
it("损坏、空文件与路径越界不产生行情；逆回购明确拒绝", async () => {
  const root = await fixture(["sh510300"]);
  const path = join(root, "vipdoc/sh/lday/sh510300.day");
  await writeFile(path, Buffer.alloc(31));
  await expect(readTradeReviewSnapshot(root, "sh510300")).rejects.toThrow(
    "32 字节",
  );
  await writeFile(path, Buffer.alloc(0));
  await expect(readTradeReviewSnapshot(root, "sh510300")).rejects.toThrow(
    "为空",
  );
  await expect(readTradeReviewSnapshot(root, "../sh510300")).rejects.toThrow();
  for (const symbol of ["sh204001", "sz131810"])
    await expect(readTradeReviewSnapshot(root, symbol)).rejects.toThrow(
      "年化利率",
    );
});
it("导入到复盘：基金与转债持仓可估值，逆回购计本金，缺文件仍列缺行情", async () => {
  const root = await fixture(["sh510300", "sz159915", "sh113502", "sh000300"]);
  const db = new Database(":memory:");
  try {
    migrate(db);
    const text = [
      "成交日期\t证券代码\t操作\t成交价格\t成交数量\t成交金额\t发生金额",
      "20260105\t510300\t买入\t10\t10\t100\t-100",
      "20260105\t159915\t买入\t10\t10\t100\t-100",
      "20260105\t113502\t买入\t1\t10\t100\t-100",
      "20260105\t204001\t卖出\t2\t1\t1000\t-1000",
      "20260106\t799999\t验资\t0\t0\t0\t0",
      "20260106\t708162\t申购配号\t0\t0\t0\t0",
    ].join("\n");
    commitDeliveryImport(
      Buffer.from(text),
      { account: "R6", source: "generic", fileName: "r6.txt" },
      db,
    );
    const options = {
      account: "R6",
      tdxRoot: root,
      openingCash: 2000,
      tradingDays: ["2026-01-05", "2026-01-06"],
    };
    const result = await buildTradeReviewSnapshot(options, db);
    expect(result.nav.days.map((d) => d.marketValue.value)).toEqual([300, 330]);
    expect(result.nav.days.map((d) => d.nav.value)).toEqual([2000, 2030]);
    expect(result.nav.days.map((d) => d.reverseRepoPrincipal.value)).toEqual([
      1000, 1000,
    ]);
    expect(result.nav.warnings.join()).toContain("跳过 2 笔");
    expect(result.missingMarketData).toEqual([]);
    expect(result.trades.tradePoints).toHaveLength(3);
    expect(result.trades.tradePoints.every((p) => p.dataReason === null)).toBe(
      true,
    );
    expect(
      replayTradeReview(JSON.parse(JSON.stringify(result.replayInput))),
    ).toEqual(result);
    await rm(join(root, "vipdoc/sh/lday/sh113502.day"));
    const missing = await buildTradeReviewSnapshot(options, db);
    expect(missing.missingMarketData.map((m) => m.security)).toEqual([
      "sh113502",
    ]);
    expect(missing.nav.days.map((d) => d.nav.value)).toEqual([null, null]);
  } finally {
    db.close();
  }
});
