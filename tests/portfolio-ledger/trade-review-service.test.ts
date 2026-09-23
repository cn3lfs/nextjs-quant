import Database from "better-sqlite3";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { afterEach, expect, it } from "vitest";
import { migrate } from "../../src/server/db/migrations";
import { commitDeliveryImport } from "../../src/server/portfolio/delivery-import-service";
import { DeliveryStore } from "../../src/server/portfolio/delivery-store";
import {
  buildTradeReviewSnapshot,
  exportTradeReview,
  replayTradeReview,
} from "../../src/server/portfolio/trade-review-service";
import type { Snapshot } from "../../src/lib/domain";
import { importDeliveryTable } from "../../src/lib/research/evidence/delivery-import";
import { parseDeliveryTable } from "../../src/lib/research/evidence/delivery-table";

it("R7 清仓恢复不改变残差，openingUnknown 与离线分段证据保留", () => {
  const parsed = importDeliveryTable(
    parseDeliveryTable(
      Buffer.from(
        "发生日期,业务名称,证券代码,发生金额,成交数量,成交价格,股份余额,资金余额\n" +
          "20260101,新股申购,370409,-1000,0,0,,\n" +
          "20260102,证券卖出,123190,1200,10,120,0,2495.90",
      ),
    ),
  );
  expect(parsed.fills).toHaveLength(1);
  expect(parsed.cashFlows).toHaveLength(1);
  const snapshot = replayTradeReview({
    version: 1,
    account: "R7 合成账户",
    trades: { fills: parsed.fills, cashFlows: parsed.cashFlows, bars: {} },
    nav: {
      openingCash: 2000,
      tradingDays: ["2026-01-01", "2026-01-02", "2026-01-03"],
    },
    dimensions: {},
    batches: [],
    sources: [],
    warnings: [],
    rpsPeriod: 250,
  });
  expect(snapshot.nav.days.map((day) => day.nav.value)).toEqual([
    1000, 2495.9, 2495.9,
  ]);
  expect(snapshot.unexplainedCashResidual.value).toBeCloseTo(295.9);
  expect(snapshot.projectedCashDays.map((day) => day.cash.value)).toEqual([
    1000, 2200, 2200,
  ]);
  expect(snapshot.trades.movingAverage.closedRounds[0]).toMatchObject({
    openingUnknown: true,
    netProfit: { value: null },
  });
  expect(snapshot.nav.segments[1]).toMatchObject({
    start: "2026-01-02",
    end: "2026-01-03",
    totalReturn: { value: 0 },
  });
  expect(
    exportTradeReview(
      replayTradeReview(JSON.parse(exportTradeReview(snapshot)).replayInput),
    ),
  ).toBe(exportTradeReview(snapshot));
});

it("reads exact-date RPS vectors and readonly classification files", async () => {
  const db = database();
  db.prepare("INSERT INTO rps_days VALUES (?,?)").run(
    "2026-01-05",
    JSON.stringify({
      date: "2026-01-05",
      periods: [250],
      counts: [10],
      inputHash: "rps-evidence",
    }),
  );
  const bytes = Buffer.alloc(16);
  bytes.writeDoubleLE(0.2, 0);
  bytes.writeDoubleLE(1, 8);
  db.prepare("INSERT INTO rps_values VALUES (?,?,?)").run(
    "sh600519",
    "2026-01-05",
    bytes,
  );
  const snapshot = await buildTradeReviewSnapshot(
    { ...options(db), blocksRoot: "tests/fixtures/tdx-local-blocks" },
    db,
    {
      readSnapshot: missing,
      readBlocks: async (_root, _checkpoint, category) => ({
        root: "fixture",
        hash: "blocks",
        files: [
          {
            name: category === "concept" ? "概念A" : "行业A",
            file: "A.txt",
            hash: "members-hash",
            mtimeMs: 0,
            members: ["sh600519"],
          },
        ],
      }),
    },
  );
  const groups = snapshot.attribution.movingAverage.groups;
  expect(groups.find((g) => g.dimension === "rps")!.items[0]!.name).toBe("≥90");
  expect(groups.find((g) => g.dimension === "industry")!.items[0]!.name).toBe(
    "行业A",
  );
  expect(groups.find((g) => g.dimension === "concept")!.items[0]!.name).toBe(
    "概念A",
  );
  expect(snapshot.replayInput.sources).toContainEqual({
    source: "rps_values",
    key: "sh600519/2026-01-05/250",
    hash: "rps-evidence",
  });
});

