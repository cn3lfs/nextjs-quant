import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Snapshot } from "../../src/lib/domain";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    status: { useQuery: () => ({ data: ["sh600519"], error: null }) },
    watchlist: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
    useUtils: () => ({ status: { invalidate: vi.fn() } }),
  },
}));
vi.mock("~/components/workbench/use-task-visible", () => ({
  useTaskVisible: () => true,
}));
vi.mock("~/components/market/use-security-names", () => ({
  useSecurityNames: () => ({ data: {} }),
}));
vi.mock("~/components/market/chart-hotkeys", () => ({ usePeriodHotkey() {} }));
vi.mock("~/components/market/use-browse-hotkey", () => ({
  useBrowseHotkey() {},
}));
vi.mock("~/components/market/market-source-select", () => ({
  MarketSourceSelect: () => null,
}));
vi.mock("~/components/market/chart-adjustment-select", () => ({
  ChartAdjustmentSelect: () => null,
}));
vi.mock("~/components/market/market-security-views", () => ({
  MarketSecurityViews: () => null,
}));
vi.mock("~/components/market/security-select", () => ({
  SecuritySelect: () => null,
}));
vi.mock("~/components/market/tdx-side-panel", () => ({
  TdxSidePanel: () => null,
  tradableSymbol: (symbol: string) => /^(sh|sz|bj)\d{6}$/.test(symbol),
}));
vi.mock("~/components/market/symbol-rps-bars", () => ({
  SymbolRpsBars: () => null,
}));
vi.mock("~/components/panels", async () => {
  const { createElement } = await import("react");
  const frame = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    Panel: frame,
    PageGrid: frame,
    GridTable: () => null,
    SecurityCell: () => null,
    Segmented: () => null,
  };
});

import { MarketView } from "../../src/components/workbench/market-view";

const snapshot: Snapshot = {
  id: "fixture",
  symbol: "sh600519",
  period: "day",
  source: "tdx-local",
  adjustment: "forward",
  createdAt: 1,
  bars: [],
  hash: "fixture",
};

function renderMarket(props: Partial<ComponentProps<typeof MarketView>> = {}) {
  const state = {
    marketSource: "local",
    marketView: "chart",
    symbol: "sh600519",
    period: "day",
    loaded: snapshot,
    load: {
      isPending: false,
      isRevalidating: false,
      error: null,
      mutate: vi.fn(),
      acceptSnapshot: vi.fn(),
      acceptFrozenSnapshot: vi.fn(),
    },
    browse: null,
    chartPeriod: "day",
    chartMode: "k",
    adjustment: "forward",
    setMarketView: vi.fn(),
    setMarketSource: vi.fn(),
    setSymbol: vi.fn(),
    setBrowse: vi.fn(),
    setChartPeriod: vi.fn(),
    setChartMode: vi.fn(),
    setAdjustment: vi.fn(),
  } as ComponentProps<typeof MarketView>["state"];

  return renderToStaticMarkup(
    createElement(MarketView, {
      state,
      notify: vi.fn(),
      ...props,
    }),
  );
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [, name, value] of raw.matchAll(/([a-zA-Z0-9:-]+)="([^"]*)"/g)) {
    attrs[name!] = value!;
  }
  return attrs;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "").trim();
}

function findOpenTags(html: string, tag: string) {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>`, "g");
  return [...html.matchAll(pattern)].map((match) => {
    const attrs = parseAttributes(match[1] ?? "");
    return {
      attrs,
      classes: (attrs.class ?? "").split(/\s+/).filter(Boolean),
    };
  });
}

function findElements(html: string, tag: string) {
  const pattern = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "g");
  return [...html.matchAll(pattern)].map((match) => {
    const attrs = parseAttributes(match[1] ?? "");
    const innerHtml = match[2] ?? "";
    return {
      attrs,
      classes: (attrs.class ?? "").split(/\s+/).filter(Boolean),
      innerHtml,
      text: stripTags(innerHtml),
    };
  });
}

it("renders the left rail collapsed by default with an unexpanded 展开列表 button", () => {
  const html = renderMarket({
    leftCandidatesSlot: createElement("div", null, "候选列表"),
  });
  const terminal = findOpenTags(html, "div").find((node) =>
    node.classes.includes("nc-market-terminal"),
  );
  expect(terminal).toBeDefined();
  expect(terminal?.attrs["data-left-collapsed"]).toBe("true");
  expect(terminal?.attrs["data-right-collapsed"]).toBe("false");

  const leftRail = findElements(html, "aside").find(
    (node) => node.attrs["aria-label"] === "自选与扫描候选",
  );
  expect(leftRail).toBeDefined();
  const collapseButton = findElements(leftRail!.innerHtml, "button").find(
    (node) => node.attrs["aria-label"] === "收起列表",
  );
  expect(collapseButton).toBeDefined();
  expect(collapseButton?.attrs["aria-expanded"]).toBe("true");

  const chartPanel = findElements(html, "section").find((node) =>
    node.classes.includes("chart-panel"),
  );
  expect(chartPanel).toBeDefined();
  const chartButtons = findElements(chartPanel!.innerHtml, "button");
  const expandButton = chartButtons.find((node) => node.text === "展开列表");
  expect(expandButton).toBeDefined();
  expect(expandButton?.attrs["aria-expanded"]).toBe("false");
  expect(
    chartButtons.filter(
      (node) =>
        node.text === "收起列表" || node.attrs["aria-label"] === "收起列表",
    ),
  ).toHaveLength(0);
  expect(chartPanel?.innerHtml).not.toContain("收起列表");
});

it("renders the right rail with 盘口指标 and without 计划双价", () => {
  const html = renderMarket();
  const rightRail = findElements(html, "aside").find(
    (node) => node.attrs["aria-label"] === "盘口指标",
  );
  expect(rightRail).toBeDefined();
  expect(rightRail?.text).toContain("盘口指标");
  expect(rightRail?.innerHtml).not.toContain("计划双价");
  expect(rightRail?.innerHtml).not.toContain('role="tab"');
  expect(html).not.toContain("计划双价");
  expect(html).not.toContain("盘口与计划");
});
