import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { migrate } from "../src/server/db/migrations";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TradeReviewResults } from "../src/components/trade-review-results";

const state = vi.hoisted(() => ({
  scale: false,
  db: null as Database.Database | null,
  days: [
    "2026-01-05",
    "2026-01-06",
    "2026-01-07",
    "2026-01-08",
    "2026-01-09",
    "2026-01-12",
    "2026-01-13",
    "2026-01-14",
    "2026-01-15",
    "2026-01-16",
    "2026-01-19",
    "2026-01-20",
  ],
}));
vi.mock("../src/server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/db")>()),
  sqlite: () => state.db!,
}));
vi.mock("../src/server/infra/settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/server/infra/settings")>()),
  settings: () => ({
    tdxRoot: "fixture-missing-root",
    calendar: state.days,
    industryBlocksRoot: "",
  }),
}));
vi.mock("../src/server/market/data-health", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/server/market/data-health")
  >()),
  fullLocalCalendarReference: async () => ({
    days: state.days,
    coverage: {
      start: state.days[0] ?? null,
      end: state.days.at(-1) ?? null,
      count: state.days.length,
    },
    source: "合成完整交易日历",
    hash: "fixture-calendar",
  }),
}));
vi.mock("../src/server/data-sources/tdx/tdx", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/server/data-sources/tdx/tdx")
  >()),
  readSnapshot: async (_root: string, symbol: string) => {
    if (state.scale)
      return {
        id: "r13",
        symbol,
        period: "day",
        source: "synthetic",
        adjustment: "none",
        createdAt: 0,
        hash: "r13",
        bars: state.days.map((date) => ({
          date,
          open: 10,
          high: 10,
          low: 10,
          close: 10,
          volume: 1000,
          amount: 10000,
        })),
      };
    throw new Error("合成样本无行情");
  },
}));
import { createCaller } from "../src/server/api/root";
import { r13Days, r13Statement } from "./r13-scale-fixture";
import { DeliveryStore } from "../src/server/portfolio/delivery-store";
const caller = createCaller({ headers: new Headers() });
const input = {
  path: resolve("tests/fixtures/delivery/tdx-statement.txt"),
  account: "合成账户",
  source: "tdx" as const,
};
it("U4 tRPC pages execution details and exports the complete redacted selection", async () => {
  const preview = await caller.deliveryPreview(input);
  await caller.deliveryImport({ ...input, hash: preview.fileHash });
  const first = await caller.tradeReviewExecution({
    account: input.account,
    pageSize: 1,
  });
  const second = await caller.tradeReviewExecution({
    account: input.account,
    pageSize: 1,
    pageIndex: 1,
  });
  expect(first.rows).toHaveLength(1);
  expect(second.rows).toHaveLength(1);
  expect(first.rows[0]?.id).not.toBe(second.rows[0]?.id);
  expect(first.summary).toEqual(second.summary);
  expect(first.benchmark).toEqual({ kind: "dayVwap" });
  expect(first.loss.value).toBeNull();
  expect(first.loss.reason).toContain("缺少可得 VWAP");
  expect(first).not.toHaveProperty("counterfactual");
  expect(first).not.toHaveProperty("replayInput");
  const csv = await caller.tradeReviewExecutionExport({
    account: input.account,
    pageSize: 1,
    pageIndex: 99,
  });
  expect(csv.split("\r\n")).toHaveLength(first.rowCount + 1);
  expect(csv).not.toContain(input.account);
  await expect(
    caller.tradeReviewExecution({ account: input.account, pageSize: 101 }),
  ).rejects.toThrow();
  await expect(
    caller.tradeReviewExecution({ account: input.account, minAmount: -1 }),
  ).rejects.toThrow();
});
it("U2 tRPC pages the held-symbol matrix and rejects invalid pagination", async () => {
  const preview = await caller.deliveryPreview(input);
  await caller.deliveryImport({ ...input, hash: preview.fileHash });
  const first = await caller.tradeReviewPeriodPerformance({
    account: input.account,
    pageSize: 1,
  });
  expect(first.periods).toHaveLength(8);
  expect(first.matrix.rows.length).toBeLessThanOrEqual(1);
  expect(first.matrix.summary).toHaveLength(12);
  const beyond = await caller.tradeReviewPeriodPerformance({
    account: input.account,
    pageIndex: 999,
    pageSize: 1,
  });
  expect(beyond.matrix.rows).toEqual([]);
  expect(beyond.matrix.summary).toEqual(first.matrix.summary);
  await expect(
    caller.tradeReviewPeriodPerformance({
      account: input.account,
      pageSize: 101,
    }),
  ).rejects.toThrow();
  await expect(
    caller.strategyResearchPeriodPerformance({
      id: "missing",
      partition: "validation",
      pageSize: 0,
    }),
  ).rejects.toThrow();
  await expect(
    caller.strategyResearchPeriodPerformance({
      id: "missing",
      partition: "validation",
    }),
  ).rejects.toThrow("尚不可得");
});
let temporary = "";
beforeEach(() => {
  state.db = new Database(":memory:");
  migrate(state.db);
  temporary = mkdtempSync(join(tmpdir(), "r2b-import-"));
});
afterEach(() => {
  state.db?.close();
  state.db = null;
  rmSync(temporary, { recursive: true, force: true });
});