const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
function database(file = "ths-statement.html") {
  const db = new Database(":memory:");
  dbs.push(db);
  migrate(db);
  commitDeliveryImport(
    readFileSync(`tests/fixtures/delivery/${file}`),
    { account: "测试", source: "generic", fileName: file },
    db,
  );
  return db;
}
function options(db: Database.Database) {
  const store = new DeliveryStore(db);
  return {
    account: "测试",
    tradingDays: [
      ...new Set([
        ...store.fills().map((f) => f.tradeDate),
        ...store.cashFlows().map((f) => f.flowDate),
      ]),
    ].sort(),
  };
}
const missing = async (): Promise<Snapshot> => {
  throw new Error("missing fixture");
};
it("import -> snapshot -> JSON offline replay is identical, including missing quotes and cash residual", async () => {
  const db = database();
  const opts = { ...options(db), openingCash: 182445.55 };
  const snapshot = await buildTradeReviewSnapshot(opts, db, {
    readSnapshot: missing,
  });
  const again = await buildTradeReviewSnapshot(opts, db, {
    readSnapshot: missing,
  });
  expect(exportTradeReview(again)).toBe(exportTradeReview(snapshot));
  const exported = JSON.parse(exportTradeReview(snapshot)) as typeof snapshot;
  expect(exportTradeReview(replayTradeReview(exported.replayInput))).toBe(
    exportTradeReview(snapshot),
  );
  // First statement balance implies 200000 opening: 200000 - 182445.55.
  expect(snapshot.cashResiduals[0]!.value).toBeCloseTo(17554.45);
  expect(snapshot.unexplainedCashResidual).toHaveProperty("value");
  expect(snapshot.missingMarketData.map((r) => r.security)).toContain(
    "sh600519",
  );
  expect(snapshot.trades.movingAverage.closedRounds).toHaveLength(1);
  expect(snapshot.trades.fifo.closedRounds).toHaveLength(1);
  expect(
    snapshot.trades.movingAverage.closedRounds[0]!.feeSources[0]!.source,
  ).toBe("netAmount");
  expect(snapshot.replayInput.batches[0]!.fileHash).toMatch(/^[a-f0-9]{64}$/);
  expect(snapshot.replayInput.trades.cashFlows).toHaveLength(1);
  expect(
    snapshot.attribution.movingAverage.groups.find(
      (g) => g.dimension === "rps",
    )!.items[0]!.name,
  ).toBe("未知");
  expect(new DeliveryStore(db).cashFlows()).toHaveLength(1);
  const other = await buildTradeReviewSnapshot(
    { ...opts, account: "其他" },
    db,
    { readSnapshot: missing },
  );
  expect(other.replayInput.batches).toEqual([]);
  expect(other.trades.movingAverage.closedRounds).toEqual([]);
});

it("daily reconciliation recovers discarded statement trade rows without reimporting or changing NAV", async () => {
  const db = new Database(":memory:");
  dbs.push(db);
  migrate(db);
  const statement = Buffer.from(
    "日期,时间,操作,摘要,证券代码,成交价格,成交数量,发生金额,资金余额\n" +
      "20260102,090000,其他,银行转存,,,,1000,1000\n" +
      "20260102,100000,买入,证券买入,600000,10,25,-250,750",
  );
  commitDeliveryImport(
    statement,
    {
      account: "测试",
      source: "generic",
      fileName: "statement.csv",
      scope: "cashFlowsOnly",
    },
    db,
  );
  commitDeliveryImport(
    Buffer.from(
      "成交日期,成交时间,证券代码,业务名称,成交价格,成交数量,发生金额\n20260102,100000,600000,证券买入,10,25,-250",
    ),
    { account: "测试", source: "generic", fileName: "trade.csv" },
    db,
  );
  const store = new DeliveryStore(db);
  expect(store.fills("测试")).toHaveLength(1);
  expect(store.cashFlows("测试")).toHaveLength(1);
  const snapshot = await buildTradeReviewSnapshot(
    { ...options(db), openingCash: 0 },
    db,
    { readSnapshot: missing },
  );
  expect(snapshot.cashReconciliation.days).toMatchObject([
    {
      date: "2026-01-02",
      status: "matched",
      statementCash: 750,
      projectedCash: 750,
      difference: 0,
      evidence: [{ rowIndexes: [1, 2], order: "balance-chain" }],
    },
  ]);
  const withoutEvidence = replayTradeReview({
    ...snapshot.replayInput,
    batches: [],
  });
  expect(snapshot.nav).toEqual(withoutEvidence.nav);
  expect(snapshot.trades).toEqual(withoutEvidence.trades);
  expect(store.fills("测试")).toHaveLength(1);
  expect(store.cashFlows("测试")).toHaveLength(1);
  expect(
    exportTradeReview(
      replayTradeReview(JSON.parse(exportTradeReview(snapshot)).replayInput),
    ),
  ).toBe(exportTradeReview(snapshot));
});

