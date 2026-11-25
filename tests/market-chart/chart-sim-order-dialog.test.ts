import { QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { getQueryKey } from "@trpc/react-query";
import {
  createElement,
  type ComponentProps,
  type ReactElement,
  type ReactNode,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import SuperJSON from "superjson";
import { beforeEach, expect, it, vi } from "vitest";
import {
  ChartSimOrderDialog,
  parseFuturesOrderPreview,
} from "~/components/market/chart-sim-order-dialog";
import { CryptoQuotes } from "~/components/market/crypto-view";
import { FuturesView } from "~/components/market/futures-view";
import { ParallelAccountsHub } from "~/components/portfolio/parallel-accounts-hub";
import { MarketView } from "~/components/workbench/market-view";
import type { Bar } from "~/lib/domain";
import { futuresContract } from "~/lib/market/futures";
import { futuresContractCurrency } from "~/lib/portfolio/futures-sim";
import { createQueryClient } from "~/trpc/query-client";
import { api, type RouterOutputs } from "~/trpc/react";

const route = vi.hoisted(() => ({ search: "" }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/scan",
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(route.search),
}));

vi.mock("~/components/market/chart-workspace", () => ({
  ChartWorkspace: () => null,
}));
vi.mock("~/components/market/market-security-views", () => ({
  MarketSecurityViews: () => null,
}));
vi.mock("~/components/market/tdx-side-panel", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("~/components/market/tdx-side-panel")
  >()),
  TdxSidePanel: () => null,
}));

vi.mock(
  "~/components/market/chart-sim-order-dialog",
  async (importOriginal) => {
    const dialog =
      await importOriginal<
        typeof import("~/components/market/chart-sim-order-dialog")
      >();
    return {
      ...dialog,
      ChartSimOrderDialog: vi.fn(dialog.ChartSimOrderDialog),
    };
  },
);

vi.mock("~/components/ui/dialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/components/ui/dialog")>()),
  // Radix portals need a DOM. Render the content inline for static assertions.
  DialogContent: ({ children }: { children?: ReactNode }) => children,
}));

beforeEach(() => {
  route.search = "";
  vi.mocked(ChartSimOrderDialog).mockClear();
});

function render(node: ReactElement) {
  const queryClient = createQueryClient();
  queryClient.setQueryData<RouterOutputs["simAccountsList"]>(
    getQueryKey(api.simAccountsList, undefined, "query"),
    [],
  );
  queryClient.setQueryData<RouterOutputs["futuresSimAccountsList"]>(
    getQueryKey(api.futuresSimAccountsList, undefined, "query"),
    [],
  );
  queryClient.setQueryData<RouterOutputs["futuresQuotes"]>(
    getQueryKey(api.futuresQuotes, undefined, "query"),
    [
      { symbol: "fuGC00Y", close: 2450.6, changePct: null, time: null },
      { symbol: "fuALI", close: 2500.25, changePct: null, time: null },
    ],
  );
  const client = api.createClient({
    links: [
      httpBatchLink({
        url: "https://chart-order.test/api/trpc",
        transformer: SuperJSON,
        fetch: async () => {
          throw new Error("Unexpected network request in chart order test");
        },
      }),
    ],
  });
  return renderToStaticMarkup(
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(api.Provider, {
        client,
        queryClient,
        children: node,
      }),
    }),
  );
}

type LoadedMarket = NonNullable<
  ComponentProps<typeof MarketView>["state"]["loaded"]
>;

function renderMarket(
  symbol: string,
  loaded: Partial<LoadedMarket> = {},
  frozen = false,
) {
  const bar: Bar = {
    date: "2026-11-24",
    open: 600,
    high: 600,
    low: 600,
    close: 600,
    volume: 100,
    amount: 60000,
  };
  const state: ComponentProps<typeof MarketView>["state"] = {
    marketSource: "local",
    marketView: "chart",
    symbol,
    period: "day",
    loaded: {
      id: "chart-order-fixture",
      symbol,
      period: "day",
      source: "tdx-local",
      adjustment: "forward",
      createdAt: 1,
      bars: [bar],
      rawBars: [
        { ...bar, open: 650, high: 650, low: 650, close: 650, amount: 65000 },
      ],
      hash: "chart-order-fixture",
      ...loaded,
    },
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
  };
  return render(createElement(MarketView, { state, frozen, notify: vi.fn() }));
}