it("previews without writes, imports idempotently, lists batches and revokes only the chosen batch", async () => {
  const store = new DeliveryStore(state.db!);
  const before = state.db!.prepare("SELECT total_changes() AS n").get();
  const preview = await caller.deliveryPreview(input);
  expect(preview.summary).toMatchObject({ new: 3, duplicate: 0, conflict: 0 });
  expect(state.db!.prepare("SELECT total_changes() AS n").get()).toEqual(
    before,
  );
  expect(store.batches()).toEqual([]);
  const first = await caller.deliveryImport({
    ...input,
    hash: preview.fileHash,
  });
  expect(first.fills).toBe(3);
  expect((await caller.deliveryPreview(input)).summary.duplicate).toBe(3);
  expect(
    (await caller.deliveryImport({ ...input, hash: preview.fileHash }))
      .alreadyImported,
  ).toBe(true);
  const other = { ...input, account: "另一账户" };
  const second = await caller.deliveryImport({
    ...other,
    hash: preview.fileHash,
  });
  const batches = await caller.deliveryBatches();
  expect(batches).toHaveLength(2);
  expect(batches[0]).toMatchObject({
    fileName: "tdx-statement.txt",
    source: "tdx",
    statistics: { fills: 3, cashFlows: 0 },
  });
  expect(batches[0]).not.toHaveProperty("payload");
  expect(await caller.deliveryRevoke(first.batchId)).toEqual({
    fills: 3,
    cashFlows: 0,
    batches: 1,
  });
  expect((await caller.deliveryBatches()).map((b) => b.id)).toEqual([
    second.batchId,
  ]);
  expect(store.fills(other.account)).toHaveLength(3);
});

it("rejects changed preview bytes and conflicting records without partial writes", async () => {
  const path = join(temporary, "changed.txt");
  const original = readFileSync(input.path, "utf8");
  writeFileSync(path, original);
  const preview = await caller.deliveryPreview({ ...input, path });
  writeFileSync(path, original.replace("19250.00", "19251.00"));
  await expect(
    caller.deliveryImport({ ...input, path, hash: preview.fileHash }),
  ).rejects.toThrow("文件已改变");
  expect(await caller.deliveryBatches()).toEqual([]);
  await caller.deliveryImport({ ...input, hash: preview.fileHash });
  const conflict = await caller.deliveryPreview({ ...input, path });
  expect(conflict.summary.conflict).toBe(1);
  expect(
    conflict.rows.find((r) => r.status === "conflict")!.differences,
  ).toContain("amount");
  await expect(
    caller.deliveryImport({ ...input, path, hash: conflict.fileHash }),
  ).rejects.toThrow("交易编号已用于不同内容");
  expect(await caller.deliveryBatches()).toHaveLength(1);
  expect(new DeliveryStore(state.db!).fills()).toHaveLength(3);
});

