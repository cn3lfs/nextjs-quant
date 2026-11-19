import { Children, createElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import {
  navGroups,
  navItemFor,
  navItems,
  searchNav,
  tabHref,
  workspaceHrefs,
} from "~/components/workbench/navigation";
import {
  alertModeLabel,
  alertModeLabels,
  glossary,
  marketLabel,
  marketLabels,
  termLabel,
} from "~/lib/common/ui-glossary";
import { useWorkbenchUiStore } from "~/lib/stores/workbench-ui-store";
import { marketRouter } from "~/server/api/routers/market";
import { put } from "~/server/db";
import { settings } from "~/server/infra/settings";
import { CommandPalette } from "~/components/workbench/command-palette";

const palette = vi.hoisted(() => ({
  query: undefined as string | undefined,
  push: vi.fn(),
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    // Supply a settled input to the command component while keeping real render hooks.
    useState: <T>(initial: T) =>
      react.useState(
        palette.query !== undefined && initial === "" ? palette.query : initial,
      ),
  };
});
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: palette.push }),
}));
vi.mock("~/trpc/react", () => ({
  api: { quickSearchSecurities: { useQuery: () => ({}) } },
}));

it("assigns each public destination to one workspace and resolves its tab", () => {
  const groupLabels = navGroups.map(({ label }) => label);
  expect(new Set(groupLabels).size).toBe(groupLabels.length);
  expect(workspaceHrefs).toEqual(navGroups.map(({ items }) => items[0]?.href));

  const destinations = new Set<string>();
  for (const group of navGroups) {
    expect(group.label.trim()).not.toBe("");
    expect(group.subtitle.trim()).not.toBe("");
    expect(group.items[0]?.hidden).not.toBe(true);
    expect(group.items.some((item) => !item.hidden)).toBe(true);
    for (const item of group.items) {
      if (item.hidden) continue;
      expect(destinations.has(item.href), item.href).toBe(false);
      destinations.add(item.href);

      const url = new URL(item.href, "https://workbench.test");
      expect(url.origin, item.href).toBe("https://workbench.test");
      expect(navItemFor(url.pathname, url.search), item.href).toMatchObject({
        href: item.href,
        group: group.label,
      });
      if (item.tab) expect(tabHref(item.tab)).toBe(item.href);
    }
  }
  expect(
    navItems
      .filter((item) => !item.hidden)
      .map(({ href }) => href)
      .sort(),
  ).toEqual([...destinations].sort());
  expect(tabHref("screen")).toBe("/scan?tab=formula");
  expect(tabHref("signals")).toBe("/system/notifications");
});

function* elements(node: ReactNode): IterableIterator<{
  role?: string;
  children?: ReactNode;
  onClick?: () => void;
}> {
  for (const child of Children.toArray(node)) {
    if (
      !isValidElement<{
        role?: string;
        children?: ReactNode;
        onClick?: () => void;
      }>(child)
    )
      continue;
    yield child.props;
    yield* elements(child.props.children);
  }
}

it.each(navItems.filter((item) => !item.hidden))(
  "can navigate to $href from the command palette",
  (item) => {
    const onOpenChange = vi.fn();
    let select: (() => void) | undefined;
    palette.push.mockClear();
    function Probe() {
      const view = CommandPalette({
        open: true,
        onOpenChange,
        onOpenHelp: vi.fn(),
      });
      select = [...elements(view)].find(
        (props) =>
          props.role === "option" &&
          [...elements(props.children)].some(
            (child) => child.children === item.label,
          ),
      )?.onClick;
      return null;
    }
    try {
      for (const query of [item.href, item.label]) {
        palette.query = query;
        renderToStaticMarkup(createElement(Probe));
        if (select) break;
      }
    } finally {
      palette.query = undefined;
    }
    expect(select).toBeTypeOf("function");
    select?.();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(palette.push).toHaveBeenCalledExactlyOnceWith(item.href, {
      scroll: false,
    });
  },
);

it.each([
  ["/scan", "?job=123&tab=formula", "/scan?tab=formula"],
  ["/scan", "?tab=sentiment&job=123", "/scan?tab=sentiment"],
  ["/scan", "?symbol=sh600000", "/scan"],
  ["/scan", "?tab=form", undefined],
  ["/scan", "?tab=", undefined],
  ["/", "?tab=formula", undefined],
  ["/lab?tab=tasks", "?tab=catalog", "/lab?tab=catalog"],
])("resolves pathname %s and search %s to %s", (pathname, search, href) => {
  expect(navItemFor(pathname, search)?.href).toBe(href);
});

it("matches partial Chinese names, groups and case-insensitive route text in the palette", () => {
  const hrefs = (query: string) => searchNav(query).map(({ href }) => href);
  expect(hrefs("   ")).toEqual([]);
  expect(hrefs("  RPS ")).toContain("/scan?tab=rps");
  expect(hrefs("式选")).toContain("/scan?tab=formula");
  expect(hrefs("资讯研")).toContain("/intel/review");
  expect(hrefs("TAB=CRYPTO")).toContain("/scan?tab=crypto");
  expect(hrefs("未收录的入口")).toEqual([]);
  expect(navItemFor("/lab/reports/report-1")).toMatchObject({
    href: "/lab/reports",
    title: "研究报告详情",
  });
});

