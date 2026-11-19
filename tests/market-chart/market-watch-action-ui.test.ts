import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { Snapshot } from "../../src/lib/domain";
const state = vi.hoisted(() => ({
  watchlist: ["sh600519"] as string[] | undefined,
  error: null as Error | null,
  pending: false,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("~/trpc/react", () => ({
  api: {
    status: { useQuery: () => ({ data: state.watchlist, error: state.error }) },
    watchlist: {
      useMutation: () => ({ isPending: state.pending, mutate: vi.fn() }),
    },
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
function render(
  symbol: string | null = "sh600519",
  loading = false,
  options: {
    browse?: ComponentProps<typeof MarketView>["state"]["browse"];
    frozen?: boolean;
  } = {},
) {
  // The chart/network hooks are isolated; only the watch control is under test.
  const market = {
    marketSource: "local",
    marketView: "chart",
    symbol: symbol ?? "sh600519",
    period: "day",
    loaded: symbol ? { ...snapshot, symbol } : null,
    load: {
      isPending: loading,
      isRevalidating: false,
      error: null,
      mutate: vi.fn(),
      acceptSnapshot: vi.fn(),
      acceptFrozenSnapshot: vi.fn(),
    },
    browse: options.browse ?? null,
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
      state: market,
      notify: vi.fn(),
      frozen: options.frozen,
    }),
  );
}
function button(html: string, label: string) {
  const result = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(([value]) => value)
    .find((value) => value.endsWith(`${label}</button>`));
  expect(result, `watch control ${label}`).toBeDefined();
  return result!;
}
beforeEach(() => {
  state.watchlist = ["sh600519"];
  state.error = null;
  state.pending = false;
});
it("labels an existing watch without implying the add action is broken", () => {
  expect(button(render(), "已在自选")).toContain('disabled=""');
});
it("keeps a loaded unlisted security available to add", () => {
  expect(button(render("sh600000"), "加入自选")).not.toContain('disabled=""');
});
it.each([
  [null, false, "请先加载证券"],
  ["sh600000", true, "正在加载行情"],
  ["emBK0485", false, "板块暂不支持自选"],
] as const)(
  "explains unavailable security=%s loading=%s",
  (symbol, loading, label) => {
    expect(button(render(symbol, loading), label)).toContain('disabled=""');
  },
);
it("distinguishes reading, failed and saving states from an available add", () => {
  state.watchlist = undefined;
  expect(button(render("sh600000"), "正在读取自选")).toContain('disabled=""');
  state.error = new Error("fixture");
  expect(button(render("sh600000"), "自选列表读取失败")).toContain(
    'disabled=""',
  );
  state.watchlist = [];
  state.error = null;
  state.pending = true;
  expect(button(render("sh600000"), "正在加入自选")).toContain('disabled=""');
});
it("hides a stale browse list while a frozen candidate owns the chart", () => {
  // Same activeBrowse value also feeds useBrowseHotkey, so the old list cannot
  // step the frozen chart from the sidebar or PageUp/PageDown.
  const browse = {
    label: "选股候选",
    symbols: ["sh600519", "sh600000"],
    index: 0,
  };
  expect(render("sh600519", false, { browse })).toContain(
    "选股候选 1/2 · PgUp/PgDn 换股",
  );
  const frozen = render("sh600519", false, { browse, frozen: true });
  expect(frozen).not.toContain("PgUp/PgDn 换股");
  expect(frozen).not.toContain("选股候选");
});
