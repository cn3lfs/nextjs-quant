import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Bar, Snapshot } from "../../src/lib/domain";
import type { BrowseList } from "../../src/lib/market/browse-list";
import type { MarketSnapshot } from "../../src/lib/stores/market-session";

const hotkey = vi.hoisted(() => ({
  disabled: false,
  browse: null as unknown,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    status: { useQuery: () => ({ data: [], error: null }) },
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
vi.mock("~/components/market/chart-hotkeys", () => ({
  usePeriodHotkey: (_period: unknown, _set: unknown, disabled: boolean) => {
    hotkey.disabled = disabled;
  },
}));
vi.mock("~/components/market/use-browse-hotkey", () => ({
  useBrowseHotkey: (browse: unknown) => {
    hotkey.browse = browse;
  },
}));
vi.mock("~/components/market/market-security-views", async () => {
  const { createElement } = await import("react");
  return {
    MarketSecurityViews: ({
      heading,
      period,
      adjustment,
      frozenEvidence,
    }: {
      heading?: ReactNode;
      period: string;
      adjustment: string;
      frozenEvidence: boolean;
    }) =>
      createElement(
        "div",
        {
          "data-view-period": period,
          "data-view-adjustment": adjustment,
          "data-frozen": String(frozenEvidence),
        },
        heading,
      ),
  };
});
vi.mock("~/components/market/tdx-side-panel", () => ({
  TdxSidePanel: () => null,
}));
vi.mock("~/components/market/symbol-rps-bars", () => ({
  SymbolRpsBars: () => null,
}));
vi.mock("~/components/market/security-select", async () => {
  const { createElement } = await import("react");
  return {
    SecuritySelect: ({ disabled }: { disabled: boolean }) =>
      createElement("span", {
        "data-control": "security",
        "data-disabled": String(disabled),
      }),
  };
});
vi.mock("~/components/market/market-source-select", async () => {
  const { createElement } = await import("react");
  return {
    MarketSourceSelect: ({ disabled }: { disabled: boolean }) =>
      createElement("span", {
        "data-control": "source",
        "data-disabled": String(disabled),
      }),
  };
});
vi.mock("~/components/market/chart-adjustment-select", async () => {
  const { createElement } = await import("react");
  return {
    ChartAdjustmentSelect: ({ disabled }: { disabled: boolean }) =>
      createElement("span", {
        "data-control": "adjustment",
        "data-disabled": String(disabled),
      }),
  };
});
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

const bar = (date: string): Bar => ({
  date,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 1,
  amount: 1,
});
const frozen: MarketSnapshot = {
  id: "frozen-1",
  symbol: "sh600001",
  name: "冻结甲",
  period: "week",
  source: "tdx-local",
  adjustment: "forward",
  createdAt: 1,
  bars: [bar("2026-11-06"), bar("2026-11-13")],
  hash: "frozen",
  // Deliberately later than the last archived bar.
  historicalAsOf: "2026-11-14",
  frozenCandidate: true,
};
const ordinary: Snapshot = {
  id: "live-1",
  symbol: "sh600519",
  name: "贵州茅台",
  period: "day",
  source: "tdx-auto",
  adjustment: "none",
  createdAt: 2,
  bars: [bar("2026-11-17")],
  hash: "live",
};
const browse = { label: "选股候选", symbols: ["sh600001"], index: 0 };

function render(
  options: {
    loaded?: Snapshot | MarketSnapshot | null;
    frozen?: boolean;
    pending?: boolean;
    error?: Error | null;
    /** Simulate a toolbar left on an ordinary URL's choice. */
    chartPeriod?: ComponentProps<typeof MarketView>["state"]["chartPeriod"];
    adjustment?: ComponentProps<typeof MarketView>["state"]["adjustment"];
    /** The selection the toolbar shows, independent of `loaded`. */
    symbol?: string;
    browse?: BrowseList | null;
  } = {},
) {
  const loaded = options.loaded === undefined ? frozen : options.loaded;
  const market = {
    marketSource: "local",
    marketView: "chart",
    symbol: options.symbol ?? loaded?.symbol ?? "sh600519",
    period: loaded?.period ?? "day",
    loaded,
    load: {
      isPending: options.pending ?? false,
      isRevalidating: false,
      error: options.error ?? null,
      mutate: vi.fn(),
      acceptSnapshot: vi.fn(),
      acceptFrozenSnapshot: vi.fn(),
    },
    browse: options.browse === undefined ? browse : options.browse,
    chartPeriod: options.chartPeriod ?? loaded?.period ?? "day",
    adjustment: options.adjustment ?? loaded?.adjustment ?? "none",
    setMarketView: vi.fn(),
    setMarketSource: vi.fn(),
    setSymbol: vi.fn(),
    setBrowse: vi.fn(),
    setChartPeriod: vi.fn(),
    setAdjustment: vi.fn(),
  } as ComponentProps<typeof MarketView>["state"];
  return renderToStaticMarkup(
    createElement(MarketView, {
      state: market,
      notify: vi.fn(),
      frozen: options.frozen,
    }),
  );
}

function button(html: string, label: string) {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(([value]) => value)
    .find((value) => value.includes(label));
}

it("shows the actually loaded frozen evidence and how to leave it", () => {
  // The toolbar was left on another ordinary choice; the main chart must still
  // use the archived period/adjustment.
  const html = render({
    frozen: true,
    chartPeriod: "day",
    adjustment: "none",
  });
  expect(html).toContain("冻结候选证据");
  expect(html).toContain("冻结甲");
  expect(html).toContain("SH600001");
  expect(html).toContain("快照周期 周线");
  // The last actual bar is distinct from the historical cutoff, which stays in
  // the existing heading tag instead of a second banner copy.
  expect(html).toContain("最后K线 2026-11-13");
  expect(html).toContain("历史快照 · 截至 2026-11-14");
  expect(html).not.toContain("历史截至");
  expect(html).toContain("数据源 本地文件（vipdoc）");
  expect(html).toContain("快照复权 前复权");
  expect(html).toContain('data-view-period="week"');
  expect(html).toContain('data-view-adjustment="forward"');
  expect(html).toContain('data-frozen="true"');
  expect(html).toContain("在普通行情中查看");
  expect(html).toContain('data-control="security" data-disabled="true"');
  expect(html).toContain('data-control="source" data-disabled="true"');
  expect(html).toContain('data-control="adjustment" data-disabled="true"');
  expect(hotkey.disabled).toBe(true);
  // The stale candidate list cannot step the frozen chart.
  expect(hotkey.browse).toBeNull();
});

it("keeps the protection while an ordinary route is still reading", () => {
  const html = render({ frozen: false, pending: true });
  expect(html).toContain("冻结候选证据");
  expect(html).not.toContain("在普通行情中查看");
  expect(html).toContain("正在读取普通行情；下方仍为冻结候选快照。");
  expect(html).toContain('data-control="security" data-disabled="true"');
  expect(hotkey.disabled).toBe(true);
});

it("keeps frozen evidence and one explicit retry when the ordinary read fails", () => {
  const html = render({ frozen: false, error: new Error("行情源不可用") });
  expect(html).toContain("行情源不可用");
  expect(html).toContain("下方仍为冻结候选快照");
  expect(button(html, "重试")).toBeDefined();
  expect(html).not.toContain("在普通行情中查看");
  expect(html).toContain('data-control="security" data-disabled="true"');
});

const rpsBrowse = (symbols: readonly string[], index = 0): BrowseList => ({
  label: "RPS50排名 · 2026-11-12",
  symbols,
  index,
  origin: "stock-rps",
});

it("offers the stock-RPS return link for the selected member, not by loaded symbol or index", () => {
  // `loaded` is the unrelated ordinary snapshot and the stored index points at
  // the other row: only `state.symbol` membership may decide the link.
  const html = render({
    loaded: ordinary,
    browse: rpsBrowse(["sh600001", "sh600002"], 0),
    symbol: "sh600002",
  });
  expect(html).toContain("返回个股 RPS 排名");
  expect(html).toContain('href="/scan?tab=rps"');
});

it("hides the stock-RPS return link for a selection outside the list, ordinary lists and frozen evidence", () => {
  const outside = render({
    loaded: ordinary,
    browse: rpsBrowse(["sh600001", "sh600002"]),
    symbol: "sz000001",
  });
  expect(outside).not.toContain("返回个股 RPS 排名");
  const ordinaryList = render({
    loaded: ordinary,
    browse: { label: "选股候选", symbols: ["sh600519"], index: 0 },
    symbol: "sh600519",
  });
  expect(ordinaryList).not.toContain("返回个股 RPS 排名");
  const held = render({
    frozen: true,
    browse: rpsBrowse(["sh600001", "sh600002"]),
    symbol: "sh600001",
  });
  expect(held).not.toContain("返回个股 RPS 排名");
});

it("keeps the ordinary branch when no frozen evidence is loaded", () => {
  const html = render({ loaded: ordinary, frozen: false });
  expect(html).not.toContain("冻结候选证据");
  expect(html).not.toContain("在普通行情中查看");
  expect(html).toContain('data-control="security" data-disabled="false"');
  expect(html).toContain('data-control="source" data-disabled="false"');
  expect(html).toContain('data-control="adjustment" data-disabled="false"');
  expect(hotkey.disabled).toBe(false);
  expect(hotkey.browse).toEqual(browse);
  expect(html).toContain('data-view-period="day"');
  expect(html).toContain('data-frozen="false"');
});
