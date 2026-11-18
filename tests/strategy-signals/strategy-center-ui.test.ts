import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { unifiedStrategyCatalog } from "trading-strategies";

const selection = vi.hoisted(() => ({
  id: "ma",
  history: [] as {
    id: string;
    strategyId: string;
    symbol: string;
    status: string;
  }[],
  comparison: undefined as
    | {
        id: string;
        strategyId: string;
        comparisonBasis: {
          start: string;
          end: string;
          initial: number;
          symbol: string | null;
          poolCount: number | null;
        };
        overview: Record<string, { value: number | null }>;
        sourceHash?: string;
        benchmarkHash?: string;
      }[]
    | undefined,
  comparisonFetching: false,
  comparisonError: null as Error | null,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: ((initial: unknown) =>
      react.useState(
        initial === "ma" ? selection.id : initial,
      )) as typeof react.useState,
  };
});
vi.mock("~/trpc/react", async () => {
  const { unifiedStrategyCatalog: catalog } =
    await import("trading-strategies");
  const mutation = {
    useMutation: () => ({ isPending: false, mutate: vi.fn() }),
  };
  return {
    api: {
      localDailyAsOf: {
        useQuery: () => ({ data: { historicalAsOf: "2026-10-12" } }),
      },
      securityNames: { useQuery: () => ({ data: {} }) },
      securities: { useQuery: () => ({ data: [] }) },
      strategyCenterCatalog: {
        useQuery: () => ({ data: catalog, error: null }),
      },
      strategyCenterHistory: {
        useQuery: () => ({ data: selection.history, refetch: vi.fn() }),
      },
      strategyCenterMethods: {
        useQuery: () => ({ data: { total: 695, methods: [] } }),
      },
      strategyCenterRun: mutation,
      strategyCenterEvaluate: mutation,
      strategyCenterLocalWeights: mutation,
      strategyCenterPortfolio: mutation,
      strategyCenterEvaluation: { useQuery: () => ({ data: undefined }) },
      strategyCenterCompare: {
        useQuery: () => ({
          data: selection.comparison,
          error: selection.comparisonError,
          isFetching: selection.comparisonFetching,
        }),
      },
      useUtils: () => ({ strategyCenterExport: { fetch: vi.fn() } }),
    },
  };
});
import {
  StrategyCenter,
  comparisonExportDocument,
} from "../../src/components/research/strategy-center";
import { readTaskHistoryLocation } from "../../src/lib/research/workflow/task-history-location";

beforeEach(() => {
  selection.id = "ma";
  selection.history = [];
  selection.comparison = undefined;
  selection.comparisonFetching = false;
  selection.comparisonError = null;
});
const render = () => renderToStaticMarkup(createElement(StrategyCenter));

// Result identity across selection is tested through real interactions in
// route-visual.spec.ts, without injecting a result into every null useState.

it("renders the entire unified catalog with separate historical method inventory", () => {
  const html = render();
  expect(unifiedStrategyCatalog.map((item) => item.id)).toEqual(
    expect.arrayContaining(["classic-kama", "classic-connors-rsi"]),
  );
  expect(html.match(/aria-pressed=/g)).toHaveLength(
    unifiedStrategyCatalog.length,
  );
  for (const entry of unifiedStrategyCatalog)
    expect(html).toContain(entry.name);
  expect(html).toContain("已有完整方法清单");
  expect(html).toContain("695");
});

it("offers the daily experiment action for an executable daily strategy", () => {
  const html = render();
  expect(html).toContain("创建本地日线实验");
  expect(html).toContain("下一交易日开盘撮合");
  expect(html).not.toContain("读取本地因子并计算权重");
});
it.each(["week-day", "day-hour-five"])(
  "routes the %s triple-screen preset to the actual object form",
  (variant) => {
    selection.id = `theory-triple-screen-${variant}`;
    const html = render();
    expect(html).toContain(`/lab/backtest?mode=object&amp;preset=${variant}`);
    expect(html).not.toContain("创建本地日线实验");
  },
);
it("offers native Chan execution with its bounded observation origin and identity requirements", () => {
  selection.id = "research-chan";
  const html = render();
  expect(html).toContain("创建本地日线实验");
  expect(html).toContain("最多366自然日");
  expect(html).toContain("固定开始日前140根起点");
  expect(html).toContain("DLL身份变化或结构元数据缺失时拒绝");
  expect(html).not.toContain("尚未接入统一执行链");
});

it("offers local factor weights without claiming portfolio execution", () => {
  selection.id = "rank-momentum";
  const html = render();
  expect(html).toContain("读取本地因子并计算权重");
  expect(html).toContain("创建历史组合实验");
  expect(html).toContain("未模拟历史组合成交");
  expect(html).not.toContain("创建本地日线实验");
});

it("does not offer execution for research-only or missing-data entries", () => {
  for (const id of [
    "pairs",
    unifiedStrategyCatalog.find((d) => d.implementation === "research-only")!
      .id,
  ]) {
    selection.id = id;
    const html = render();
    expect(html).toContain("尚未接入统一执行链");
    expect(html).not.toContain("创建本地日线实验");
    expect(html).not.toContain("读取本地因子并计算权重");
    expect(html).not.toContain("创建历史组合实验");
  }
});

