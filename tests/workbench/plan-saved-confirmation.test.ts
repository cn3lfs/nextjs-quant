import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  mutation: null as null | {
    onSuccess?: (plan: unknown) => void;
    onError?: (error: Error) => void;
  },
  invalidated: [] as string[],
}));

vi.mock("next/link", async () => {
  const { createElement: h } = await import("react");
  return {
    default: ({ href, children }: { href: string; children: unknown }) =>
      h("a", { href }, children as never),
  };
});

vi.mock("~/trpc/react", async () => {
  const invalidate = (name: string) =>
    vi.fn(async () => {
      harness.invalidated.push(name);
    });
  const utils = {
    alertPlans: { invalidate: invalidate("alertPlans") },
    workspaceCandidates: { invalidate: invalidate("workspaceCandidates") },
    todayWorkspace: { invalidate: invalidate("todayWorkspace") },
  };
  const useMutation = (options: typeof harness.mutation) => {
    harness.mutation = options;
    return { isPending: false, mutate: vi.fn(), error: undefined };
  };
  return {
    api: {
      useUtils: () => utils,
      planCorrelation: { useQuery: () => ({ data: undefined, error: null }) },
      simPlanBindingGet: {
        useQuery: () => ({ data: null, isSuccess: false, error: null }),
      },
      simAccountsList: {
        useQuery: () => ({ data: [], isSuccess: true, error: null }),
      },
      simPlanBindingSave: {
        useMutation: () => ({
          isPending: false,
          isError: false,
          mutate: vi.fn(),
        }),
      },
      createAlertPlan: { useMutation },
    },
  };
});

import { CandidatePlan } from "../../src/components/signals/candidate-plan";
import { PlanSavedNotice } from "../../src/components/overview/plan-saved-notice";

const planId = "plan?a=1&x/中文";
const savedPlan = {
  id: planId,
  symbol: "sh600000",
  market: "cn-equity",
  quantity: 1200,
  sizingAudit: { overridden: true },
  protection: undefined,
  positionSnapshot: {
    basis: "post-close",
    at: Date.parse("2026-11-18T07:00:00Z"),
    unassignedValue: 5000,
  },
};

const candidate = {
  key: "alert:sh600000:2026-11-18",
  market: "cn-equity" as const,
  symbol: "sh600000",
  price: 10,
  stop: 9,
  target: 13,
};

beforeEach(() => {
  harness.mutation = null;
  harness.invalidated = [];
});

it("wires the success callback to readable facts, the original plan id and the three invalidations", () => {
  const onSaved = vi.fn();
  const onPendingChange = vi.fn();
  renderToStaticMarkup(
    createElement(CandidatePlan, {
      candidate,
      inline: true,
      onSaved,
      onPendingChange,
    }),
  );
  expect(harness.mutation).not.toBeNull();

  harness.mutation!.onSuccess!(savedPlan);

  expect(onPendingChange).toHaveBeenLastCalledWith(false);
  expect(onSaved).toHaveBeenCalledTimes(1);
  const confirmation = onSaved.mock.calls[0]![0];
  expect(confirmation.id).toBe(planId);
  expect(confirmation.symbol).toBe("sh600000");
  expect(confirmation.message).toContain("已保存交易计划 · sh600000");
  expect(confirmation.message).toContain("数量 1200");
  expect(confirmation.message).toContain("已记录偏离策略参数");
  expect(confirmation.message).toContain("收盘快照");
  expect(confirmation.message).toContain("未分配分仓 5000.00 已计入市场占用");
  expect(confirmation.message).not.toContain("请分配");
  expect(harness.invalidated).toEqual([
    "alertPlans",
    "workspaceCandidates",
    "todayWorkspace",
  ]);
});

it("releases pending on failure and never reports a saved plan", () => {
  const onSaved = vi.fn();
  const onPendingChange = vi.fn();
  renderToStaticMarkup(
    createElement(CandidatePlan, {
      candidate,
      inline: true,
      onSaved,
      onPendingChange,
    }),
  );

  harness.mutation!.onError!(new Error("敞口超限：组合/半导体：超出上限"));

  expect(onPendingChange).toHaveBeenLastCalledWith(false);
  expect(onSaved).not.toHaveBeenCalled();
  expect(harness.invalidated).toEqual([]);
});

it("renders the stable tomorrow-plan confirmation with an encoded plan link", () => {
  const confirmation = {
    id: planId,
    symbol: "sh600000",
    message: "已保存交易计划 · sh600000 · 数量 1200",
  };
  const html = renderToStaticMarkup(
    createElement(PlanSavedNotice, { confirmation }),
  );

  expect(html).toContain('role="status"');
  expect(html).toContain(confirmation.message);
  const href = /<a href="([^"]+)">查看计划<\/a>/.exec(html)?.[1];
  expect(href).toBe(`/accounts/alerts?plan=${encodeURIComponent(planId)}`);
  const url = new URL(href!.replaceAll("&amp;", "&"), "http://fixture");
  expect(url.pathname).toBe("/accounts/alerts");
  expect(url.searchParams.get("plan")).toBe(planId);
});