it("daily statement balances stay on the source path when W10 moves an internal repayment", async () => {
  const db = new Database(":memory:");
  dbs.push(db);
  migrate(db);
  commitDeliveryImport(
    Buffer.from(
      "日期,时间,操作,摘要,证券代码,成交价格,成交数量,发生金额,资金余额\n" +
        "20260102,090000,其他,银行转存,,,,100,100\n" +
        "20260103,100000,其他,银行转取,,,,-100,0\n" +
        "20260103,110000,其他,银行转存,,,,100,100",
    ),
    {
      account: "测试",
      source: "generic",
      fileName: "repayment.csv",
      scope: "cashFlowsOnly",
    },
    db,
  );
  const original = await buildTradeReviewSnapshot(
    { ...options(db), openingCash: 0 },
    db,
    { readSnapshot: missing },
  );
  const replayInput = structuredClone(original.replayInput);
  replayInput.trades.cashFlows!.find(
    (flow) => flow.flowDate === "2026-01-03" && flow.amount > 0,
  )!.kind = "cashManagement";
  const moved = replayTradeReview(replayInput);
  expect(moved.nav.replay.map((event) => event.originalOrder)).not.toEqual(
    original.nav.replay.map((event) => event.originalOrder),
  );
  expect(moved.cashReconciliation).toEqual(original.cashReconciliation);
  expect(moved.cashReconciliation.summary).toMatchObject({
    matchedDays: 2,
    differenceDays: 0,
  });
  expect(moved.projectedCashDays).toEqual(original.projectedCashDays);
});

