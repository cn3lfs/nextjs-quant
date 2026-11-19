import { afterEach, expect, it, vi } from "vitest";
import {
  navGroups,
  navItemFor,
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

const routes = {
  今日交易: [
    "/",
    "/?tab=overview",
    "/scan?tab=sentiment",
    "/scan?tab=valuation",
  ],
  行情看盘: ["/scan", "/scan?tab=crypto", "/scan?tab=futures"],
  选股筛选: [
    "/scan?tab=formula",
    "/scan?tab=rps",
    "/scan?tab=pool",
    "/accounts/alerts",
    "/?tab=intraday",
  ],
  策略回测: ["/lab", "/lab/backtest", "/lab?tab=catalog", "/lab?tab=tasks"],
  持仓复盘: [
    "/accounts",
    "/accounts?tab=ledger",
    "/accounts?tab=trades",
    "/accounts/review",
    "/accounts?tab=attribution",
    "/accounts?tab=weekly",
    "/accounts?tab=monthly",
    "/accounts?tab=paper",
    "/accounts/crypto",
  ],
  资讯研报: [
    "/intel",
    "/intel?tab=related",
    "/intel/review",
    "/lab/analysis",
    "/lab/reports",
  ],
  系统设置: [
    "/system",
    "/system/notifications",
    "/system/tasks",
    "/lab/data-guide",
    ...(process.env.NODE_ENV === "development" ? ["/system/ui-gallery"] : []),
  ],
};

it("assigns every workbench destination once across the seven workspaces", () => {
  const actual = navGroups.map(({ label, items }) => [
    label,
    items.map(({ href }) => href),
  ]);
  expect(actual).toEqual(Object.entries(routes));
  const hrefs = navGroups.flatMap(({ items }) => items.map(({ href }) => href));
  expect(new Set(hrefs).size).toBe(hrefs.length);
  expect(workspaceHrefs).toEqual([
    "/",
    "/scan",
    "/scan?tab=formula",
    "/lab",
    "/accounts",
    "/intel",
    "/system",
  ]);
  expect(tabHref("screen")).toBe("/scan?tab=formula");
  expect(tabHref("signals")).toBe("/system/notifications");
});

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
  expect(hrefs("  RPS ")).toEqual(["/scan?tab=rps"]);
  expect(hrefs("式选")).toEqual(["/scan?tab=formula"]);
  expect(hrefs("资讯研")).toEqual(routes.资讯研报);
  expect(hrefs("TAB=CRYPTO")).toEqual(["/scan?tab=crypto"]);
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
  for (const label of ["行情看盘", "选股筛选", "策略回测"])
    getState().toggleGroup(label);
  expect(getState().expandedGroups).toEqual(["选股筛选", "策略回测"]);
  getState().toggleGroup("选股筛选");
  expect(getState().expandedGroups).toEqual(["策略回测"]);
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
