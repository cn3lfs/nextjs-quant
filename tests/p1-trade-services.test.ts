import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const stubs = vi.hoisted(() => ({
  order: vi.fn(),
  open: vi.fn(),
  positions: vi.fn(),
}));
vi.mock("../src/server/mock-trading", () => ({
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
  },
  reconcilePositions: vi.fn(),
}));
vi.mock("../src/server/data-health", () => ({
  localCalendarReference: async () => ({
    days: ["2026-09-10", "2026-09-11"],
    source: "controlled-local-calendar",
  }),
}));
vi.mock("../src/server/tdx", () => ({
  readSnapshot: async () => ({ bars: [{ date: "2026-09-10", close: 12 }] }),
}));
vi.mock("../src/server/tdx-gbbq", () => ({
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
import { get, sqlite } from "../src/server/db";
import {
  mockEnabled,
  setMockEnabled,
  openMockAccount,
  previewMockOrder,
  confirmMockOrder,
} from "../src/server/mock-trading-service";
import {
  recordLocalTrade,
  tradeDashboard,
} from "../src/server/trade-ledger-service";
import { saveSecret, readSecret } from "../src/server/vault";
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
  stubs.order.mockReset().mockResolvedValue("受控受理");
  stubs.open.mockReset();
  stubs.positions.mockReset();
});
afterEach(() => vi.useRealTimers());
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
  expect(get<{ state: string }>(p.id)?.state).toBe("attempted");
  const q = await previewMockOrder(input());
  stubs.order.mockRejectedValueOnce(new Error("受控结果未知"));
  await expect(confirmMockOrder(q.id)).rejects.toThrow("结果未知");
  await expect(confirmMockOrder(q.id)).rejects.toThrow("已确认");
  expect(stubs.order).toHaveBeenCalledTimes(2);
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