it.skipIf(process.env.P0_ACCOUNT_REAL_DATA !== "1")(
  "P0 real statement cash audit uses only an isolated in-memory import and prints aggregate evidence",
  async () => {
    const db = new Database(":memory:");
    dbs.push(db);
    migrate(db);
    for (const [fileName, scope] of [
      ["lishi20-26.xls", "all"],
      ["duizhang20-26.xls", "cashFlowsOnly"],
    ] as const)
      commitDeliveryImport(
        readFileSync(`.test-data/statements-v2/${fileName}`),
        { account: "测试", source: "ths", fileName, scope },
        db,
      );
    const snapshot = await buildTradeReviewSnapshot(
      { ...options(db), openingCash: 0 },
      db,
      { readSnapshot: missing },
    );
    const noEvidence = replayTradeReview({
      ...snapshot.replayInput,
      batches: [],
    });
    expect(snapshot.nav).toEqual(noEvidence.nav);
    expect(snapshot.trades).toEqual(noEvidence.trades);
    const historical = importDeliveryTable(
      parseDeliveryTable(
        readFileSync(".test-data/statements-v2/lishi20-26.xls"),
      ),
    );
    const statement = importDeliveryTable(
      parseDeliveryTable(
        readFileSync(".test-data/statements-v2/duizhang20-26.xls"),
      ),
      { scope: "cashFlowsOnly" },
    );
    // W10 used fills only from lishi, discarding its dividends/fees/subscriptions.
    // Keep that exact historical experiment separate from the full import path.
    const legacyDays = [
      ...new Set([
        ...historical.fills.map((fill) => fill.tradeDate),
        ...statement.cashFlows.map((flow) => flow.flowDate),
      ]),
    ].sort();
    const legacy = replayTradeReview({
      ...snapshot.replayInput,
      trades: {
        ...snapshot.replayInput.trades,
        fills: historical.fills,
        cashFlows: statement.cashFlows,
        tradingDays: legacyDays,
      },
      nav: { ...snapshot.replayInput.nav, tradingDays: legacyDays },
    });
    const additionalDays = [
      ...new Set(historical.cashFlows.map((flow) => flow.flowDate)),
    ]
      .filter((date) => !legacyDays.includes(date))
      .sort();
    expect(legacy.nav.days).toHaveLength(701);
    expect(
      legacy.nav.days.filter(
        (day) => day.cash.value !== null && day.cash.value < 0,
      ),
    ).toHaveLength(67);
    expect(historical.cashFlows).toHaveLength(96);
    expect(additionalDays).toHaveLength(17);
    expect(snapshot.nav.days.map((day) => day.date)).toEqual(
      [...legacyDays, ...additionalDays].sort(),
    );
    expect([legacyDays[0], legacyDays.at(-1)]).toEqual([
      "2021-01-25",
      "2026-06-18",
    ]);
    const inputDiagnosis = {
      auditInputDiagnosis: snapshot.replayInput.batches.map((batch) => ({
        hash: batch.fileHash,
        fills: snapshot.replayInput.trades.fills.filter(
          (fill) => Reflect.get(fill, "batchId") === batch.id,
        ).length,
        flows: Object.fromEntries(
          [
            ...new Set(
              snapshot.replayInput.trades.cashFlows!.map((flow) => flow.kind),
            ),
          ].map((kind) => {
            const rows = snapshot.replayInput.trades.cashFlows!.filter(
              (flow) =>
                flow.kind === kind && Reflect.get(flow, "batchId") === batch.id,
            );
            return [
              kind,
              {
                count: rows.length,
                total:
                  rows.reduce(
                    (sum, flow) => sum + Math.round(flow.amount * 100),
                    0,
                  ) / 100,
              },
            ];
          }),
        ),
      })),
      eventDays: snapshot.nav.days.length,
      start: snapshot.nav.days[0]?.date,
      end: snapshot.nav.days.at(-1)?.date,
      negativeDailyCashDays: snapshot.nav.days.filter(
        (day) => day.cash.value !== null && day.cash.value < 0,
      ).length,
      legacyW10: {
        basis:
          "lishi.fills + duizhang.cashFlows；未包括lishi的96条已有非成交流水，不等于完整入库路径",
        eventDays: legacyDays.length,
        negativeDailyCashDays: legacy.nav.days.filter(
          (day) => day.cash.value !== null && day.cash.value < 0,
        ).length,
        additionalFullImportDays: additionalDays.length,
        minimumDailyCash: Math.min(
          ...legacy.nav.days.flatMap((day) =>
            day.cash.value === null ? [] : [day.cash.value],
          ),
        ),
        minimumCash: legacy.nav.minimumCash,
        minimumDate: legacy.nav.minimumDate,
      },
    };
    expect(snapshot.cashReconciliation.summary.days).toBeGreaterThanOrEqual(
      701,
    );
    expect(
      snapshot.cashReconciliation.days.every((day) =>
        day.evidence.every((source) => source.rowIndexes.length > 0),
      ),
    ).toBe(true);
    expect(
      exportTradeReview(
        replayTradeReview(JSON.parse(exportTradeReview(snapshot)).replayInput),
      ),
    ).toBe(exportTradeReview(snapshot));
    const sourceReasons = new Map<string, number>();
    for (const day of snapshot.cashReconciliation.days)
      for (const source of day.evidence)
        if (source.reason)
          sourceReasons.set(
            source.reason,
            (sourceReasons.get(source.reason) ?? 0) + 1,
          );
    if (process.env.P0_ACCOUNT_REPORT_PATH) {
      const documents = resolve(homedir(), "Documents");
      const reportPath = resolve(process.env.P0_ACCOUNT_REPORT_PATH);
      const withinDocuments = relative(documents, reportPath);
      if (
        !withinDocuments ||
        withinDocuments === ".." ||
        withinDocuments.startsWith(`..${sep}`) ||
        isAbsolute(withinDocuments)
      )
        throw new Error(
          "P0_ACCOUNT_REPORT_PATH 必须是用户 Documents 目录内的文件",
        );
      mkdirSync(dirname(reportPath), { recursive: true });
      writeFileSync(
        reportPath,
        JSON.stringify(
          {
            version: 1,
            purpose:
              "私有账户逐日现金核对；不含原始行文本；不代表行情完整或策略业绩已验证",
            inputHashes: snapshot.replayInput.batches.map((batch) => ({
              batchId: batch.id,
              fileHash: batch.fileHash,
            })),
            inputDiagnosis,
            cashReconciliation: snapshot.cashReconciliation,
          },
          null,
          2,
        ),
        { encoding: "utf8", mode: 0o600 },
      );
    }
    console.log(
      JSON.stringify({
        ...inputDiagnosis,
        sourceHashes: snapshot.replayInput.batches.map(
          (batch) => batch.fileHash,
        ),
        cashReconciliation: snapshot.cashReconciliation.summary,
        sourceReasons: Object.fromEntries(sourceReasons),
        diagnosticCount: snapshot.cashReconciliation.diagnostics.length,
        minimumCash: snapshot.nav.minimumCash,
        minimumDate: snapshot.nav.minimumDate,
        minimumDailyCash: Math.min(
          ...snapshot.nav.days.flatMap((day) =>
            day.cash.value === null ? [] : [day.cash.value],
          ),
        ),
        rounds: snapshot.trades.movingAverage.closedRounds.length,
        marketData:
          "not loaded; cash-only audit, not validated investment returns",
      }),
    );
  },
);
it("failed transfers remain visible, optional blocks failures do not fail review", async () => {
  const db = database("ths-bank-flow.txt");
  const snapshot = await buildTradeReviewSnapshot(
    { ...options(db), blocksRoot: "fixture-only" },
    db,
    {
      readSnapshot: missing,
      readBlocks: async () => {
        throw new Error("unavailable");
      },
    },
  );
  expect(snapshot.excludedCashFlows.length).toBeGreaterThan(0);
  expect(
    snapshot.excludedCashFlows.every((r) => r.reason.includes("失败/作废")),
  ).toBe(true);
  expect(snapshot.warnings).toContain("industry：成分不可用，归入未知");
  expect(
    exportTradeReview(
      replayTradeReview(JSON.parse(exportTradeReview(snapshot)).replayInput),
    ),
  ).toBe(exportTradeReview(snapshot));
});
it("available quote evidence is exported without volatile read timestamps; partial coverage is listed", async () => {
  const db = database();
  let clock = 0;
  const reader = async (_root: string, symbol: string): Promise<Snapshot> => ({
    id: symbol,
    symbol,
    period: "day",
    source: "synthetic",
    adjustment: "none",
    createdAt: clock++,
    hash: "fixture-hash",
    bars: [
      {
        date: "2026-01-05",
        open: 1500,
        high: 1510,
        low: 1490,
        close: 1500,
        volume: 100,
        amount: 150000,
      },
    ],
  });
  const a = await buildTradeReviewSnapshot(options(db), db, {
    readSnapshot: reader,
  });
  const b = await buildTradeReviewSnapshot(options(db), db, {
    readSnapshot: reader,
  });
  expect(exportTradeReview(a)).toBe(exportTradeReview(b));
  expect(a.replayInput.sources).toContainEqual({
    source: "synthetic",
    key: "sh600519",
    hash: "fixture-hash",
  });
  expect(a.trades.tradePoints[0]!.dataReason).toBeNull();
  expect(a.missingMarketData.map((r) => r.security)).toContain("sh600519");
});

