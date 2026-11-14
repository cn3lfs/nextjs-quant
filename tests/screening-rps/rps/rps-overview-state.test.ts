import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { RpsOverview } from "../../../src/components/market/rps-overview";

const state = vi.hoisted(() => ({
  status: {
    data: undefined as { progress: null } | undefined,
    isError: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));
vi.mock("~/trpc/react", () => ({
  api: {
    rpsStatus: { useQuery: () => state.status },
    rpsWorkflowLog: {
      useQuery: () => ({ data: [], isPending: false, refetch: vi.fn() }),
    },
  },
}));
vi.mock("../../../src/components/workbench/keep-alive", () => ({
  usePanelVisible: () => true,
}));

it("does not report idle before the first status response or after a failed read", () => {
  state.status = {
    ...state.status,
    data: undefined,
    isError: false,
    error: null,
  };
  let html = renderToStaticMarkup(createElement(RpsOverview));
  expect(html).toContain("读取中");
  expect(html).not.toContain("空闲");
  expect(html).not.toContain("尚未运行RPS任务");
  state.status = {
    ...state.status,
    isError: true,
    error: new Error("断开连接"),
  };
  html = renderToStaticMarkup(createElement(RpsOverview));
  expect(html).toContain("读取失败");
  expect(html).toContain("断开连接");
  expect(html).not.toContain("空闲");
  expect(html).not.toContain("尚未运行RPS任务");
  state.status = {
    ...state.status,
    data: { progress: null },
    isError: false,
    error: null,
  };
  html = renderToStaticMarkup(createElement(RpsOverview));
  expect(html).toContain("空闲");
  expect(html).toContain("尚未运行RPS任务");
  expect(html).not.toContain("读取失败");
});

it("does not present cached idle as a confirmed current state after refetch failure", () => {
  state.status = {
    ...state.status,
    data: { progress: null },
    isError: true,
    error: new Error("断开连接"),
  };
  const html = renderToStaticMarkup(createElement(RpsOverview));
  expect(html).toContain("当前任务状态未知");
  expect(html).not.toContain("空闲");
});
