import { afterEach, expect, it, vi } from "vitest";
import SuperJSON from "superjson";
import type { Page } from "@playwright/test";
import { waitForIdleServer, waitForJob } from "../e2e/helpers";

afterEach(() => vi.restoreAllMocks());
function pageFixture(read: (url: string) => unknown, status = 200) {
  let now = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const get = vi.fn(async (url: string) => ({
    ok: () => status >= 200 && status < 300,
    status: () => status,
    json: async () => read(url),
  }));
  const wait = vi.fn(async (ms: number) => {
    now += ms;
  });
  return {
    page: { request: { get }, waitForTimeout: wait } as unknown as Page,
    get,
    wait,
  };
}

it("does not mistake a failed request for an idle server", async () => {
  const { page, get, wait } = pageFixture(
    () => ({ error: { message: "fixture failure" } }),
    500,
  );
  await expect(waitForIdleServer(page, 1000)).rejects.toThrow("HTTP 500");
  expect(get).toHaveBeenCalledTimes(1);
  expect(wait).not.toHaveBeenCalled();
});

it("uses all-task counts even when the recent jobs window is empty", async () => {
  const { page, get } = pageFixture((url) => ({
    result: {
      data: {
        json: url.includes("taskOverview") ? { queued: 1, running: 0 } : [],
      },
    },
  }));
  await expect(waitForIdleServer(page, 1000)).rejects.toThrow(
    "服务端任务迟迟未结束",
  );
  expect(get.mock.calls.every(([url]) => url.includes("taskOverview"))).toBe(
    true,
  );
});

it("waits for running tasks to finish and requires numeric counts", async () => {
  let calls = 0;
  const { page, wait } = pageFixture(() => ({
    result: { data: { json: { running: calls++ ? 0 : 1, queued: 0 } } },
  }));
  await waitForIdleServer(page, 1000);
  expect(wait).toHaveBeenCalledOnce();
  const invalid = pageFixture(() => ({
    result: { data: { json: { running: "0", queued: 0 } } },
  }));
  await expect(waitForIdleServer(invalid.page, 1000)).rejects.toThrow();
});

it("rejects missing envelopes and missing jobs instead of waiting on invalid data", async () => {
  for (const body of [{}, { result: { data: { json: null } } }]) {
    const { page, wait } = pageFixture(() => body);
    await expect(waitForJob(page, "fixture", 1000)).rejects.toThrow();
    expect(wait).not.toHaveBeenCalled();
  }
});

it("returns the requested terminal job including its failure state", async () => {
  const job = {
    id: "fixture",
    type: "formula-screen",
    createdAt: 1,
    status: "failed",
    error: "invalid formula",
  };
  const { page, get } = pageFixture((url) => {
    if (!url.startsWith("/api/trpc/taskState?"))
      throw new Error("Polling must not fetch full results or snapshots");
    return { result: { data: { json: job } } };
  });
  await expect(waitForJob(page, "fixture", 1000)).resolves.toMatchObject(job);
  expect(get).toHaveBeenCalledOnce();
});

it("decodes optional task fields from the actual SuperJSON transport", async () => {
  const job = {
    id: "fixture",
    type: "screen",
    createdAt: 1,
    status: "completed",
    error: undefined,
    isFormulaScreen: true,
  };
  const { page } = pageFixture(() => ({
    result: { data: SuperJSON.serialize(job) },
  }));
  await expect(waitForJob(page, "fixture", 1000)).resolves.toEqual(job);
});
