import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ records: new Map<string, unknown>() }));
vi.mock("../src/server/db", () => ({
  atomic: (fn: () => unknown) => fn(),
  get: (key: string) => state.records.get(key),
  put: (_kind: string, key: string, value: unknown) =>
    state.records.set(key, value),
}));
vi.mock("../src/server/settings", () => ({
  settings: () => ({ autoNewsDailyBatches: 2 }),
}));
import { newsBudget, reserveNewsBatch } from "../src/server/news-budget";
afterEach(() => {
  vi.useRealTimers();
  state.records.clear();
});
it("charges before work, caps retries and resets at Beijing midnight", () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-08T23:59:59+08:00"));
  reserveNewsBatch();
  reserveNewsBatch();
  expect(newsBudget()).toMatchObject({
    used: 2,
    exhausted: true,
    day: "2026-09-08",
  });
  expect(() => reserveNewsBatch()).toThrow("每日AI批次上限");
  expect(newsBudget().used).toBe(2);
  vi.setSystemTime(new Date("2026-09-09T00:00:00+08:00"));
  expect(newsBudget()).toMatchObject({ used: 0, exhausted: false });
  reserveNewsBatch();
  expect(newsBudget().used).toBe(1);
});
