import { beforeEach, afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { migrate } from "../../src/server/db/migrations";
import { seedTradeWorkspace } from "../helpers/trade-workspace-fixture";
import { defaultBacktestCosts } from "../../src/lib/backtest/backtest-costs";
import { tradeFees, type Trade } from "../../src/lib/portfolio/trade-ledger";
import {
  tradeWorkspacePage,
  tradeWorkspaceDetail,
  tradeWorkspaceExport,
  tradeWorkspaceCsv,
  tradeSignalOptions,
  tradeAdjustmentPage,
  tradeAdjustmentDetail,
} from "../../src/server/portfolio/trade-workspace-query";
let db: Database.Database;
const trade = (i: number): Trade => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  symbol: i % 2 ? "sh600001" : "sh600000",
  date: i < 40 ? "2026-01-02" : "2026-01-05",
  createdAt: Math.floor(i / 3),
  side: "buy",
  price: 10,
  quantity: 100,
  lowerLimit: 9,
  upperLimit: 11,
  limitSource: "fixture",
  signalId: i % 3 ? null : "signal-known",
  stop: 9,
  note: i % 2 ? "中文\n备注" : "=SUM(1,2)",
  fees: tradeFees({ price: 10, quantity: 100, side: "buy" }),
  costs: { ...defaultBacktestCosts },
  methods: [
    {
      skillId: "fixture",
      ruleVersion: "1",
      outputSchema: "1",
      files: [{ file: "evidence", hash: "a".repeat(64) }],
      prerequisites: ["原始依据".repeat(1000)],
    },
  ],
});
const insert = (t: Trade) =>
  db
    .prepare("INSERT INTO trade_ledger VALUES(?,?,?,?)")
    .run(t.id, t.symbol, t.date, JSON.stringify(t));
