import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../src/server/data-sources/hithink/hithink-context", () => ({
  request: mocks.request,
}));
import {
  parseSecurityTradingStatus,
  verifySecurityTradingStatus,
  storedSecurityTradingStatus,
} from "../src/server/market/security-trading-status";
import { currentTradingStatus } from "../src/lib/security-trading-status";
import { sqlite } from "../src/server/db";
import live from "./fixtures/security-status-live.json";
process.env.QUANT_DATA_DIR = mkdtempSync(join(tmpdir(), "quant-status-test-"));
const symbol = "sh600519",
  now = live.fetchedAt;
beforeEach(() => {
  sqlite().prepare("DELETE FROM records").run();
  mocks.request.mockReset();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubEnv("IWENCAI_API_KEY", "test");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
it("replays the observed daily status with source dates, semantic metadata and no gateway token", () => {
  const result = parseSecurityTradingStatus(symbol, live.raw, now);
  expect(result).toMatchObject({
    status: "trading",
    asOf: "2026-09-09",
    fetchedAt: now,
  });
  expect(currentTradingStatus(result, symbol, now)).toBe(true);
  expect(
    result.evidence.columns.find((c) => c.key === "停牌[20260909]")?.type,
  ).toBe("BOOLEAN");
  expect(result.evidence.row).not.toHaveProperty("最新价");
  expect(result).not.toHaveProperty("token");
});
it("rejects another security and incomplete or duplicate identity results", () => {
  expect(() => parseSecurityTradingStatus("sh600000", live.raw, now)).toThrow(
    "身份",
  );
  expect(() =>
    parseSecurityTradingStatus(symbol, { ...live.raw, code_count: 2 }, now),
  ).toThrow();
  expect(() =>
    parseSecurityTradingStatus(
      symbol,
      { ...live.raw, datas: [...live.raw.datas, ...live.raw.datas] },
      now,
    ),
  ).toThrow();
});
it("does not turn missing, string boolean, conflicts or stale source dates into tradable status", () => {
  for (const value of [true, "false", null]) {
    const raw = structuredClone(live.raw);
    Object.assign(raw.datas[0]!, { "停牌[20260909]": value });
    expect(parseSecurityTradingStatus(symbol, raw, now).status).toBe("unknown");
  }
  expect(
    parseSecurityTradingStatus(symbol, live.raw, now + 86400000).status,
  ).toBe("unknown");
  const missing = structuredClone(live.raw);
  missing.columns = missing.columns.filter((c) => !c.key.startsWith("停牌"));
  expect(parseSecurityTradingStatus(symbol, missing, now).status).toBe(
    "unknown",
  );
});
it("requires unique, same-date status columns with the observed meaning", () => {
  for (const field of ["timestamp", "index_name", "type"] as const) {
    const raw = structuredClone(live.raw);
    const column = raw.columns.find((c) => c.key.startsWith("交易状态"))!;
    column[field] = "wrong";
    expect(parseSecurityTradingStatus(symbol, raw, now).status).toBe("unknown");
  }
  const raw = structuredClone(live.raw);
  raw.columns.push(raw.columns.find((c) => c.key.startsWith("交易状态"))!);
  expect(parseSecurityTradingStatus(symbol, raw, now).status).toBe("unknown");
});
it("keeps explicit suspension as a non-trading observation", () => {
  const raw = structuredClone(live.raw);
  Object.assign(raw.datas[0]!, {
    "交易状态[20260909]": "停牌",
    "停牌[20260909]": true,
  });
  const result = parseSecurityTradingStatus(symbol, raw, now);
  expect(result.status).toBe("suspended");
  expect(currentTradingStatus(result, symbol, now)).toBe(false);
});
it("expires at 60 seconds, on date changes, wrong identity or a future observation", () => {
  const result = parseSecurityTradingStatus(symbol, live.raw, now);
  expect(currentTradingStatus(result, symbol, now + 59999)).toBe(true);
  for (const time of [now - 1, now + 60000, now + 86400000])
    expect(currentTradingStatus(result, symbol, time)).toBe(false);
  expect(currentTradingStatus(result, "sz600519", now)).toBe(false);
});
it("coalesces and caches requests, then refreshes expired observations", async () => {
  mocks.request.mockResolvedValue(live.raw);
  const values = await Promise.all([
    verifySecurityTradingStatus(symbol),
    verifySecurityTradingStatus(symbol),
  ]);
  expect(values[0]).toEqual(values[1]);
  expect(mocks.request).toHaveBeenCalledOnce();
  await verifySecurityTradingStatus(symbol);
  expect(mocks.request).toHaveBeenCalledOnce();
  vi.setSystemTime(now + 60000);
  await verifySecurityTradingStatus(symbol);
  expect(mocks.request).toHaveBeenCalledTimes(2);
});
it("preserves old evidence on request failure without treating it as current", async () => {
  mocks.request.mockResolvedValueOnce(live.raw);
  const first = await verifySecurityTradingStatus(symbol);
  vi.setSystemTime(now + 60000);
  mocks.request.mockRejectedValueOnce(new Error("unavailable"));
  await expect(verifySecurityTradingStatus(symbol)).rejects.toThrow(
    "unavailable",
  );
  expect(storedSecurityTradingStatus(symbol)).toEqual(first);
  expect(currentTradingStatus(first, symbol, Date.now())).toBe(false);
});
