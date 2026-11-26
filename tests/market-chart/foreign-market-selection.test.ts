import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useMarketSession } from "~/lib/stores/market-session";

// A hook harness exercises the real picker handlers without starting a browser.
const h = vi.hoisted(() => ({
  url: new URL("http://localhost/scan?tab=crypto"),
  cursor: 0,
  slots: [] as unknown[],
  effects: [] as (() => void)[],
  actions: new Map<string, () => void>(),
  load: vi.fn(),
  replace: vi.fn(),
  pickSource: null as ((value: string) => void) | null,
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      if (!(index in h.slots)) h.slots[index] = initial;
      return [
        h.slots[index],
        (next: unknown) => {
          h.slots[index] = next;
        },
      ];
    },
    useRef: (initial: unknown) => {
      const index = h.cursor++;
      return (h.slots[index] ??= { current: initial });
    },
    useEffect: (effect: () => void, deps: unknown[]) => {
      const index = h.cursor++;
      const previous = h.slots[index] as unknown[] | undefined;
      if (
        !previous ||
        deps.some((value, i) => !Object.is(value, previous[i]))
      ) {
        h.slots[index] = deps;
        h.effects.push(effect);
      }
    },
  };
});
vi.mock("next/navigation", () => ({
  usePathname: () => h.url.pathname,
  useSearchParams: () => new URLSearchParams(h.url.search),
}));
vi.mock("~/components/market/use-snapshot-load", () => ({
  useSnapshotLoad: () => ({ mutate: h.load, isPending: false, error: null }),
}));
vi.mock("~/components/market/chart-hotkeys", () => ({ usePeriodHotkey() {} }));
vi.mock("~/components/workbench/keep-alive", () => ({
  usePanelVisible: () => true,
}));
vi.mock("~/components/market/chart-workspace", () => ({
  ChartWorkspace: () => null,
}));
vi.mock("~/components/market/crypto-bot-panel", () => ({
  CryptoBotPanel: () => null,
}));
vi.mock("~/components/market/macro-rates-panel", () => ({
  MacroRatesPanel: () => null,
}));
vi.mock("~/trpc/react", () => ({
  api: {
    futuresQuotes: { useQuery: () => ({ data: [] }) },
    accountPositions: { useQuery: () => ({ data: { positions: [] } }) },
    useQueries: () => [],
  },
}));
vi.mock("~/components/panels", async () => {
  const { createElement } = await import("react");
  const frame = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    PageGrid: frame,
    Panel: frame,
    PanelEmpty: frame,
    Pill: frame,
    Segmented: () => null,
    ListPanel: ({
      items,
    }: {
      items: { key: string; action: ReactElement<{ onClick: () => void }> }[];
    }) => {
      for (const item of items)
        h.actions.set(item.key, item.action.props.onClick);
      return null;
    },
  };
});
vi.mock("~/components/ui/select", async () => {
  const { createElement } = await import("react");
  const frame = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    ...Object.fromEntries(
      [
        "Select",
        "SelectContent",
        "SelectItem",
        "SelectTrigger",
        "SelectValue",
      ].map((key) => [key, frame]),
    ),
    Select: ({
      children,
      onValueChange,
    }: {
      children?: ReactNode;
      onValueChange: (value: string) => void;
    }) => {
      h.pickSource = onValueChange;
      return frame({ children });
    },
  };
});
vi.mock("~/components/ui/dialog", async () => {
  const { createElement } = await import("react");
  const frame = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return Object.fromEntries(
    [
      "Dialog",
      "DialogContent",
      "DialogHeader",
      "DialogTitle",
      "DialogTrigger",
    ].map((key) => [key, frame]),
  );
});
import { CryptoQuotes } from "~/components/market/crypto-view";
import { FuturesView } from "~/components/market/futures-view";

function render(View: typeof CryptoQuotes | typeof FuturesView, flush = true) {
  h.cursor = 0;
  renderToStaticMarkup(createElement(View));
  if (flush) for (const effect of h.effects.splice(0)) effect();
}
beforeEach(() => {
  h.slots = [];
  h.effects = [];
  h.actions.clear();
  h.load.mockClear();
  h.replace.mockReset();
  h.pickSource = null;
  h.replace.mockImplementation((_data, _unused, href: string) => {
    // Next's patched native history also updates useSearchParams.
    h.url = new URL(href, h.url);
  });
  vi.stubGlobal("window", {
    get location() {
      return h.url;
    },
    history: { replaceState: h.replace },
  });
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  ["crypto", CryptoQuotes, "cxETHUSDT", "pair", "ETHUSDT"],
  ["futures", FuturesView, "fuAUM", "code", "AUM"],
] as const)(
  "keeps a selected %s instrument in the URL, with one request and a reload restoring it",
  (tab, View, symbol, param, value) => {
    h.url = new URL(`http://localhost/scan?tab=${tab}&job=keep-me#chart`);
    const aShareSession = useMarketSession.getState();
    render(View);
    h.load.mockClear();
    const click = h.actions.get(symbol);
    if (!click) throw new Error(`Missing picker action ${symbol}`);
    click();
    expect(h.url.searchParams.get(param)).toBe(value);
    expect(h.url.searchParams.get("tab")).toBe(tab);
    expect(h.url.searchParams.get("job")).toBe("keep-me");
    expect(h.url.hash).toBe("#chart");
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(h.load).toHaveBeenLastCalledWith(
      expect.objectContaining({ symbol }),
    );
    // URL reconciliation in the same mounted component must not fetch again.
    render(View);
    expect(h.load).toHaveBeenCalledTimes(1);
    expect(useMarketSession.getState()).toEqual(aShareSession);
    // A fresh mount consumes the URL rather than the default instrument.
    h.slots = [];
    h.load.mockClear();
    render(View);
    expect(h.load).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ symbol }),
    );
  },
);

