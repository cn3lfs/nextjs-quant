import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import { unifiedStrategyCatalog } from "trading-strategies";

const selection = vi.hoisted(() => ({
  id: "ma",
  evaluation: null as {
    strategyId: string;
    asOf: string;
    result: unknown;
  } | null,
}));
vi.mock("react", async (importOriginal) => {
  const react = await importOriginal<typeof import("react")>();
  return {
    ...react,
    useState: ((initial: unknown) =>
      react.useState(
        initial === "ma"
          ? selection.id
          : initial === null
            ? selection.evaluation
            : initial,
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
      strategyCenterCatalog: {
        useQuery: () => ({ data: catalog, error: null }),
      },
      strategyCenterHistory: {
        useQuery: () => ({ data: [], refetch: vi.fn() }),
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
        useQuery: () => ({ data: undefined, error: null }),
      },
      useUtils: () => ({ strategyCenterExport: { fetch: vi.fn() } }),
    },
  };
});
import { StrategyCenter } from "../../src/components/research/strategy-center";

beforeEach(() => {
  selection.id = "ma";
  selection.evaluation = null;
});
const render = () => renderToStaticMarkup(createElement(StrategyCenter));

it("keeps completed weights tied to their strategy and date across manual or automatic selection", () => {
  selection.evaluation = {
    strategyId: "allocation-risk-parity",
    asOf: "2025-03-01",
    result: { proof: "completed-risk-parity-weights" },
  };
  for (const id of ["research-breakout", "no-longer-visible"]) {
    selection.id = id;
    expect(render()).not.toContain("completed-risk-parity-weights");
  }
  selection.id = "allocation-risk-parity";
  const html = render();
  expect(html).toContain("completed-risk-parity-weights");
  expect(html).toContain("截至 2025-03-01");
});

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