it("lists only candidate files with metadata and validates paths and aliases", async () => {
  writeFileSync(join(temporary, "copy.XLS"), readFileSync(input.path));
  writeFileSync(join(temporary, "ignore.md"), "ignored");
  const files = await caller.deliveryFiles(temporary);
  expect(files.map((file) => file.name)).toEqual(["copy.XLS"]);
  expect(files[0]!.size).toBe(readFileSync(input.path).length);
  expect(files[0]!.modifiedAt).toBeGreaterThan(0);
  await expect(caller.deliveryFiles("x".repeat(2049))).rejects.toThrow();
  await expect(
    caller.deliveryPreview({ ...input, account: "x".repeat(65) }),
  ).rejects.toThrow();
  await expect(
    caller.deliveryPreview({ ...input, account: " " }),
  ).rejects.toThrow();
  await expect(
    caller.deliveryPreview({ ...input, path: join(temporary, "ignore.md") }),
  ).rejects.toThrow("仅支持");
});

it("paginates and sorts on the server for both methods without hidden full-round payloads; export retains replay evidence", async () => {
  const preview = await caller.deliveryPreview(input);
  await caller.deliveryImport({ ...input, hash: preview.fileHash });
  for (const method of ["movingAverage", "fifo"] as const) {
    const first = await caller.tradeReviewSnapshot({
      account: input.account,
      method,
      pageSize: 1,
      sort: "security",
      desc: true,
    });
    const second = await caller.tradeReviewSnapshot({
      account: input.account,
      method,
      pageSize: 1,
      pageIndex: 1,
      sort: "security",
      desc: true,
    });
    expect(first.keyTrades).toEqual(second.keyTrades);
    expect(first.keyTrades.n).toBe(3);
    expect(
      first.keyTrades.years
        .flatMap((y) => y.amount.highest)
        .map((r) => r.security)
        .sort(),
    ).toEqual(["sh600036"]);
    expect(first.keyTrades.openCount).toBe(1);
    expect(first.keyTrades.missingCount).toBe(0);
    expect(first.keyTrades.years[0]!.amount.highest[0]).not.toHaveProperty(
      "realizations",
    );
    const limited = await caller.tradeReviewSnapshot({
      account: input.account,
      method,
      keyTradesN: 1,
    });
    expect(limited.keyTrades.years[0]!.amount.highest).toHaveLength(1);
    await expect(
      caller.tradeReviewSnapshot({ account: input.account, keyTradesN: 21 }),
    ).rejects.toThrow();
    expect(first.rowCount).toBe(2);
    expect(first.calendar.source).toBe("合成完整交易日历");
    expect(first.calendar.hash).toBe("fixture-calendar");
    expect(first.rounds.map((r) => r.security)).toEqual(["sh688981"]);
    expect(second.rounds.map((r) => r.security)).toEqual(["sh600036"]);
    expect(first.rounds[0]!.costMethod).toBe(method);
    expect(first).not.toHaveProperty("replayInput");
    expect(first).not.toHaveProperty("trades");
    expect(first.attribution.every((item) => !("rounds" in item))).toBe(true);
    expect(first.missingMarketData.map((row) => row.security)).toContain(
      "sh600036",
    );
    const html = renderToStaticMarkup(
      createElement(TradeReviewResults, {
        data: first,
        method,
        onMethodChange: () => {},
        drawdownsOpen: false,
        onDrawdownsOpenChange: () => {},
        drawdownTable: {
          pagination: { pageIndex: 0, pageSize: 10 },
          sorting: [{ id: "drawdown", desc: true }],
          onPaginationChange: () => {},
          onSortingChange: () => {},
        },
        pointTable: {
          pagination: { pageIndex: 0, pageSize: 10 },
          sorting: [],
          onPaginationChange: () => {},
          onSortingChange: () => {},
        },
        attributionTable: {
          pagination: { pageIndex: 0, pageSize: 10 },
          sorting: [],
          onPaginationChange: () => {},
          onSortingChange: () => {},
        },
        pagination: { pageIndex: 0, pageSize: 1 },
        sorting: [{ id: "security", desc: true }],
        onPaginationChange: () => {},
        onSortingChange: () => {},
        monthPagination: { pageIndex: 0, pageSize: 12 },
        onMonthPaginationChange: () => {},
      }),
    );
    for (const label of [
      "移动加权",
      "FIFO",
      "因缺行情无法分析",
      "实际使用的交易日数",
      "净值/收益中断",
      "月度收益表",
      "分组是描述性的，不代表因果",
      "费用来源",
      "样本不足，不稳定",
    ])
      expect(html).toContain(label);
  }
  const exported = JSON.parse(
    await caller.tradeReviewExport({ account: input.account }),
  );
  expect(exported.replayInput.trades.fills).toHaveLength(3);
  expect(exported.trades.fifo.closedRounds).toHaveLength(1);
  await expect(
    caller.tradeReviewSnapshot({ account: "不存在" }),
  ).rejects.toThrow("暂无可复盘");
});