function expectOrderButton(html: string, disabled: boolean) {
  const buttons = [...html.matchAll(/<button\b([^>]*)>模拟下单<\/button>/g)];
  expect(buttons).toHaveLength(1);
  const attributes = buttons[0]?.[1];
  expect(attributes).toContain('aria-haspopup="dialog"');
  expect(attributes?.includes(' disabled=""')).toBe(disabled);
}

function renderOrderDialog(
  expectedMarket: ComponentProps<typeof ChartSimOrderDialog>["market"],
) {
  const props = vi.mocked(ChartSimOrderDialog).mock.lastCall?.[0];
  expect(props?.market).toBe(expectedMarket);
  if (!props)
    throw new Error("Chart did not render its simulated order dialog");
  return render(createElement(ChartSimOrderDialog, { ...props, open: true }));
}

it.each([
  ["fuAUM", "CNY"],
  ["fuCUM", "CNY"],
  ["fuGC00Y", "USD"],
  ["fuSI00Y", "USD"],
])("maps futures contract %s to %s (BR1)", (symbol, currency) => {
  const contract = futuresContract(symbol);
  if (!contract) throw new Error(`Missing contract ${symbol}`);
  expect(futuresContractCurrency(contract)).toBe(currency);
});

it("enables A-share simulated ordering and prefills the unadjusted stock price (R1, BR4)", () => {
  expectOrderButton(renderMarket("sh600519"), false);
  const dialog = renderOrderDialog("cn-equity");
  expect(dialog).toContain("SH600519");
  expect(dialog).toContain("最新参考价 650.00");
  expect(dialog).toMatch(
    /<input\b(?=[^>]*aria-label="价格")[^>]*value="650\.00"/,
  );
  expect(dialog).toContain("本地模拟账户");
  expect(dialog).toContain("同花顺模拟账户");
  expect(dialog).toContain("一键创建默认模拟账户");
});

it.each([
  ["dated snapshot", { historicalAsOf: "2026-11-23" }, false, "2026-11-23"],
  ["frozen candidate", { frozenCandidate: true }, false, "2026-11-24"],
  ["frozen route", {}, true, "2026-11-24"],
] as const)(
  "requires manual pricing for the %s even when its raw price is available",
  (_kind, loaded, frozen, date) => {
    expectOrderButton(renderMarket("sh600519", loaded, frozen), false);
    expect(vi.mocked(ChartSimOrderDialog).mock.lastCall?.[0]).toMatchObject({
      referencePrice: null,
      referencePriceSource: "snapshot",
      referenceDate: date,
    });
    const dialog = renderOrderDialog("cn-equity");
    expect(dialog).toContain(`快照日期 ${date}`);
    expect(dialog).toContain("为避免按历史旧价误成交");
    expectManualPrice(dialog);
  },
);

it("requires manual pricing when only an adjusted bar matches the latest chart date", () => {
  renderMarket("sh600519", {
    rawBars: [
      {
        date: "2026-11-23",
        open: 650,
        high: 650,
        low: 650,
        close: 650,
        volume: 100,
        amount: 65000,
      },
    ],
  });
  expect(vi.mocked(ChartSimOrderDialog).mock.lastCall?.[0]).toMatchObject({
    referencePrice: null,
    referencePriceSource: "adjusted",
    referenceDate: "2026-11-24",
  });
  const dialog = renderOrderDialog("cn-equity");
  expect(dialog).toContain("当前图表（2026-11-24）仅有复权价");
  expectManualPrice(dialog);
});

it.each(["snapshot", "adjusted", "missing"] as const)(
  "ignores a numeric value marked as %s",
  (referencePriceSource) => {
    const dialog = render(
      createElement(ChartSimOrderDialog, {
        open: true,
        onOpenChange: vi.fn(),
        market: "cn-equity",
        symbol: "sh600519",
        displayName: "贵州茅台",
        referencePrice: 650,
        referencePriceSource,
        referenceDate: "2026-11-24",
      }),
    );
    expectManualPrice(dialog);
  },
);