it("shows compared frozen inputs from the response and links duplicate strategies to their own tasks", () => {
  const name = unifiedStrategyCatalog.find((item) => item.id === "ma")!.name;
  const comparisonBasis = {
    start: "2024-03-04",
    end: "2024-06-28",
    initial: 250000,
    symbol: "sz000001",
    poolCount: null,
  };
  const overview = {
    totalReturn: { value: 0.12 },
    annualReturn: { value: 0.08 },
    maxDrawdown: { value: -0.05 },
    sharpe: { value: 1.2 },
  };
  selection.comparison = [
    { id: "job-one", strategyId: "ma", comparisonBasis, overview },
    { id: "job-two", strategyId: "ma", comparisonBasis, overview },
  ];
  const html = render().replace(/<!--.*?-->/g, "");
  const section = html.slice(html.indexOf("同口径比较"));
  expect(section).toContain("共同冻结输入区间：2024-03-04 至 2024-06-28");
  expect(section).toContain("独立本金 250000 · sz000001");
  expect(section).not.toContain("独立本金 1000000");
  expect(section.split(name)).toHaveLength(3);
  const links = [
    ...section.matchAll(/<a [^>]*href="([^"]+)"[^>]*>任务 ([^<]+)<\/a>/g),
  ];
  expect(links.map((match) => match[2])).toEqual(["job-one", "job-two"]);
  for (const [index, match] of links.entries()) {
    const url = new URL(match[1]!.replaceAll("&amp;", "&"), "http://fixture");
    expect(readTaskHistoryLocation(url.search)).toEqual({
      filter: { id: ["job-one", "job-two"][index] },
      error: "",
    });
  }
});

it("exports the confirmed comparison in order without extra quote or hash fields", () => {
  const comparisonBasis = {
    start: "2024-03-04",
    end: "2024-06-28",
    initial: 250000,
    symbol: "sz000001",
    poolCount: null,
  };
  const later = {
    id: "job-two",
    strategyId: "ma",
    comparisonBasis,
    overview: {
      totalReturn: { value: 0.12 },
      sharpe: { value: null },
    },
    sourceHash: "b".repeat(64),
    benchmarkHash: "c".repeat(64),
  };
  const earlier = {
    id: "job-one",
    strategyId: "ma",
    comparisonBasis,
    overview: {
      totalReturn: { value: null },
      sharpe: { value: 1.2 },
    },
    sourceHash: "d".repeat(64),
  };
  const document = comparisonExportDocument([later, earlier]);
  expect(document).toEqual({
    format: "strategy-center-comparison-1",
    basis: comparisonBasis,
    items: [
      { id: "job-two", strategyId: "ma", overview: later.overview },
      { id: "job-one", strategyId: "ma", overview: earlier.overview },
    ],
  });
  expect(document.items).toHaveLength(2);
  const text = JSON.stringify(document);
  for (const hidden of ["sourceHash", "benchmarkHash", "b".repeat(64)])
    expect(text).not.toContain(hidden);
  expect(text).toContain('"value":null');
});

it("disables comparison export while refreshing or after the same-key read fails", () => {
  const basis = {
    start: "2024-03-04",
    end: "2024-06-28",
    initial: 250000,
    symbol: null,
    poolCount: null,
  };
  const overview = {
    totalReturn: { value: 0.12 },
    annualReturn: { value: 0.08 },
    maxDrawdown: { value: -0.05 },
    sharpe: { value: 1.2 },
  };
  const button = (html: string) =>
    html.match(/<button[^>]*>导出比较摘要<\/button>/)?.[0] ?? "";
  const disabled = (html: string) => /\sdisabled=""/.test(button(html));

  expect(render()).not.toContain("导出比较摘要");
  selection.comparison = [
    { id: "job-one", strategyId: "ma", comparisonBasis: basis, overview },
    { id: "job-two", strategyId: "ma", comparisonBasis: basis, overview },
  ];
  expect(button(render())).not.toBe("");
  expect(disabled(render())).toBe(false);

  selection.comparisonFetching = true;
  expect(disabled(render())).toBe(true);

  selection.comparisonFetching = false;
  selection.comparisonError = new Error("同键比较读取失败");
  expect(disabled(render())).toBe(true);
  expect(render()).toContain("同键比较读取失败");
});

it("links every history row to its exact task filter, including escaped task identifiers", () => {
  selection.history = [
    {
      id: "job?a=1&x/中文",
      strategyId: "ma",
      symbol: "sh600000",
      status: "completed",
    },
    {
      id: "another-job",
      strategyId: "theory-nr4-close",
      symbol: "sh600519",
      status: "failed",
    },
  ];
  const links = [...render().matchAll(/<a href="([^"]+)"[^>]*>任务详情<\/a>/g)];
  expect(links).toHaveLength(2);
  for (const [i, match] of links.entries()) {
    const url = new URL(match[1]!.replaceAll("&amp;", "&"), "http://fixture");
    expect(url.pathname).toBe("/system/tasks");
    expect(readTaskHistoryLocation(url.search)).toEqual({
      filter: { id: selection.history[i]!.id },
      error: "",
    });
  }
});
