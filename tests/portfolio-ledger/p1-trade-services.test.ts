import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const stubs = vi.hoisted(() => ({
  order: vi.fn(),
  open: vi.fn(),
  positions: vi.fn(),
  status: vi.fn(),
}));
vi.mock("../../src/server/portfolio/mock/mock-trading", () => ({
  MockTradingAdapter: class {
    constructor(readonly deps: { enabled: () => boolean }) {}
    open() {
      if (!this.deps.enabled()) throw new Error("未开启");
      return stubs.open();
    }
    positions() {
      if (!this.deps.enabled()) throw new Error("未开启");
      return stubs.positions();
    }
    order(input: unknown, confirmed: boolean) {
      if (!this.deps.enabled()) throw new Error("未开启");
      return stubs.order(input, confirmed);
    }
    orderStatus(entrustNos: readonly string[]) {
      if (!this.deps.enabled()) throw new Error("未开启");
      return stubs.status(entrustNos);
    }
  },
  mockCredentialRevision: (account: unknown) => JSON.stringify(account),
  reconcilePositions: vi.fn(),
}));
vi.mock("../../src/server/market/data-health", () => ({
  localCalendarReference: async () => ({
    days: ["2026-09-10", "2026-09-11"],
    source: "controlled-local-calendar",
  }),
}));
vi.mock("../../src/server/market/bar-store/read-bars", () => ({
  readBars: async () => ({ bars: [{ date: "2026-09-10", close: 12 }] }),
}));
vi.mock("tstdx/local", async (original) => ({
  ...(await original<typeof import("tstdx/local")>()),
  readGbbq: async () => ({
    path: "controlled-gbbq",
    modified: 1,
    events: new Map([
      [
        "sh600519",
        [{ date: "2026-09-11", category: 1, name: "除息", dividend: 1 }],
      ],
    ]),
  }),
}));
import { get, sqlite } from "../../src/server/db/index";
import {
  mockEnabled,
  setMockEnabled,
  openMockAccount,
  previewMockOrder,
  confirmMockOrder,
  queryMockOrderStatus,
} from "../../src/server/portfolio/mock/mock-trading-service";
import {
  recordLocalTrade,
  tradeDashboard,
} from "../../src/server/portfolio/trade-ledger-service";
import { saveSecret, readSecret } from "../../src/server/vault";
import { tradeWorkspacePositions } from "../../src/server/portfolio/trade-workspace-service";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "p1-services-"));
const input = () => ({
  id: crypto.randomUUID(),
  symbol: "sh600519",
  date: "2026-09-10",
  side: "buy",
  price: 10,
  quantity: 100,
  lowerLimit: 9,
  upperLimit: 11,
  limitSource: "fixture",
});
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-10T15:10:00+08:00"));
  sqlite().exec(
    "DELETE FROM records; DELETE FROM trade_ledger; DELETE FROM trade_adjustments; DELETE FROM signal_ledger;",
  );
  stubs.order
    .mockReset()
    .mockResolvedValue({ message: "受控受理", entrustNos: [] });
  stubs.open.mockReset();
  stubs.positions.mockReset();
  stubs.status.mockReset();
});
afterEach(() => vi.useRealTimers());
it("workspace position pages retain full-book totals and omit archived evidence", async () => {
  for (let i = 0; i < 22; i++)
    await recordLocalTrade({ ...input(), symbol: `sh${600100 + i}` });
  const first = await tradeWorkspacePositions({ page: 1 }),
    second = await tradeWorkspacePositions({ page: 2 });
  expect(first.items).toHaveLength(20);
  expect(second.items).toHaveLength(2);
  expect(first.summary).toMatchObject({
    holdings: 22,
    trades: 22,
    marketValue: 26400,
    missingQuotes: 0,
  });
  expect(second.summary).toEqual(first.summary);
  expect(first.count).toBe(22);
  expect(first.items[0]).not.toHaveProperty("adjustments");
  expect(first).not.toHaveProperty("trades");
  expect(
    new Set([...first.items, ...second.items].map((p) => p.symbol)).size,
  ).toBe(22);
  const filtered = await tradeWorkspacePositions({ query: "sh600100" });
  expect(filtered.items).toHaveLength(1);
  expect(filtered.summary).toEqual(first.summary);
  expect(stubs.order).not.toHaveBeenCalled();
});
it("filters position status before paging without changing the full-book summary", async () => {
  vi.setSystemTime(new Date("2026-09-11T15:10:00+08:00"));
  for (let i = 0; i < 22; i++)
    await recordLocalTrade({ ...input(), symbol: `sh${600100 + i}` });
  const closedSymbols = ["sh600200", "sh600201", "sh600202"];
  for (const symbol of closedSymbols) {
    await recordLocalTrade({ ...input(), symbol });
    await recordLocalTrade({
      ...input(),
      symbol,
      side: "sell",
      date: "2026-09-11",
    });
  }
  const all = await tradeWorkspacePositions({});
  expect(all.count).toBe(25);
  expect(all.items).toHaveLength(20);
  const open = await tradeWorkspacePositions({ status: "open" });
  expect(open.count).toBe(22);
  expect(open.items).toHaveLength(20);
  expect(
    (await tradeWorkspacePositions({ status: "open", page: 2 })).items,
  ).toHaveLength(2);
  const closed = await tradeWorkspacePositions({ status: "closed" });
  expect(closed.count).toBe(3);
  expect(closed.items.map((p) => p.symbol)).toEqual(closedSymbols);
  expect(closed.items.every((p) => p.quantity === 0)).toBe(true);
  expect(closed.summary).toEqual(all.summary);
  expect(open.summary).toEqual(all.summary);
  expect(
    (await tradeWorkspacePositions({ status: "closed", query: "sh600201" }))
      .count,
  ).toBe(1);
  await expect(
    tradeWorkspacePositions({ status: "holding" }),
  ).rejects.toThrow();
});
it("local application service persists a fill and displays T+1, quote, float, subsequent ex-cost and provenance offline", async () => {
  expect(mockEnabled()).toBe(false);
  const t = input();
  await recordLocalTrade(t);
  let dashboard = await tradeDashboard();
  expect(dashboard.trades[0]!.id).toBe(t.id);
  expect(dashboard.positions[0]).toMatchObject({
    quantity: 100,
    sellable: 0,
    quote: { price: 12, date: "2026-09-10" },
  });
  expect(dashboard.positions[0]!.floating).toBeCloseTo(194.5);
  vi.setSystemTime(new Date("2026-09-11T15:10:00+08:00"));
  dashboard = await tradeDashboard();
  expect(dashboard.positions[0]!.sellable).toBe(100);
  expect(dashboard.positions[0]!.adjustedCost).toBeCloseTo(9.055);
  expect(dashboard.adjustments[0]!.beforeCost).toBeCloseTo(10.055);
  expect(dashboard.trades[0]!.methods[0]!.files[0]!.hash).toMatch(
    /^[a-f0-9]{64}$/,
  );
  expect(stubs.order).not.toHaveBeenCalled();
  expect(stubs.open).not.toHaveBeenCalled();
  expect(stubs.positions).not.toHaveBeenCalled();
});
it("default preference is false; enabling itself and order preview perform no remote operation", async () => {
  expect(mockEnabled()).toBe(false);
  await expect(previewMockOrder(input())).rejects.toThrow("未开启");
  setMockEnabled(true);
  expect(mockEnabled()).toBe(true);
  await previewMockOrder(input());
  expect(stubs.order).not.toHaveBeenCalled();
  expect(stubs.open).not.toHaveBeenCalled();
  expect(stubs.positions).not.toHaveBeenCalled();
});
it("confirmation tokens are single-use, survive errors as attempted, and never create local fills", async () => {
  setMockEnabled(true);
  const p = await previewMockOrder(input());
  await confirmMockOrder(p.id);
  await expect(confirmMockOrder(p.id)).rejects.toThrow("已确认");
  expect(stubs.order).toHaveBeenCalledTimes(1);
  expect(stubs.order).toHaveBeenCalledWith(p.input, true);
  expect((await tradeDashboard()).trades).toHaveLength(0);
  expect(get<{ state: string }>(p.id)?.state).toBe("accepted");
  const q = await previewMockOrder(input());
  stubs.order.mockRejectedValueOnce(new Error("受控结果未知"));
  await expect(confirmMockOrder(q.id)).rejects.toThrow("结果未知");
  await expect(confirmMockOrder(q.id)).rejects.toThrow("已确认");
  expect(stubs.order).toHaveBeenCalledTimes(2);
});
it("manual order queries bind the sending credential and trading day", async () => {
  setMockEnabled(true);
  const account = {
    username: "mock-user",
    account: "mock-fund",
    state: "ready" as const,
    shareholders: [{ gddm: "mock-share", scdm: "2" }],
  };
  await saveSecret("mock-trading-account", account);
  stubs.order.mockResolvedValue({
    message: "受控受理",
    entrustNos: ["E1"],
    credentialRevision: JSON.stringify(account),
    tradeDate: "2026-09-10",
  });
  stubs.status.mockResolvedValue({
    attributable: true,
    fillStatus: "matched",
    rows: [],
  });
  const p = await previewMockOrder(input());
  await confirmMockOrder(p.id);
  expect(await queryMockOrderStatus(p.id)).toMatchObject({
    state: "accepted",
    entrustNos: ["E1"],
    fillStatus: "matched",
  });
  expect(stubs.status).toHaveBeenCalledWith(["E1"]);

  // A later day cannot use the current-day trade endpoint to claim the order.
  vi.setSystemTime(new Date("2026-09-11T15:10:00+08:00"));
  expect(await queryMockOrderStatus(p.id)).toMatchObject({
    state: "accepted",
    fillStatus: "unknown",
    attributable: false,
  });
  expect(stubs.status).toHaveBeenCalledTimes(1);

  // A replacement credential must not look up its own trades under the old ref.
  vi.setSystemTime(new Date("2026-09-10T15:10:00+08:00"));
  await saveSecret("mock-trading-account", {
    ...account,
    account: "other-fund",
  });
  expect(await queryMockOrderStatus(p.id)).toMatchObject({
    state: "accepted",
    fillStatus: "unknown",
    attributable: false,
  });
  expect(stubs.status).toHaveBeenCalledTimes(1);
});

