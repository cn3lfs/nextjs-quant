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
import {
  LabBacktest,
  labBacktestReceipt,
  readLabBacktestForm,
} from "../../src/components/research/lab-backtest";
import { parseStudioEntry } from "../../src/lib/research/studio-entry";
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
const fields: {
  start: string;
  end: string;
  initial: number;
  costScenario: "fixed" | "base" | "double-cost";
} = {
  start: "2024-01-01",
  end: "2024-02-01",
  initial: 1000000,
  costScenario: "fixed",
};
function parsedInput(overrides: Partial<typeof fields> = {}) {
  const result = readLabBacktestForm(JSON.stringify(strategy), {
    ...fields,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.message);
  return result.input;
}
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
const render = () => {
  const entry = parseStudioEntry(harness.search);
  return renderToStaticMarkup(
    createElement(LabBacktest, {
      entry,
      search: harness.search,
      active: entry.object,
      showHandoff: false,
      onApply: () => {},
      onDiagnose: () => {},
      onResult: () => {},
    }),
  );
};
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
    expect(parseStudioEntry(search).object).toBe(true);
    expect(render()).toMatch(
      /<section(?![^>]* hidden="")[^>]* aria-label="策略对象组合回测"/,
    );
  },
);
it("keeps the ordinary baseline entry collapsed", () => {
  expect(parseStudioEntry("").object).toBe(false);
  expect(render()).toMatch(
    /<section[^>]* hidden=""[^>]* aria-label="策略对象组合回测"/,
  );
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

it("shows no task receipt before a submission succeeds", () => {
  const html = render();
  expect(html).not.toContain("已创建回测任务");
  expect(html).not.toContain("最近一次已创建的回测任务");
  expect(html).not.toContain("查看进度、结果与取消");
});

it.each([
  ["2024-01-02", "2024-01-01", "开始须早于结束"],
  ["2024-02-30", "2024-03-01", "日期无效"],
  ["2024-01-01", "2999-01-01", "仅允许完整历史日期"],
  ["", "2024-02-01", "开始日期：格式无效"],
])("blocks the form before any task for %s → %s", (start, end, message) => {
  const result = readLabBacktestForm(JSON.stringify(strategy), {
    ...fields,
    start,
    end,
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.message).toContain(message);
});

it("reports unreadable or invalid strategy JSON instead of submitting", () => {
  expect(readLabBacktestForm("{", fields)).toEqual({
    ok: false,
    message: "策略对象不是有效 JSON，请修正后再提交。",
  });
  const invalid = readLabBacktestForm(
    JSON.stringify({ ...strategy, id: "" }),
    fields,
  );
  expect(invalid.ok).toBe(false);
  if (!invalid.ok) expect(invalid.message).toMatch(/^策略对象：/);
});

it("passes only the schema-validated payload to the mutation", () => {
  const parsed = parsedInput();
  expect(parsed.strategy).toMatchObject({ id: "registered", version: 2 });
  expect(parsed).toMatchObject({
    ...fields,
    riskPerTrade: 0.01,
    maxPositions: 10,
  });
});

it("builds the receipt from the submitted fields and the server job id", () => {
  const receipt = labBacktestReceipt(
    parsedInput({ initial: 250000, costScenario: "double-cost" }),
    "job-42",
  );
  expect(receipt).toEqual({
    jobId: "job-42",
    strategyId: "registered",
    strategyVersion: 2,
    market: "cn-equity",
    start: "2024-01-01",
    end: "2024-02-01",
    initial: 250000,
    costScenario: "double-cost",
  });
});

it("keeps the receipt independent from later edits to the submitted input", () => {
  const input = parsedInput({ initial: 250000.75 });
  const receipt = labBacktestReceipt(input, "job-1");
  input.initial = 300000;
  input.start = "2024-03-01";
  expect(receipt).toMatchObject({
    jobId: "job-1",
    start: "2024-01-01",
    initial: 250000.75,
  });
});