it("keeps cancelled flow amounts visible and rejects uncovered calendars", async () => {
  const flowInput = {
    ...input,
    path: resolve("tests/fixtures/delivery/ths-bank-flow.txt"),
  };
  const preview = await caller.deliveryPreview(flowInput);
  await caller.deliveryImport({ ...flowInput, hash: preview.fileHash });
  const old = state.days;
  try {
    state.days = [
      "2024-01-05",
      "2024-02-20",
      "2024-03-18",
      "2024-05-09",
      "2024-06-17",
      "2024-07-15",
      "2024-07-22",
      "2024-08-20",
      "2024-09-18",
      "2024-09-25",
    ];
    const snapshot = await caller.tradeReviewSnapshot({
      account: input.account,
    });
    expect(snapshot.excludedCashFlows.map((row) => row.amount)).toEqual([
      60000, 70000,
    ]);
    expect(
      snapshot.excludedCashFlows.every((row) =>
        row.reason.includes("失败/作废"),
      ),
    ).toBe(true);
    state.days = ["1990-01-01"];
    await expect(
      caller.tradeReviewSnapshot({ account: input.account }),
    ).rejects.toThrow(
      "交易日历未覆盖账户流水区间：日历实际覆盖 1990-01-01 至 1990-01-01，账户流水 2024-01-05 至 2024-09-18",
    );
    state.days = [];
    await expect(
      caller.tradeReviewSnapshot({ account: input.account }),
    ).rejects.toThrow("交易日历不可用");
  } finally {
    state.days = old;
  }
});

