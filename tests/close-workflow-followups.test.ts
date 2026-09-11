import { afterEach, expect, it, vi } from "vitest";
const jobs = vi.hoisted(() => ({ signals: vi.fn(), news: vi.fn() }));
vi.mock("../src/server/czsc", () => ({ analyzeCzsc: vi.fn() }));
vi.mock("../src/server/intraday-service", () => ({
  intradayDependencies: () => ({}),
  runIntradayTick: jobs.signals,
}));
vi.mock("../src/server/cls-review-scheduler", () => ({
  runClsReviewTick: jobs.news,
}));
import { runCloseWorkflowFollowups } from "../src/server/close-workflow-followups";
afterEach(() => vi.resetAllMocks());
it("runs both close consumers", async () => {
  await runCloseWorkflowFollowups();
  expect(jobs.signals).toHaveBeenCalledOnce();
  expect(jobs.news).toHaveBeenCalledOnce();
});
it("still runs news after confirmation fails and allows the next retry", async () => {
  jobs.signals.mockRejectedValueOnce(new Error("confirmation unavailable"));
  await expect(runCloseWorkflowFollowups()).rejects.toThrow(
    "confirmation unavailable",
  );
  expect(jobs.news).toHaveBeenCalledOnce();
  await expect(runCloseWorkflowFollowups()).resolves.toBeUndefined();
  expect(jobs.signals).toHaveBeenCalledTimes(2);
});
it("does not report success when news throws", async () => {
  jobs.news.mockRejectedValueOnce(new Error("news unavailable"));
  await expect(runCloseWorkflowFollowups()).rejects.toThrow("news unavailable");
});