beforeEach(() => {
  db = new Database(":memory:");
  migrate(db);
  db.transaction(() => {
    for (let i = 0; i < 65; i++) insert(trade(i));
  })();
});
afterEach(() => db.close());
it("pages complete adjustment history while loading original source only for its detail", () => {
  const insert = db.prepare("INSERT INTO trade_adjustments VALUES(?,?,?)");
  for (let i = 0; i < 25; i++) {
    const id = i.toString(16).padStart(64, "0");
    insert.run(
      id,
      "sh600000",
      JSON.stringify({
        id,
        symbol: "sh600000",
        event: { date: "2026-01-05", name: "除息" },
        source: "完整来源".repeat(1000),
        beforeQuantity: 100,
        afterQuantity: 100,
        beforeCost: 10,
        afterCost: null,
      }),
    );
  }
  const first = tradeAdjustmentPage(db, {}),
    second = tradeAdjustmentPage(db, { cursor: first.nextCursor });
  expect(first.count).toBe(25);
  expect(first.items).toHaveLength(20);
  expect(second.items).toHaveLength(5);
  expect(second.nextCursor).toBeNull();
  expect(JSON.stringify(first)).not.toContain("完整来源");
  expect(tradeAdjustmentDetail(db, first.items[0]!.id)?.source).toBe(
    "完整来源".repeat(1000),
  );
  expect(() =>
    tradeAdjustmentPage(db, { symbol: "sh600001", cursor: first.nextCursor }),
  ).toThrow("筛选已变化");
});
it("selects only same-security signals available by the trade date without loading evidence", () => {
  const insertSignal = db.prepare("INSERT INTO signal_ledger VALUES(?,?,?,?)");
  for (let i = 0; i < 45; i++) {
    const id = `s-${String(i).padStart(3, "0")}`,
      symbol = i === 44 ? "sh600001" : "sh600000",
      date = i === 43 ? "2026-02-01" : "2026-01-02";
    insertSignal.run(
      id,
      symbol,
      date,
      JSON.stringify({
        strategy: "czsc",
        invalidation: "核对",
        evidence: "大正文".repeat(10000),
      }),
    );
  }
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = tradeSignalOptions(db, {
      symbol: "sh600000",
      date: "2026-01-05",
      cursor,
    });
    expect(JSON.stringify(page)).not.toContain("大正文");
    ids.push(...page.items.map((row) => row.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  expect(ids).toHaveLength(43);
  expect(new Set(ids).size).toBe(43);
  expect(ids).not.toContain("s-043");
  expect(ids).not.toContain("s-044");
  const first = tradeSignalOptions(db, {
    symbol: "sh600000",
    date: "2026-01-05",
  });
  expect(() =>
    tradeSignalOptions(db, {
      symbol: "sh600001",
      date: "2026-01-05",
      cursor: first.nextCursor,
    }),
  ).toThrow("条件已变化");
});
it("traverses all immutable facts in stable date/time/id order and keeps full matching totals", () => {
  const ids: string[] = [];
  let cursor: string | undefined;
  do {
    const page = tradeWorkspacePage(db, { cursor });
    expect(page.items.length).toBeLessThanOrEqual(20);
    expect(page.summary).toMatchObject({ count: 65, buys: 65, sells: 0 });
    expect(page.summary.fees).toBeCloseTo(65 * 5.5);
    ids.push(...page.items.map((t) => t.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  const expected = db
    .prepare(
      "SELECT id FROM trade_ledger ORDER BY trade_date DESC,json_extract(payload,'$.createdAt') DESC,id DESC",
    )
    .all() as { id: string }[];
  expect(ids).toEqual(expected.map((t) => t.id));
  expect(new Set(ids).size).toBe(65);
  const first = tradeWorkspacePage(db, {});
  expect(JSON.stringify(first)).not.toContain("原始依据");
  expect(JSON.stringify(first)).not.toContain('"methods"');
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(65536);
  // Run the same guards against deliberately invalid outputs, proving sensitivity.
  const metadataGuard = (value: unknown) => {
    expect(JSON.stringify(value)).not.toContain('"methods"');
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(65536);
  };
  const totalGuard = (value: typeof first) =>
    expect(value.summary.count).toBe(65);
  metadataGuard(first);
  totalGuard(first);
  expect(() => metadataGuard({ ...first, items: [trade(0)] })).toThrow();
  expect(() =>
    totalGuard({
      ...first,
      summary: { ...first.summary, count: first.items.length },
    }),
  ).toThrow();
});
it("traverses the independent 1000-trade, 200-security fixture and exports the same complete facts", () => {
  const fixture = new Database(":memory:");
  try {
    migrate(fixture);
    seedTradeWorkspace(fixture, 1000);
    const ids: string[] = [];
    let cursor: string | undefined;
    do {
      const page = tradeWorkspacePage(fixture, { cursor });
      expect(page.summary.count).toBe(1000);
      ids.push(...page.items.map((row) => row.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(new Set(ids).size).toBe(1000);
    const exported = tradeWorkspaceExport(fixture, {});
    expect(exported.trades.map((row) => row.id)).toEqual(ids);
    expect(new Set(exported.trades.map((row) => row.symbol)).size).toBe(200);
  } finally {
    fixture.close();
  }
});
it("filters real dates, exact symbols, relation and literal Chinese notes independently of paging", () => {
  const result = tradeWorkspacePage(db, {
    symbol: "sh600001",
    from: "2026-01-02",
    to: "2026-01-02",
    query: "中文",
    linked: false,
  });
  expect(result.summary.count).toBe(13);
  expect(
    result.items.every(
      (t) =>
        t.symbol === "sh600001" &&
        t.date === "2026-01-02" &&
        t.signalId === null,
    ),
  ).toBe(true);
  expect(tradeWorkspacePage(db, { query: "%_" }).summary.count).toBe(0);
  expect(() => tradeWorkspacePage(db, { from: "2026-02-30" })).toThrow();
  expect(() =>
    tradeWorkspacePage(db, { from: "2026-02-01", to: "2026-01-01" }),
  ).toThrow();
});
it("rejects malformed, filter-mismatched and superseded cursors instead of skipping a backdated insertion", () => {
  const first = tradeWorkspacePage(db, {});
  expect(() => tradeWorkspacePage(db, { cursor: "bad" })).toThrow("分页");
  expect(() =>
    tradeWorkspacePage(db, { cursor: first.nextCursor, query: "中文" }),
  ).toThrow("筛选条件");
  insert({ ...trade(100), date: "2026-01-02" });
  expect(() => tradeWorkspacePage(db, { cursor: first.nextCursor })).toThrow(
    "账本已更新",
  );
  expect(() => tradeWorkspaceExport(db, { version: first.version })).toThrow(
    "账本已更新",
  );
});
it("exports all matching original facts, retains full evidence and safely quotes CSV", () => {
  const result = tradeWorkspaceExport(db, {});
  expect(result.count).toBe(65);
  expect(result.trades.find((t) => t.id === trade(0).id)).toEqual(trade(0));
  const detail = tradeWorkspaceDetail(db, trade(0).id);
  expect(detail?.trade).toEqual(trade(0));
  expect(detail?.linkedSignal).toBeNull();
  expect(detail?.trade.signalId).toBe("signal-known");
  expect(tradeWorkspaceDetail(db, trade(999).id)).toBeNull();
  const csv = tradeWorkspaceCsv([
    trade(0),
    { ...trade(1), note: '\t@evil,"quoted"\nnext' },
  ]);
  expect(csv).toContain("'=SUM(1,2)");
  expect(csv).toContain('\'\t@evil,""quoted""\nnext');
  expect(tradeWorkspaceExport(db, { symbol: "sh600001" }).count).toBe(32);
});
