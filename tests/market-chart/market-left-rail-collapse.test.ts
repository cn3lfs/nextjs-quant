import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import type { Snapshot } from "../../src/lib/domain";
import { stepBrowse, type BrowseList } from "../../src/lib/market/browse-list";
import { useMarketSession } from "../../src/lib/stores/market-session";
import { Button } from "../../src/components/ui/button";
import { useBrowseHotkey } from "../../src/components/market/use-browse-hotkey";

const { mount } = vi.hoisted(() => ({
  mount: {
    current: null as {
      cursor: number;
      slots: unknown[];
      effects: (() => void)[];
    } | null,
  },
}));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState<T>(initial: T) {
      const frame = mount.current;
      if (!frame) return react.useState(initial);
      const index = frame.cursor++;
      if (!(index in frame.slots)) frame.slots[index] = initial;
      return [
        frame.slots[index] as T,
        (next: T | ((current: T) => T)) => {
          frame.slots[index] =
            typeof next === "function"
              ? (next as (current: T) => T)(frame.slots[index] as T)
              : next;
        },
      ];
    },
    useRef<T>(initial: T) {
      const frame = mount.current;
      if (!frame) return react.useRef(initial);
      const index = frame.cursor++;
      return (frame.slots[index] ??= { current: initial });
    },
    useEffect(effect: () => void, deps: readonly unknown[]) {
      const frame = mount.current;
      if (!frame) return react.useEffect(effect, deps);
      const index = frame.cursor++;
      const previous = frame.slots[index] as typeof deps | undefined;
      if (!previous || deps.some((dep, i) => !Object.is(dep, previous[i]))) {
        frame.slots[index] = deps;
        frame.effects.push(effect);
      }
    },
  };
});

vi.mock("~/components/ui/button", async (original) => {
  const ui = await original<typeof import("~/components/ui/button")>();
  return { ...ui, Button: vi.fn(ui.Button) };
});