it("R10 逆回购债权贯通导出重放且不改变现金残差或回合分析", () => {
  const parsed = importDeliveryTable(
    parseDeliveryTable(
      readFileSync("tests/fixtures/delivery/ths-settlement.txt"),
    ),
  );
  // This older fixture labels both legs as sell; use R10's explicit buy redemption.
  const fills = parsed.fills
    .filter((f) => f.instrument === "reverseRepo")
    .map((f) => ({
      ...f,
      kind: f.netAmount! > 0 ? ("buy" as const) : ("sell" as const),
    }));
  expect(fills).toHaveLength(2);
  const snapshot = replayTradeReview({
    version: 1,
    account: "R10 合成账户",
    trades: { fills, cashFlows: [], bars: {} },
    nav: { tradingDays: ["2024-03-20", "2024-03-21", "2024-03-25"] },
    dimensions: {},
    batches: [],
    sources: [],
    warnings: [],
    rpsPeriod: 250,
  });
  expect(
    snapshot.nav.days.map((day) => day.reverseRepoPrincipal.value),
  ).toEqual([10000, 10000, 0]);
  expect(snapshot.nav.days.map((day) => day.nav.value)).toEqual([
    10715.71, 10715.71, 10717.5,
  ]);
  expect(snapshot.unexplainedCashResidual.value).toBeCloseTo(0);
  expect(snapshot.projectedCashDays.map((day) => day.cash.value)).toEqual([
    expect.closeTo(715.71),
    expect.closeTo(715.71),
    expect.closeTo(10717.5),
  ]);
  expect(snapshot.trades.movingAverage.closedRounds).toEqual([]);
  expect(snapshot.trades.fifo.closedRounds).toEqual([]);
  expect(snapshot.trades.tradePoints).toEqual([]);
  expect(snapshot.basis.cash).toContain(snapshot.nav.basis.reverseRepo);
  expect(
    exportTradeReview(
      replayTradeReview(JSON.parse(exportTradeReview(snapshot)).replayInput),
    ),
  ).toBe(exportTradeReview(snapshot));
});