it("renders all glossary values in readable Chinese and preserves fallback semantics", () => {
  expect(Object.keys(glossary)).toEqual(
    expect.arrayContaining([
      "off",
      "shadow",
      "live",
      "sleeve",
      "frozenSnapshot",
      "paperAccount",
      "ruleCheckOnly",
      "stale",
      "unverified",
      "freshClose",
      "intraday",
      "outbox",
      "decay",
      "protection",
    ]),
  );
  for (const [labels, labelFor] of [
    [glossary, termLabel],
    [alertModeLabels, alertModeLabel],
    [marketLabels, marketLabel],
  ] as const) {
    for (const [key, label] of Object.entries(labels)) {
      expect(label.trim(), key).toMatch(/\p{Script=Han}/u);
      expect(labelFor(key)).toBe(label);
    }
    expect(labelFor(null)).toBe("—");
    expect(labelFor("")).toBe("—");
    expect(labelFor("future-key")).toBe("future-key");
  }
  expect(termLabel("shadow")).toBe("观察模式（不推送）");
  expect(termLabel("frozenSnapshot")).toBe("选股当时快照");
});

afterEach(() =>
  useWorkbenchUiStore.setState(useWorkbenchUiStore.getInitialState(), true),
);

it("toggles density, collapsed rail and zen independently and keeps zen out of persisted preferences", () => {
  const { getState, persist } = useWorkbenchUiStore;
  expect(getState()).toMatchObject({
    density: "comfort",
    sidebarCollapsed: false,
    zenMode: false,
  });
  getState().toggleDensity();
  getState().toggleSidebar();
  getState().toggleZen();
  expect(getState()).toMatchObject({
    density: "compact",
    sidebarCollapsed: true,
    zenMode: true,
  });
  expect(persist.getOptions().partialize?.(getState())).toEqual({
    density: "compact",
    sidebarCollapsed: true,
    expandedGroups: [],
    singleKeyShortcuts: true,
  });
  getState().toggleZen();
  expect(getState()).toMatchObject({
    density: "compact",
    sidebarCollapsed: true,
    zenMode: false,
  });
  getState().toggleSidebar();
  getState().toggleDensity();
  expect(getState()).toMatchObject({
    density: "comfort",
    sidebarCollapsed: false,
    zenMode: false,
  });
});

it("keeps the two most recently expanded manual groups and closes a toggled group", () => {
  const { getState } = useWorkbenchUiStore;
  const [first, second, third] = navGroups.map(({ label }) => label);
  for (const label of [first!, second!, third!]) getState().toggleGroup(label);
  expect(getState().expandedGroups).toEqual([second, third]);
  getState().toggleGroup(second!);
  expect(getState().expandedGroups).toEqual([third]);
});

it("uses only a matching local security directory, ranks matches before slicing, and rejects invalid API edges", async () => {
  const fetch = vi.fn(() => {
    throw new Error("Unexpected external request");
  });
  vi.stubGlobal("fetch", fetch);
  try {
    const caller = marketRouter.createCaller({ headers: new Headers() });
    const root = settings().tdxRoot;
    const entries = {
      sh601003: { symbol: "sh601003", name: "浦发银行" },
      sh601002: { symbol: "sh601002", name: "PF银行" },
      sh601001: { symbol: "sh601001", name: "平安银行" },
    };
    put("security-directory", "security-directory", {
      root: `${root}-stale`,
      entries,
    });
    await expect(
      caller.quickSearchSecurities({ query: "BTC" }),
    ).resolves.toEqual({ ready: false, items: [] });
    put("security-directory", "security-directory", { root, entries });
    await expect(
      caller.quickSearchSecurities({ query: "   " }),
    ).resolves.toEqual({ ready: true, items: [] });
    await expect(
      caller.quickSearchSecurities({ query: "  PF  ", limit: 1 }),
    ).resolves.toEqual({
      ready: true,
      items: [
        {
          ...entries.sh601002,
          market: "cn-equity",
          matchType: "name",
          ready: true,
        },
      ],
    });
    await expect(
      caller.quickSearchSecurities({ query: "60100", limit: 2 }),
    ).resolves.toEqual({
      ready: true,
      items: [entries.sh601001, entries.sh601002].map((entry) => ({
        ...entry,
        market: "cn-equity",
        matchType: "code",
        ready: true,
      })),
    });
    await expect(
      caller.quickSearchSecurities({ query: "BNBUSDT" }),
    ).resolves.toEqual({ ready: true, items: [] });
    for (const input of [
      { query: "x".repeat(101) },
      { query: "pf", limit: 0 },
      { query: "pf", limit: 26 },
    ]) {
      await expect(caller.quickSearchSecurities(input)).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
  } finally {
    vi.unstubAllGlobals();
    expect(fetch).toHaveBeenCalledTimes(0);
  }
});