const securities = {
  sh600519: "贵州茅台",
  sh601899: "紫金矿业",
  sz002475: "立讯精密",
};

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
  useSecurityNames: () => ({ data: securities }),
}));
vi.mock("~/components/market/chart-hotkeys", () => ({ usePeriodHotkey() {} }));
vi.mock("~/components/market/use-browse-hotkey", () => ({
  useBrowseHotkey: vi.fn(),
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
  const { SecurityCell } = await import("~/components/panels/panel");
  const frame = ({ children }: { children?: ReactNode }) =>
    createElement("div", null, children);
  return {
    Panel: frame,
    PageGrid: frame,
    GridTable: () => null,
    SecurityCell,
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

function marketProps(
  props: Partial<ComponentProps<typeof MarketView>> = {},
  browse: BrowseList | null = null,
) {
  const symbol = browse?.symbols[browse.index] ?? snapshot.symbol;
  const state = {
    marketSource: "local",
    marketView: "chart",
    symbol,
    period: "day",
    loaded: { ...snapshot, symbol },
    load: {
      isPending: false,
      isRevalidating: false,
      error: null,
      mutate: vi.fn(),
      acceptSnapshot: vi.fn(),
      acceptFrozenSnapshot: vi.fn(),
    },
    browse,
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

  return { state, notify: vi.fn(), ...props };
}

function renderMarket(
  props: Partial<ComponentProps<typeof MarketView>> = {},
  browse: BrowseList | null = null,
) {
  return renderToStaticMarkup(
    createElement(MarketView, marketProps(props, browse)),
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
  const pattern = new RegExp(`<(/?)${tag}\\b([^>]*)>`, "g");
  const open: RegExpExecArray[] = [];
  const elements = [];
  for (const match of html.matchAll(pattern)) {
    if (!match[1]) {
      open.push(match);
      continue;
    }
    const start = open.pop();
    if (!start) continue;
    const attrs = parseAttributes(start[2] ?? "");
    const innerHtml = html.slice(start.index + start[0].length, match.index);
    elements.push({
      index: start.index,
      attrs,
      classes: (attrs.class ?? "").split(/\s+/).filter(Boolean),
      innerHtml,
      text: stripTags(innerHtml),
    });
  }
  return elements.sort((a, b) => a.index - b.index);
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

it.each([
  {
    label: "连板梯队",
    symbols: ["sh600519", "sh601899", "sz002475"],
    index: 1,
  },
  { label: "行业 · 有色金属", symbols: ["sh601899", "sh600519"], index: 0 },
  { label: "概念 · 算力硬件", symbols: ["sz002475", "sh601899"], index: 1 },
  {
    label: "RPS 排名",
    symbols: ["sz002475", "sh600519", "sh601899"],
    index: 2,
  },
] satisfies (BrowseList & { symbols: (keyof typeof securities)[] })[])(
  "opens the left rail on the $label temporary list and marks its active row",
  ({ label, symbols, index }) => {
    const html = renderMarket({}, { label, symbols, index });
    const terminal = findOpenTags(html, "div").find((node) =>
      node.classes.includes("nc-market-terminal"),
    );
    expect(terminal?.attrs["data-left-collapsed"]).toBe("false");

    const leftRail = findElements(html, "aside").find(
      (node) => node.attrs["aria-label"] === "自选与扫描候选",
    )!;
    const buttons = findElements(leftRail.innerHtml, "button");
    const tab = buttons.find(
      (node) =>
        node.attrs.role === "tab" && node.attrs["aria-selected"] === "true",
    );
    expect(tab?.text).toBe(`${label} (${symbols.length})`);

    const region = findElements(leftRail.innerHtml, "div").find(
      (node) => node.attrs["aria-label"] === "当前临时列表",
    );
    expect(region?.attrs.role).toBe("region");
    const rows = findElements(region!.innerHtml, "button").filter((node) =>
      /(?:SH|SZ)\d{6}$/.test(node.text),
    );
    expect(rows.map(({ text }) => text)).toEqual(
      symbols.map(
        (symbol, i) => `${i + 1}${securities[symbol]}${symbol.toUpperCase()}`,
      ),
    );
    expect(rows.map(({ attrs }) => attrs["aria-current"])).toEqual(
      symbols.map((_, i) => (i === index ? "true" : undefined)),
    );
    expect(
      rows.filter(({ classes }) => classes.includes("border-nc-accent")),
    ).toEqual([rows[index]]);
  },
);

it.each(["collapse", "watch"] as const)(
  "reopens the same temporary list after %s while an in-chart step preserves the rail",
  (action) => {
    const { setBrowse } = useMarketSession.getState();
    const list: BrowseList = {
      label: "RPS 排名",
      symbols: ["sh600519", "sh601899", "sz002475"],
      index: 0,
    };
    const getBrowse = () => useMarketSession.getState().browse!;
    const frame = {
      cursor: 0,
      slots: [] as unknown[],
      effects: [] as (() => void)[],
    };
    // Retain MarketView's state across SSR renders, as the pinned chart does.
    function MountedMarket() {
      frame.cursor = 0;
      mount.current = frame;
      try {
        const props = marketProps({}, getBrowse());
        return MarketView({ ...props, state: { ...props.state, setBrowse } });
      } finally {
        mount.current = null;
      }
    }
    const render = () => {
      vi.mocked(Button).mockClear();
      const html = renderToStaticMarkup(createElement(MountedMarket));
      const pending = frame.effects.splice(0);
      if (!pending.length) return html;
      pending.forEach((effect) => effect());
      return render();
    };

    try {
      setBrowse(list);
      const initialActivation = getBrowse().activationId;
      render();
      const [railControl] = vi
        .mocked(Button)
        .mock.calls.find(([props]) =>
          action === "collapse"
            ? props["aria-label"] === "收起列表"
            : props.role === "tab" && props.title?.startsWith("我的自选"),
        )!;
      railControl.onClick!(
        {} as Parameters<NonNullable<typeof railControl.onClick>>[0],
      );
      const activeTab = (html: string) =>
        findOpenTags(html, "button").find(
          ({ attrs }) =>
            attrs.role === "tab" && attrs["aria-selected"] === "true",
        )?.attrs.title;
      const isCollapsed = (html: string) =>
        findOpenTags(html, "div").find(({ classes }) =>
          classes.includes("nc-market-terminal"),
        )?.attrs["data-left-collapsed"];
      const expectRailChoice = (html: string) => {
        if (action === "collapse") {
          expect(isCollapsed(html)).toBe("true");
        } else {
          expect(activeTab(html)).toBe("我的自选 (1)");
        }
      };
      expectRailChoice(render());

      const [, move] = vi.mocked(useBrowseHotkey).mock.lastCall!;
      move(stepBrowse(getBrowse(), 1)!);
      expect(getBrowse().index).toBe(1);
      expect(getBrowse().activationId).toBe(initialActivation);
      expectRailChoice(render());

      setBrowse({ ...list, index: 2 });
      const html = render();
      expect(isCollapsed(html)).toBe("false");
      expect(activeTab(html)).toBe("RPS 排名 (3)");
      expect(getBrowse().activationId).toBeGreaterThan(initialActivation!);
    } finally {
      setBrowse(null);
    }
  },
);
