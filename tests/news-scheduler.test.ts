import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  enabled: false,
  cancelBeforeStart: false,
  exhausted: false,
  records: new Map<string, unknown>(),
  analyze: vi.fn(),
  read: vi.fn(),
  tasks: [] as Promise<unknown>[],
}));
vi.mock("../src/server/settings", () => ({
  settings: () => ({ autoNewsAnalysis: state.enabled, clsDbPath: "fixture" }),
}));
vi.mock("../src/server/db", () => ({
  get: (key: string) => state.records.get(key),
  put: (_kind: string, key: string, value: unknown) =>
    state.records.set(key, value),
}));
vi.mock("../src/server/news-analysis", () => ({ analyzeNews: state.analyze }));
vi.mock("../src/server/news-budget", () => ({
  newsBudget: () => ({ exhausted: state.exhausted, resetAt: 86400000 }),
  reserveNewsBatch: vi.fn(),
}));
vi.mock("../src/server/cls-news", () => ({ readClsNews: state.read }));
vi.mock("../src/server/jobs", () => ({
  updateJob: vi.fn(),
  background: (
    _kind: string,
    _input: unknown,
    task: (job: { id: string }, signal: AbortSignal) => Promise<unknown>,
  ) => {
    if (state.cancelBeforeStart) {
      state.records.set("job", { status: "cancelled" });
      return { id: "job" };
    }
    state.tasks.push(
      task({ id: "job" }, new AbortController().signal).catch(() => undefined),
    );
    return { id: "job" };
  },
}));
import { scheduleNews } from "../src/server/news-scheduler";
beforeEach(() => {
  state.enabled = true;
  state.cancelBeforeStart = false;
  state.exhausted = false;
  state.records.clear();
  state.tasks = [];
  state.analyze
    .mockReset()
    .mockResolvedValue({ id: "archive", status: "complete" });
  state.read.mockReset().mockReturnValue({ items: [{ id: 1 }] });
});
it("a job cancelled before its callback starts does not block future ticks", async () => {
  state.cancelBeforeStart = true;
  scheduleNews(1000);
  expect(state.tasks).toHaveLength(0);
  state.cancelBeforeStart = false;
  scheduleNews(61000);
  await Promise.all(state.tasks);
  expect(state.analyze).toHaveBeenCalledOnce();
});
it("disabled scheduling and empty pages never invoke the model", async () => {
  state.enabled = false;
  scheduleNews(1000);
  expect(state.tasks).toHaveLength(0);
  state.enabled = true;
  state.read.mockReturnValue({ items: [] });
  scheduleNews(1000);
  await Promise.all(state.tasks);
  expect(state.analyze).not.toHaveBeenCalled();
});
it("persists frozen pagination, uses background priority and bounds each page", async () => {
  const nextInput = {
    cutoff: 1000,
    scope: "range",
    maxItems: 50,
    before: { time: 0, id: 2 },
  };
  state.analyze.mockResolvedValueOnce({
    id: "archive",
    status: "complete",
    nextInput,
  });
  scheduleNews(1000);
  scheduleNews(1000);
  await Promise.all(state.tasks);
  expect(state.analyze).toHaveBeenCalledTimes(1);
  expect(state.analyze.mock.calls[0]![0]).toMatchObject({
    cutoff: 1000,
    maxItems: 50,
  });
  expect(state.analyze.mock.calls[0]![3]).toBe("background");
  scheduleNews(2000);
  expect(state.tasks).toHaveLength(1);
  scheduleNews(61000);
  await Promise.all(state.tasks);
  expect(state.analyze.mock.calls[1]![0]).toEqual(nextInput);
});
it("partial results resume the archived page after backoff", async () => {
  state.analyze.mockResolvedValueOnce({
    id: "archive",
    status: "partial",
    input: { cutoff: 1000, scope: "range", maxItems: 50 },
    error: "partial",
  });
  scheduleNews(1000);
  await Promise.all(state.tasks);
  scheduleNews(61000);
  expect(state.tasks).toHaveLength(1);
  scheduleNews(901000);
  await Promise.all(state.tasks);
  expect(state.analyze.mock.calls[1]![0]).toMatchObject({
    resumeId: "archive",
    cutoff: 1000,
  });
  expect(state.read).toHaveBeenCalledTimes(1);
});
it("budget-paused pages retain their archive until the next day", async () => {
  state.exhausted = true;
  state.analyze.mockResolvedValueOnce({
    id: "archive",
    status: "partial",
    input: { cutoff: 1000, scope: "range", maxItems: 50 },
  });
  scheduleNews(1000);
  await Promise.all(state.tasks);
  scheduleNews(901000);
  expect(state.tasks).toHaveLength(1);
  const checkpoint = [...state.records.values()].find(
    (value) => (value as { retryAt?: number }).retryAt,
  ) as { retryAt: number; next: { resumeId: string } };
  expect(checkpoint.retryAt).toBe(86400000);
  expect(checkpoint.next.resumeId).toBe("archive");
  state.exhausted = false;
  scheduleNews(86400000);
  await Promise.all(state.tasks);
  expect(state.analyze.mock.calls[1]![0]).toMatchObject({
    resumeId: "archive",
    cutoff: 1000,
  });
});