it("expired and disabled confirmation do not place orders", async () => {
  setMockEnabled(true);
  const p = await previewMockOrder(input());
  vi.setSystemTime(Date.now() + 61000);
  await expect(confirmMockOrder(p.id)).rejects.toThrow("过期");
  const q = await previewMockOrder(input());
  setMockEnabled(false);
  await expect(confirmMockOrder(q.id)).rejects.toThrow("未开启");
  expect(stubs.order).not.toHaveBeenCalled();
});
it("concurrent account clicks are serialized and business records contain no account credentials", async () => {
  setMockEnabled(true);
  let release!: () => void;
  stubs.open.mockImplementation(
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  const first = openMockAccount();
  await expect(openMockAccount()).rejects.toThrow("正在处理");
  release();
  await first;
  const payload = JSON.stringify(
    sqlite().prepare("SELECT payload FROM records").all(),
  );
  expect(payload).not.toContain("username");
  expect(payload).not.toContain("skill_");
});
it("account identity round-trips through actual Windows DPAPI in isolated credentials, never business SQL", async () => {
  const credential = {
    username: "skill_1234567890123",
    state: "ready",
    account: "controlled-account",
  };
  await saveSecret("p1-controlled-account", credential);
  const encrypted = readFileSync(
    join(
      process.env.QUANT_DATA_DIR!,
      "credentials",
      "p1-controlled-account.bin",
    ),
    "utf8",
  );
  expect(encrypted).not.toContain(credential.username);
  expect(Buffer.from(encrypted, "base64").toString("utf8")).not.toContain(
    credential.username,
  );
  expect(await readSecret("p1-controlled-account")).toEqual(credential);
  expect(
    JSON.stringify(sqlite().prepare("SELECT payload FROM records").all()),
  ).not.toContain(credential.username);
});
