import { expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({
  ledger: vi.fn(),
  intraday: vi.fn(),
  rps: vi.fn(),
  news: vi.fn(),
}));
vi.mock("~/server/monitoring/signal-ledger-client", () => ({
  scheduleSignalLedger: calls.ledger,
}));
vi.mock("~/server/monitoring/intraday-client", () => ({
  scheduleIntraday: calls.intraday,
}));
vi.mock("~/server/screening/rps-client", () => ({ scheduleRps: calls.rps }));
vi.mock("~/server/news/news-scheduler", () => ({ scheduleNews: calls.news }));
vi.mock("~/server/news/cls-review-scheduler", () => ({
  scheduleClsReview: vi.fn(),
}));
vi.mock("~/server/infra/notifications", () => ({
  enqueue: vi.fn(),
  drain: vi.fn(),
  recoverDeliveries: vi.fn(),
}));
vi.mock("~/server/infra/lease", async (original) => ({
  ...(await original<typeof import("~/server/infra/lease")>()),
  acquireScheduler: () => true,
}));
import { tick } from "~/server/runtime";
import { get, put } from "~/server/db";
it("real deprecation policy leaves old subscriptions intact but schedules no legacy strategies", async () => {
  const subscription = {
    id: "retired",
    enabled: true,
    strategy: { name: "old", fast: 5, slow: 20 },
    symbols: ["sh600519"],
  };
  put("monitor", subscription.id, subscription);
  await tick();
  expect(calls.ledger).not.toHaveBeenCalled();
  expect(calls.intraday).not.toHaveBeenCalled();
  expect(calls.rps).toHaveBeenCalledOnce();
  expect(calls.news).toHaveBeenCalledOnce();
  expect(get(subscription.id)).toEqual(subscription);
});
