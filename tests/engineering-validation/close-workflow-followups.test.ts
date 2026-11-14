import { afterEach, expect, it, vi } from "vitest";
const jobs = vi.hoisted(() => ({ signals: vi.fn(), news: vi.fn() }));
vi.mock("../../src/server/strategies/chan/czsc", () => ({
  analyzeCzsc: vi.fn(),
}));
vi.mock("../../src/server/monitoring/intraday-service", () => ({
  intradayDependencies: () => ({}),
  runIntradayTick: jobs.signals,
}));
vi.mock("../../src/server/news/cls-review-scheduler", () => ({
  runClsReviewTick: jobs.news,
}));
import { runCloseWorkflowFollowups } from "../../src/server/jobs/close-workflow-followups";
import * as policy from "~/lib/common/capabilities";
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
it("does not resume paused intraday confirmation after a download, while news still runs", async () => {
  await runCloseWorkflowFollowups();
  await runCloseWorkflowFollowups();
  expect(jobs.signals).not.toHaveBeenCalled();
  expect(jobs.news).toHaveBeenCalledTimes(2);
});
it("runs both close consumers", async () => {
  vi.spyOn(policy, "capabilityAllows").mockReturnValue(true);
  await runCloseWorkflowFollowups();
  expect(jobs.signals).toHaveBeenCalledOnce();
  expect(jobs.news).toHaveBeenCalledOnce();
});
it("still runs news after confirmation fails and allows the next retry", async () => {
  vi.spyOn(policy, "capabilityAllows").mockReturnValue(true);
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