function expectManualPrice(dialog: string) {
  expect(dialog).toContain("最新参考价 —");
  expect(dialog).toMatch(/<p\b(?=[^>]*role="note")(?=[^>]*text-nc-warn)/);
  expect(dialog).toMatch(
    /<button\b[^>]* disabled=""[^>]*>回填最新价<\/button>/,
  );
  expect(dialog).toMatch(/<input\b(?=[^>]*aria-label="价格")[^>]*value=""/);
  expect(dialog).not.toContain("650.00");
}

it.each([
  ["index", "sh000300"],
  ["sector", "emBK0475"],
])("disables simulated ordering for an A-share %s (R1)", (_kind, symbol) => {
  expectOrderButton(renderMarket(symbol), true);
});

it("opens the simulated order dialog for the selected crypto pair (R2)", () => {
  route.search = "tab=crypto&pair=ETHUSDT";
  expectOrderButton(render(createElement(CryptoQuotes)), false);
  const dialog = renderOrderDialog("crypto");
  expect(dialog).toContain("CXETHUSDT");
  expect(dialog).toContain("一键创建默认模拟账户");
  expect(dialog).not.toContain("同花顺模拟账户");
});

it("opens the futures simulated dialog with the selected contract, quote and USD account option (R3)", () => {
  route.search = "tab=futures&code=GC00Y";
  expectOrderButton(render(createElement(FuturesView)), false);
  const dialog = renderOrderDialog("futures");
  expect(dialog).toContain("FUGC00Y");
  expect(dialog).toContain("最新参考价 2450.6");
  expect(dialog).toContain("合约乘数 100 盎司/手");
  expect(dialog).toContain("当前合约使用 USD，默认初始资金 200,000 USD");
  expect(dialog).toContain("一键创建期货模拟账户");
  expect(dialog).toContain("/accounts?tab=paper&amp;channel=futures-sim");
});

it("preserves a COMEX aluminum quarter-dollar quote for its 25-tonne lot", () => {
  route.search = "tab=futures&code=ALI";
  expectOrderButton(render(createElement(FuturesView)), false);
  const dialog = renderOrderDialog("futures");
  expect(dialog).toContain("最新参考价 2500.25");
  expect(dialog).toContain("合约乘数 25 吨/手");
});

it("shows the domestic contract multiplier and CNY account opening capital", () => {
  route.search = "tab=futures&code=AUM";
  expectOrderButton(render(createElement(FuturesView)), false);
  const dialog = renderOrderDialog("futures");
  expect(dialog).toContain("合约乘数 1,000 克/手");
  expect(dialog).toContain("当前合约使用 CNY，默认初始资金 1,000,000 CNY");
});

it("parses the entered futures margin percentage into an exact decimal ratio", () => {
  const order = {
    accountId: "usd-futures-fixture",
    symbol: "fuGC00Y",
    action: "buy_open",
    quantity: 1,
    price: "2450.6",
  } as const;
  expect(parseFuturesOrderPreview(order, "10.1")).toEqual({
    success: true,
    data: { ...order, marginRate: "0.101" },
  });
  expect(parseFuturesOrderPreview(order, "4.99").success).toBe(false);
  expect(parseFuturesOrderPreview(order, "1e999999").success).toBe(false);
});

it("renders the four parallel account tabs and opens the futures account panel from its URL", () => {
  route.search = "tab=paper&channel=futures-sim";
  const html = render(createElement(ParallelAccountsHub));
  const tabs = [
    ...html.matchAll(
      /<button\b(?=[^>]*\brole="tab")(?=[^>]*\baria-selected="(true|false)")[^>]*>([^<]+)<\/button>/g,
    ),
  ];
  expect(tabs.map(([, selected, label]) => [label, selected])).toEqual([
    ["本地模拟账户", "false"],
    ["同花顺模拟账户", "false"],
    ["同花顺实盘账户", "false"],
    ["期货模拟账户", "true"],
  ]);
  expect(html).toContain("创建期货模拟账户");
});