it("preserves the crypto component across pair URL updates", () => {
  // A pair key would remount before the deduplication ref can reconcile it.
  expect(
    readFileSync("src/components/screening/scan-workspace.tsx", "utf8"),
  ).not.toMatch(/<Crypto\s+key=/);
});

it("honors an external crypto deep link once without rewriting it", () => {
  h.url = new URL("http://localhost/scan?tab=crypto&pair=BTCUSDT");
  render(CryptoQuotes);
  h.load.mockClear();
  h.url.searchParams.set("pair", "ETHUSDT");
  render(CryptoQuotes);
  expect(h.load).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ symbol: "cxETHUSDT" }),
  );
  expect(h.replace).not.toHaveBeenCalled();
});

it.each([
  ["crypto", CryptoQuotes, "pair", "ETHUSDT"],
  ["futures", FuturesView, "code", "AUM"],
] as const)(
  "ignores another page's matching %s tab in the retained scan panel",
  (tab, View, param, value) => {
    h.url = new URL(`http://localhost/scan?tab=${tab}&${param}=${value}`);
    render(View);
    h.load.mockClear();
    h.url = new URL(`http://localhost/system?tab=${tab}`);
    render(View);
    expect(h.load).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  },
);

it("does not let a delayed previous URL effect override a user's ETH selection", () => {
  h.url = new URL("http://localhost/scan?tab=crypto&pair=SOLUSDT");
  render(CryptoQuotes);
  h.load.mockClear();
  h.url.searchParams.set("pair", "BTCUSDT");
  render(CryptoQuotes, false);
  const click = h.actions.get("cxETHUSDT");
  if (!click) throw new Error("Missing ETH action");
  click();
  for (const effect of h.effects.splice(0)) effect();
  render(CryptoQuotes);
  expect(h.url.searchParams.get("pair")).toBe("ETHUSDT");
  expect(h.load).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ symbol: "cxETHUSDT" }),
  );
});

it("adapts an incompatible futures source during an external contract navigation", () => {
  h.url = new URL("http://localhost/scan?tab=futures&code=GC00Y");
  render(FuturesView);
  if (!h.pickSource) throw new Error("Missing futures source selector");
  h.pickSource("yahoo");
  render(FuturesView);
  h.load.mockClear();
  h.replace.mockClear();
  h.url.searchParams.set("code", "AUM");
  render(FuturesView);
  expect(h.load).toHaveBeenCalledExactlyOnceWith({
    symbol: "fuAUM",
    period: "day",
    futuresSource: "auto",
  });
  expect(h.replace).not.toHaveBeenCalled();
});

it("reconciles a retained crypto panel when returning from another page with the same query", () => {
  h.url = new URL("http://localhost/scan?tab=crypto&pair=ETHUSDT");
  render(CryptoQuotes);
  h.load.mockClear();
  h.url = new URL("http://localhost/system?tab=crypto&pair=SOLUSDT");
  render(CryptoQuotes);
  expect(h.load).not.toHaveBeenCalled();
  h.url = new URL("http://localhost/scan?tab=crypto&pair=SOLUSDT");
  render(CryptoQuotes);
  expect(h.load).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ symbol: "cxSOLUSDT" }),
  );
});

it.each([
  ["crypto", CryptoQuotes, "pair", "ETHUSDT"],
  ["futures", FuturesView, "code", "AUM"],
] as const)(
  "does not reload a retained %s panel when navigating to A shares",
  (tab, View, param, value) => {
    h.url = new URL(`http://localhost/scan?tab=${tab}&${param}=${value}`);
    render(View);
    h.load.mockClear();
    h.url = new URL("http://localhost/scan?symbol=sh600519");
    render(View);
    expect(h.load).not.toHaveBeenCalled();
    expect(h.replace).not.toHaveBeenCalled();
  },
);
