import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BrowseSource,
  ChartNavigationProvider,
  useOpenChart,
} from "~/components/market/open-chart";
import { useMarketSession } from "~/lib/stores/market-session";

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation }));
const original = useMarketSession.getState();
beforeEach(() => {
  navigation.push.mockClear();
  useMarketSession.setState({
    ...original,
    symbol: "sh600519",
    chartPeriod: "60m",
    period: "5m",
    marketSource: "local",
    adjustment: "forward",
    marketView: "financial",
    browse: { label: "old-list", symbols: ["sh600519"], index: 0 },
  });
});
afterEach(() => useMarketSession.setState(original, true));

function command(symbols?: readonly string[], origin?: "stock-rps") {
  const captured: { value: ReturnType<typeof useOpenChart> } = { value: null };
  function Probe() {
    captured.value = useOpenChart();
    return null;
  }
  const probe = createElement(Probe);
  renderToStaticMarkup(
    createElement(
      ChartNavigationProvider,
      null,
      symbols
        ? createElement(BrowseSource, {
            label: "selected-table",
            symbols,
            origin,
            children: probe,
          })
        : probe,
    ),
  );
  if (!captured.value) throw new Error("Missing chart navigation context");
  return captured.value;
}

it.each(["sh600000", "emBK0493"])(
  "preserves A-share chart selection and table browsing for %s",
  (symbol) => {
    command(["sh600519", symbol])(symbol);
    const href = navigation.push.mock.calls[0]![0] as string;
    const url = new URL(href, "http://localhost");
    expect(url.pathname).toBe("/scan");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      symbol,
      period: "60m",
      adjustment: "forward",
      source: "local",
      base: "5m",
    });
    expect(navigation.push).toHaveBeenCalledWith(href, { scroll: false });
    expect(useMarketSession.getState().browse).toEqual({
      label: "selected-table",
      symbols: ["sh600519", symbol],
      index: 1,
      activationId: expect.any(Number),
    });
    // Untyped lists omit origin while tagging external opens with activationId.
    expect(useMarketSession.getState().browse).not.toHaveProperty("origin");
    expect(useMarketSession.getState().symbol).toBe("sh600519");
  },
);

it("passes a typed stock-RPS origin through to the browse list", () => {
  command(["sh600519", "sh600000"], "stock-rps")("sh600000");
  expect(useMarketSession.getState().browse).toEqual({
    label: "selected-table",
    symbols: ["sh600519", "sh600000"],
    index: 1,
    origin: "stock-rps",
    activationId: expect.any(Number),
  });
});

it.each([
  ["cxBTCUSDT", "/scan?tab=crypto&pair=BTCUSDT"],
  ["fuAUM", "/scan?tab=futures&code=AUM"],
] as const)(
  "keeps the %s market destination without mutating the A-share session",
  (symbol, href) => {
    const before = useMarketSession.getState();
    command([symbol])(symbol);
    expect(navigation.push).toHaveBeenCalledExactlyOnceWith(href, {
      scroll: false,
    });
    expect(useMarketSession.getState()).toEqual(before);
  },
);

it("clears a previous table only for an A-share command without a source list", () => {
  command()("sh600000");
  expect(useMarketSession.getState().browse).toBeNull();
});
