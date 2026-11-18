import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const harness = vi.hoisted(() => ({
  search: "",
  calls: [] as { id: string; version: number }[],
  detail: {
    data: undefined as unknown,
    error: null as Error | null,
    isPending: true,
    isFetching: true,
    isError: false,
  },
  refetch: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(harness.search),
}));
vi.mock("~/components/workbench/keep-alive", () => ({
  usePanelVisible: () => true,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    strategyLabDetail: {
      useQuery: (input: { id: string; version: number }) => {
        harness.calls.push(input);
        return { ...harness.detail, refetch: harness.refetch };
      },
    },
    strategyLabBacktest: { useMutation: () => ({ isPending: false }) },
    strategyLabRegister: { useMutation: () => ({ isPending: false }) },
  },
}));
import { LabBacktest } from "../../src/components/research/lab-backtest";
const strategy = {
  id: "registered",
  version: 2,
  market: "cn-equity",
  period: "day",
  universe: { kind: "symbols", symbols: ["sz000001"] },
  entry: { kind: "dual-ma", fast: 5, slow: 20, side: "entry" },
  exit: { maxBars: 20 },
  sizing: { kind: "weight", weight: 0.1 },
  sleeve: "swing",
};
function setDetail(patch: Partial<typeof harness.detail>) {
  Object.assign(
    harness.detail,
    {
      data: undefined,
      error: null,
      isPending: false,
      isFetching: false,
      isError: false,
    },
    patch,
  );
}
const render = () => renderToStaticMarkup(createElement(LabBacktest));
beforeEach(() => {
  harness.search = "";
  harness.calls.length = 0;
  harness.refetch.mockClear();
  setDetail({ isPending: true, isFetching: true });
});
it.each(["mode=object", "strategy=registered&version=2"])(
  "opens object form from an explicit %s entry",
  (search) => {
    harness.search = search;
    expect(render()).toMatch(/<details[^>]* open=""/);
  },
);
it("keeps the ordinary baseline entry collapsed", () => {
  expect(render()).not.toMatch(/<details[^>]* open=""/);
});
it("offers explicit market and execution-period research presets", () => {
  const html = render();
  expect(html).toContain('aria-label="多周期研究预设"');
  expect(html).toContain('role="combobox"');
  expect(html).toContain("选择预设");
  expect(html).toContain("仅填入配置，不自动运行");
  expect(html).toContain("A股保持T+1");
});

it("offers the shared fixed, base and double-cost scenarios", () => {
  const html = render();
  expect(html).toContain('aria-label="交易成本情景"');
  expect(html).toContain("fixed 等同本入口原默认费用");
  expect(html).toContain("2023-08-28");
  expect(html).toContain("默认 fixed");
});

it.each([
  "strategy=registered&version=1.5",
  "strategy=registered&version=0",
  "strategy=registered&version=abc",
  "strategy=registered&version=",
  "strategy=&version=2",
])("treats %s as an invalid link without a detail request", (search) => {
  harness.search = search;
  const html = render();
  expect(harness.calls).toHaveLength(0);
  expect(html).toContain("链接中的策略身份无效");
  expect(html).toContain('href="/lab"');
  expect(html).not.toContain("提交策略对象回测");
  expect(html).not.toContain("研究预设（仅填入配置");
});

it("defaults a missing version to v1", () => {
  harness.search = "strategy=registered";
  render();
  expect(harness.calls).toEqual([{ id: "registered", version: 1 }]);
});

it("shows reading state without the form while a valid identity loads", () => {
  harness.search = "strategy=registered&version=2";
  const html = render();
  expect(html).toContain("正在读取策略 registered v2");
  expect(html).not.toContain("提交策略对象回测");
  expect(html).not.toContain("登记此版本到策略列表");
  expect(harness.calls).toEqual([{ id: "registered", version: 2 }]);
});

it("uses a strictly matching detail as the form initial value", () => {
  harness.search = "strategy=registered&version=2";
  setDetail({ data: { strategy } });
  const html = render();
  expect(html).toContain("从 registered v2 载入");
  expect(html).toContain("sz000001");
  expect(html).not.toContain("sh600000");
  expect(html).toContain('aria-label="回测策略对象"');
  expect(html).toContain("提交策略对象回测");
  expect(html).toContain("登记此版本到策略列表");
  expect(html).toContain('aria-label="交易成本情景"');
  expect(html).not.toContain("研究预设（仅填入配置");
});

it("offers a refetch when the first read fails", () => {
  harness.search = "strategy=registered&version=2";
  setDetail({ error: new Error("仓库不可用"), isError: true });
  const html = render();
  expect(html).toContain("读取策略定义失败：仓库不可用");
  expect(html).toContain("重新读取策略定义");
  expect(html).toContain('href="/lab"');
  expect(html).not.toContain("提交策略对象回测");
  expect(html).not.toContain("登记此版本到策略列表");
});

it("reports a missing strategy with a return to the lab", () => {
  harness.search = "strategy=registered&version=2";
  setDetail({ data: { strategy: null } });
  const html = render();
  expect(html).toContain("未找到策略 registered v2");
  expect(html).toContain('href="/lab"');
  expect(html).not.toContain("提交策略对象回测");
  expect(html).not.toContain("登记此版本到策略列表");
});

it.each([
  { ...strategy, id: "other" },
  { ...strategy, version: 3 },
])("refuses a response whose identity does not match the link", (returned) => {
  harness.search = "strategy=registered&version=2";
  setDetail({ data: { strategy: returned } });
  const html = render();
  expect(html).toContain("不一致");
  expect(html).toContain('href="/lab"');
  expect(html).not.toContain("提交策略对象回测");
  expect(html).not.toContain("登记此版本到策略列表");
});

it("keeps the confirmed draft when a later read fails", () => {
  harness.search = "strategy=registered&version=2";
  setDetail({
    data: { strategy },
    error: new Error("刷新失败"),
    isError: true,
  });
  const html = render();
  expect(html).toContain("从 registered v2 载入");
  expect(html).toContain("再次读取策略定义失败：刷新失败");
  expect(html).toContain("提交策略对象回测");
});

it("keeps the ordinary preset path without a detail request", () => {
  harness.search = "preset=week-day";
  const html = render();
  expect(html).toContain("研究预设（仅填入配置，不自动运行）");
  expect(html).toContain("theory-triple-screen-week-day-cn-equity");
  expect(html).toContain("提交策略对象回测");
  expect(harness.calls).toHaveLength(0);
});
