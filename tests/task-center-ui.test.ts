import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { TaskDetails } from "../src/components/task-history";
import type { TaskState } from "../src/lib/task-history";

vi.mock("../src/trpc/react", () => ({ api: {} }));
const data: TaskState = {
  id: "job-a",
  type: "research",
  status: "failed",
  progress: 40,
  createdAt: 1000,
  updatedAt: 4500,
  error: "模型返回无效结果\n证据 ID 不存在。",
  phase: "核对证据",
  auditIncomplete: true,
  attemptId: "attempt-a",
};
const render = (props = {}) =>
  renderToStaticMarkup(
    createElement(TaskDetails, {
      data,
      pending: false,
      cancelling: false,
      onRetry: vi.fn(),
      onCancel: vi.fn(),
      ...props,
    }),
  );

it("displays full errors, elapsed time and incomplete audit without inventing a result link", () => {
  const html = render();
  expect(html).toContain(data.error);
  expect(html).toContain("whitespace-pre-wrap");
  expect(html).toContain("3.50");
  expect(html).toContain("审计记录未完整保存");
  expect(html).toContain("attempt-a");
  expect(html).not.toContain("查看研究报告");
  expect(html).not.toContain("取消任务");
});
it("handles loading, missing, failed reads and failed cancellation explicitly", () => {
  expect(render({ data: undefined, pending: true })).toContain(
    "正在读取任务详情",
  );
  expect(render({ data: null })).toContain("任务不存在");
  const html = render({
    data: undefined,
    error: "离线",
    cancelError: "任务已结束",
  });
  expect(html).toContain("读取失败：离线");
  expect(html).toContain("重试详情");
  expect(html).toContain("取消失败：任务已结束");
});
it("exposes exact report destinations and disables duplicate cancellation", () => {
  expect(
    render({
      data: {
        ...data,
        status: "completed",
        resultLink: { href: "/reports/report/report-a", label: "查看研究报告" },
      },
    }),
  ).toContain('href="/reports/report/report-a"');
  const html = render({
    data: { ...data, status: "running" },
    cancelling: true,
  });
  expect(html).toMatch(/disabled=""[^>]*>正在取消/);
});
