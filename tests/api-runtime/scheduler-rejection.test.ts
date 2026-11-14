import { beforeEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  failure: new Error("fixture scheduler rejection"),
  record: vi.fn(),
  rps: vi.fn(),
  news: vi.fn(),
  alerts: vi.fn(),
}));
vi.mock("~/lib/common/capabilities", () => ({
  capabilityAllows: (name: string) => name === "intraday",
}));
vi.mock("~/server/alerts/service", () => ({ tickAlerts: calls.alerts }));
vi.mock("~/server/screening/rps-client", () => ({ scheduleRps: calls.rps }));
vi.mock("~/server/news/news-scheduler", () => ({ scheduleNews: calls.news }));
vi.mock("~/server/news/cls-review-scheduler", () => ({
  scheduleClsReview: vi.fn(),
}));
vi.mock("~/server/infra/runtime-errors", () => ({
  recordRuntimeError: calls.record,
}));
vi.mock("~/server/infra/lease", async (original) => ({
  ...(await original<typeof import("~/server/infra/lease")>()),
  acquireScheduler: () => true,
}));
import { tick } from "~/server/runtime";

beforeEach(() => vi.clearAllMocks());

it("records a rejected unified alert dispatch without interrupting unrelated scheduler checks", async () => {
  calls.alerts.mockRejectedValueOnce(calls.failure);
  await tick();
  expect(calls.record).toHaveBeenCalledWith("alert-engine", calls.failure);
  expect(calls.rps).toHaveBeenCalledOnce();
  expect(calls.news).toHaveBeenCalledOnce();
});

it("continues when the dispatcher has no work to start", async () => {
  calls.alerts.mockReturnValueOnce(undefined);
  await tick();
  expect(calls.record).not.toHaveBeenCalled();
  expect(calls.rps).toHaveBeenCalledOnce();
  expect(calls.news).toHaveBeenCalledOnce();
});
