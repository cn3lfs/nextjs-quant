import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { TaskState } from "~/lib/research/workflow/task-history";

const query = vi.hoisted(() => ({
  data: undefined as TaskState | undefined,
  error: null as Error | null,
}));
vi.mock("~/trpc/react", () => ({
  api: { screenTaskProgress: { useQuery: () => query } },
}));
import { ScreenTaskProgress } from "~/components/screening/screen-task-progress";

const id = "job:筛选/a?b=1&c=#% +";
function render() {
  return renderToStaticMarkup(createElement(ScreenTaskProgress, { id }));
}
function expectTaskLink(html: string, label: string) {
  const anchor = /<a\b[^>]*href="([^"]*)"[^>]*>([^<]*)<\/a>/.exec(html);
  expect(anchor).not.toBeNull();
  const url = new URL(anchor![1]!, "http://localhost");
  expect(url.pathname).toBe("/system/tasks");
  expect([...url.searchParams]).toEqual([["id", id]]);
  expect(url.hash).toBe("");
  expect(anchor![2]).toBe(label);
}
beforeEach(() => {
  query.data = undefined;
  query.error = null;
});

it.each(["queued", "running", "completed", "failed", "cancelled"] as const)(
  "keeps the exact task accessible while %s, with cancellation offered only before termination",
  (status) => {
    query.data = {
      id,
      type: "screen",
      status,
      progress: 42,
      createdAt: 1,
      updatedAt: 1001,
      phase: "读取证券",
      ...(status === "failed" ? { error: "fixture job failed" } : {}),
    };
    const html = render();
    expectTaskLink(
      html,
      ["queued", "running"].includes(status)
        ? "查看任务详情与取消"
        : "查看任务详情",
    );
    expect(html).toContain("读取证券 · 42%");
    if (status === "failed") expect(html).toContain("fixture job failed");
  },
);
it("keeps the task entry and a loading status before progress arrives", () => {
  const html = render();
  expectTaskLink(html, "查看任务详情与取消");
  expect(html).toContain('role="status"');
  expect(html).toContain("正在读取公式选股进度");
  expect(html).not.toContain("运行中");
});
it("keeps the task entry when progress fails without claiming the task itself failed", () => {
  query.error = new Error("fixture progress unavailable");
  const html = render();
  expectTaskLink(html, "查看任务详情与取消");
  expect(html).toContain('role="alert"');
  expect(html).toContain("进度读取失败：fixture progress unavailable");
  expect(html).not.toContain("正在读取");
  expect(html).not.toContain("公式筛选 · 失败");
});