it("R13 bounds both table payloads and preserves 2543 fills and dated diagnostics in export", async () => {
  const oldDays = state.days;
  state.days = r13Days;
  state.scale = true;
  try {
    const path = join(temporary, "r13.csv");
    writeFileSync(path, r13Statement());
    const request = { ...input, path, source: "generic" as const };
    const preview = await caller.deliveryPreview(request);
    await caller.deliveryImport({ ...request, hash: preview.fileHash });
    const first = await caller.tradeReviewSnapshot({ account: input.account });
    expect(first.rowCount).toBe(785);
    expect(first.pointCount).toBe(2543);
    expect(first.rounds).toHaveLength(20);
    expect(first.tradePoints.map((p) => p.fillIndex)).toEqual(
      Array.from({ length: 10 }, (_, i) => i),
    );
    expect(first.attributionCount).toBe(12);
    expect(first.attribution).toHaveLength(10);
    const html = renderToStaticMarkup(
      createElement(TradeReviewResults, {
        data: first,
        method: "movingAverage",
        onMethodChange: () => {},
        pagination: { pageIndex: 0, pageSize: 20 },
        sorting: [],
        onPaginationChange: () => {},
        onSortingChange: () => {},
        monthPagination: { pageIndex: 0, pageSize: 12 },
        onMonthPaginationChange: () => {},
        drawdownsOpen: false,
        onDrawdownsOpenChange: () => {},
        drawdownTable: {
          pagination: { pageIndex: 0, pageSize: 10 },
          sorting: [{ id: "drawdown", desc: true }],
          onPaginationChange: () => {},
          onSortingChange: () => {},
        },
        pointTable: {
          pagination: { pageIndex: 0, pageSize: 10 },
          sorting: [],
          onPaginationChange: () => {},
          onSortingChange: () => {},
        },
        attributionTable: {
          pagination: { pageIndex: 0, pageSize: 10 },
          sorting: [],
          onPaginationChange: () => {},
          onSortingChange: () => {},
        },
      }),
    );
    const elements = [...html.matchAll(/<[a-z][^>]*>/g)].length;
    expect(elements).toBeLessThan(1000);
    expect(html).toContain("共 1265 条");
    const pointsTable =
      html.match(/<table[^>]*aria-label="买卖点"[\s\S]*?<\/table>/)?.[0] ?? "";
    expect([...pointsTable.matchAll(/<tr[ >]/g)]).toHaveLength(11);
    console.info(
      `R13 synthetic initial SSR: ${elements} HTML elements (not a browser accessibility-tree measurement)`,
    );

    const second = await caller.tradeReviewSnapshot({
      account: input.account,
      pointPageIndex: 1,
      attributionPageIndex: 1,
    });
    expect(second.attribution).toHaveLength(2);
    expect(second.tradePoints.map((p) => p.fillIndex)).toEqual(
      Array.from({ length: 10 }, (_, i) => i + 10),
    );
    expect(
      second.attribution.some((r) =>
        first.attribution.some((a) => a.id === r.id),
      ),
    ).toBe(false);
    const descending = await caller.tradeReviewSnapshot({
      account: input.account,
      method: "fifo",
      pointDesc: true,
      attributionSort: "sampleCount",
      attributionDesc: true,
    });
    const last = await caller.tradeReviewSnapshot({
      account: input.account,
      pointPageIndex: 254,
    });
    expect(last.tradePoints.map((p) => p.fillIndex)).toEqual([
      2540, 2541, 2542,
    ]);
    const beyond = await caller.tradeReviewSnapshot({
      account: input.account,
      pointPageIndex: 255,
    });
    expect(beyond.tradePoints).toEqual([]);
    expect(descending.tradePoints.map((p) => p.fillIndex)).toEqual(
      Array.from({ length: 10 }, (_, i) => 2542 - i),
    );
    expect(descending.attribution.map((r) => r.sampleCount)).toEqual(
      [...descending.attribution.map((r) => r.sampleCount)].sort(
        (a, b) => b - a,
      ),
    );
    const exported = JSON.parse(
      await caller.tradeReviewExport({ account: input.account }),
    );
    expect(exported.trades.tradePoints).toHaveLength(2543);
    expect(exported.trades.movingAverage.closedRounds).toHaveLength(785);
    expect(exported.nav.days).toHaveLength(1265);
    expect(exported.nav.twr.reasons).toEqual(first.nav.twr.reasons);
    expect(exported.nav.twr.reasons).toHaveLength(1265);
    expect(exported.nav.twr.reason.length).toBeLessThan(100);
    expect(exported.nav.twr.reasons[1264].date).toBe(r13Days[1264]);
    await expect(
      caller.tradeReviewSnapshot({
        account: input.account,
        pointPageSize: 101,
      }),
    ).rejects.toThrow();
    await expect(
      caller.tradeReviewSnapshot({
        account: input.account,
        attributionSort: "unknown" as "name",
      }),
    ).rejects.toThrow();
  } finally {
    state.days = oldDays;
    state.scale = false;
  }
}, 30000);
