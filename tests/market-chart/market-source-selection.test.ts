import { createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { put } from "~/server/db";
import { jobSummaries } from "~/server/db/job-summaries";
import { chartBars, chartBarsInput } from "~/server/charts/chart-bars";
import {
  marketSourceLabels,
  marketSourceSchema,
} from "~/lib/market/market-source";
import { settingsSchema, type Snapshot } from "~/lib/domain";
import { saveSettings, settings } from "~/server/infra/settings";
import { freeChartHistory } from "~/server/market/free-chart-sources";
import {
  queryMcp,
  mcpConfigured,
  mcpTools,
  importLocalMcp,
} from "~/server/data-sources/tdx/tdx-mcp-disabled";
import { integrationsRouter } from "~/server/api/routers/integrations";
import { MarketView } from "~/components/workbench/market-view";
import { Select } from "~/components/ui/select";
import TasksPage from "~/app/system/tasks/page";
import { WorkbenchLayout } from "~/components/workbench/workbench-layout";
import { navItemFor, searchNav } from "~/components/workbench/navigation";

const deps = vi.hoisted(() => ({
  tstdx: vi.fn(),
  eastmoney: vi.fn(),
  tencent: vi.fn(),
  readBars: vi.fn(),
  readSecret: vi.fn(),
  newJob: vi.fn(),
  select: vi.fn(),
  taskHistory: vi.fn(),
  location: new URL("https://workbench.test/scan"),
}));
vi.mock("~/server/data-sources/tstdx/tstdx-adapter", async (original) => ({
  ...(await original<
    typeof import("~/server/data-sources/tstdx/tstdx-adapter")
  >()),
  tstdxKlines: deps.tstdx,
}));
vi.mock("~/server/data-sources/westock/westock-adapter", async (original) => ({
  ...(await original<
    typeof import("~/server/data-sources/westock/westock-adapter")
  >()),
  westockKlines: deps.tencent,
}));
vi.mock("~/server/market/chart-history", async (original) => ({
  ...(await original<typeof import("~/server/market/chart-history")>()),
  onlinePeriodHistory: deps.eastmoney,
}));
vi.mock("~/server/market/bar-store/read-bars", async (original) => ({
  ...(await original<typeof import("~/server/market/bar-store/read-bars")>()),
  readBars: deps.readBars,
}));
vi.mock("~/server/vault", async (original) => ({
  ...(await original<typeof import("~/server/vault")>()),
  readSecret: deps.readSecret,
}));
vi.mock("~/server/jobs/jobs", async (original) => ({
  ...(await original<typeof import("~/server/jobs/jobs")>()),
  newJob: deps.newJob,
}));
vi.mock("next/server", async (original) => ({
  ...(await original<typeof import("next/server")>()),
  connection: async () => {},
}));
vi.mock("next/navigation", () => ({
  usePathname: () => deps.location.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => deps.location.searchParams,
}));
vi.mock("~/components/workbench/use-task-visible", () => ({
  useTaskVisible: () => true,
  useScreenVisible: () => true,
}));
vi.mock("~/trpc/react", () => ({
  api: new Proxy(
    {},
    {
      get: (_, name: string) =>
        name === "useUtils"
          ? () => ({})
          : {
              useQuery: (input: unknown, options?: { enabled?: boolean }) => {
                if (name === "taskHistory" && options?.enabled !== false)
                  deps.taskHistory(input);
                return {};
              },
              useMutation: () => ({}),
            },
    },
  ),
}));
vi.mock("~/components/ui/select", async (original) => {
  const actual = await original<typeof import("~/components/ui/select")>();
  return {
    ...actual,
    Select: (props: ComponentProps<typeof actual.Select>) => {
      deps.select(props);
      return createElement(actual.Select, props);
    },
  };
});

const fetch = vi.fn(() => {
  throw new Error("Unexpected network call");
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("fetch", fetch);
  deps.location = new URL("https://workbench.test/scan");
  deps.readBars.mockRejectedValue(
    new Error("No live local bars in this fixture"),
  );
});
afterEach(() => vi.unstubAllGlobals());

const bar = {
  date: "2026-09-14",
  open: 10,
  close: 11,
  high: 12,
  low: 9,
  volume: 100,
  amount: 1000,
};
const source: Snapshot = {
  id: "selected",
  symbol: "sh600000",
  period: "day",
  source: "tdx-local",
  adjustment: "none",
  createdAt: 0,
  hash: "fixture",
  bars: [bar],
};
const formulaArchive: Snapshot = {
  id: "snapshot-formula-sh600000-0123456789abcdef",
  symbol: "sh600000",
  period: "day",
  source: "tdx-full-package",
  adjustment: "forward",
  createdAt: 1,
  hash: "archive-hash",
  requestedSource: "local",
  bars: [{ ...bar, date: "2026-09-10", close: 9 }],
  barStore: {
    version: "bar-store-1",
    market: "cn-equity",
    sourceFingerprint: "archive",
    sourceVersions: [],
    adjustment: "forward",
    adjustmentReference: "2026-09-10",
    coverage: {
      from: "2026-09-10",
      to: "2026-09-10",
      count: 1,
      historyExhausted: true,
    },
    formingDates: [],
    overlay: null,
    excluded: [{ date: "2026-09-09", reason: "停牌" }],
    availablePeriods: ["day", "week"],
  },
};

it("serves a formula candidate's archived bars instead of today's source", async () => {
  put("snapshot", formulaArchive.id, formulaArchive);
  // Any ordinary read would return a newer bar from the local package or online.
  const newer = [{ ...bar, date: "2026-11-17" }];
  deps.readBars.mockResolvedValue({ ...source, bars: newer });
  mockOnlineResponses();
  const result = await chartBars({
    snapshotId: formulaArchive.id,
    period: "day",
    limit: 100,
    adjustment: "forward",
  });
  expect(result.bars).toEqual(formulaArchive.bars);
  expect(result.source).toBe("tdx-full-package");
  expect(result.adjustment).toBe("forward");
  expect(result.excluded).toEqual(formulaArchive.barStore!.excluded);
  expect(result.formingDates).toEqual([]);
  // Only the archived period is advertised, not the live package's periods.
  expect(result.barStore?.availablePeriods).toEqual(["day"]);
  expect(deps.readBars).not.toHaveBeenCalled();
  expectNoOnlineRequests();
});
it("refuses a formula archive on another period or adjustment", async () => {
  put("snapshot", formulaArchive.id, formulaArchive);
  await expect(
    chartBars({
      snapshotId: formulaArchive.id,
      period: "week",
      limit: 100,
      adjustment: "forward",
    }),
  ).rejects.toThrow("冻结候选快照只存档 day 周期");
  await expect(
    chartBars({
      snapshotId: formulaArchive.id,
      period: "day",
      limit: 100,
      adjustment: "none",
    }),
  ).rejects.toThrow("冻结候选快照只存档 forward 复权");
  expect(deps.readBars).not.toHaveBeenCalled();
  expectNoOnlineRequests();
});
it("local selection never starts online requests, even for short or old history", async () => {
  put("snapshot", source.id, { ...source, requestedSource: "local" });
  const result = await chartBars({
    snapshotId: source.id,
    period: "day",
    limit: 100,
  });
  expect(result.bars).toEqual([bar]);
  expect(result.source).toBe("tdx-local");
  expectNoOnlineRequests();
});

it("does not fall back to a provider when a local read fails", async () => {
  put("snapshot", source.id, {
    ...source,
    source: "tdx-full-package",
    requestedSource: "local",
  });
  await expect(
    chartBars({ snapshotId: source.id, period: "day", limit: 100 }),
  ).rejects.toThrow("No live local bars in this fixture");
  expect(deps.readBars).toHaveBeenCalled();
  expectNoOnlineRequests();
});

const onlineSources = marketSourceSchema.options.filter(
  (id) => id !== "local" && id !== "auto",
);
// A source must name its own adapter and return that adapter's distinct data.
const onlineAdapters = {
  pytdx: { mock: deps.tstdx, source: "tdx-7709", close: 10 },
  eastmoney: { mock: deps.eastmoney, source: "eastmoney-online", close: 11 },
  tencent: { mock: deps.tencent, source: "tencent/westock-data", close: 12 },
} satisfies Record<
  (typeof onlineSources)[number],
  {
    mock: ReturnType<typeof vi.fn>;
    source: string;
    close: number;
  }
>;

function expectNoOnlineRequests() {
  for (const { mock } of Object.values(onlineAdapters))
    expect(mock).not.toHaveBeenCalled();
  expect(fetch).not.toHaveBeenCalled();
}

function mockOnlineResponses() {
  deps.tstdx.mockResolvedValue({
    items: [
      { status: "ok", bars: [{ ...bar, close: 10 }], historyExhausted: true },
    ],
    source: "tdx-7709",
    version: "test",
    warnings: [],
  });
  deps.eastmoney.mockResolvedValue({
    bars: [bar],
    source: "eastmoney-online",
    historyExhausted: true,
  });
  deps.tencent.mockResolvedValue({
    items: [{ status: "ok", bars: [{ ...bar, close: 12 }] }],
    version: "test",
    warnings: [],
  });
}

it.each(onlineSources)(
  "routes a manual %s period change to its own adapter without fallback",
  async (selected) => {
    mockOnlineResponses();
    const adapter = onlineAdapters[selected];
    put("snapshot", source.id, { ...source, requestedSource: selected });
    const request = {
      snapshotId: source.id,
      period: "week",
      limit: 100,
    } as const;
    const result = await chartBars(request);
    expect(result.source).toBe(adapter.source);
    expect(result.bars[0]?.close).toBe(adapter.close);
    expect(deps.readBars).not.toHaveBeenCalled();

    adapter.mock.mockRejectedValue(new Error("selected source unavailable"));
    await expect(chartBars(request)).rejects.toThrow(
      "selected source unavailable",
    );
    expect(adapter.mock).toHaveBeenCalledTimes(2);
    const args =
      selected === "eastmoney"
        ? ["sh600000", "week", 100]
        : [{ symbols: ["sh600000"], period: "week", limit: 100 }];
    for (const call of adapter.mock.mock.calls) expect(call).toEqual(args);
    for (const [id, other] of Object.entries(onlineAdapters))
      if (id !== selected) expect(other.mock).not.toHaveBeenCalled();
  },
);

it("auto tries the configured priority and discloses the source that actually succeeded", async () => {
  mockOnlineResponses();
  deps.tstdx.mockRejectedValue(new Error("first source unavailable"));
  deps.eastmoney.mockRejectedValue(new Error("second source unavailable"));
  const result = await freeChartHistory("sh600000", "week", 100, "auto");
  expect(deps.tstdx).toHaveBeenCalledTimes(1);
  expect(deps.eastmoney).toHaveBeenCalledTimes(1);
  expect(deps.tencent).toHaveBeenCalledTimes(1);
  expect(deps.tstdx).toHaveBeenCalledBefore(deps.eastmoney);
  expect(deps.eastmoney).toHaveBeenCalledBefore(deps.tencent);
  expect(result.source).toBe("tencent/westock-data");
  expect(result.sourceErrors?.map((error) => error.split("：").at(-1))).toEqual(
    ["first source unavailable", "second source unavailable"],
  );
});

it("round-trips every labeled source through settings storage", () => {
  expect(settingsSchema.parse({}).marketDataSource).toBe("auto");
  expect(marketSourceSchema.parse("pytdx")).toBe("pytdx");
  for (const id of marketSourceSchema.options) {
    expect(marketSourceLabels[id], id).toEqual(expect.any(String));
    expect(marketSourceLabels[id].trim(), id).not.toBe("");
    const parsed = settingsSchema.parse({ marketDataSource: id });
    expect(parsed.marketDataSource).toBe(id);
    saveSettings(parsed);
    expect(settings().marketDataSource).toBe(id);
  }
  for (const bad of ["mcp", "unknown-provider", ""]) {
    expect(marketSourceSchema.safeParse(bad).success).toBe(false);
    expect(settingsSchema.safeParse({ marketDataSource: bad }).success).toBe(
      false,
    );
  }
});

it("defaults chart requests to unadjusted prices and accepts the three chart modes", () => {
  expect(
    chartBarsInput.parse({ snapshotId: "selected", period: "day" }).adjustment,
  ).toBe("none");
  expect(
    chartBarsInput.parse({
      snapshotId: "selected",
      period: "day",
      adjustment: "forward",
    }).adjustment,
  ).toBe("forward");
  expect(
    chartBarsInput.safeParse({
      snapshotId: "selected",
      period: "day",
      adjustment: "invalid",
    }).success,
  ).toBe(false);
});

it("blocks disabled MCP adapter and API calls before network, credential or task activity", async () => {
  const jobsBefore = jobSummaries();
  expect(await mcpConfigured()).toBe(false);
  await expect(queryMcp("tdx_quotes", {})).rejects.toThrow("暂时停用");
  await expect(mcpTools()).rejects.toThrow("暂时停用");
  await expect(importLocalMcp()).rejects.toThrow("暂时停用");
  const caller = integrationsRouter.createCaller({ headers: new Headers() });
  await expect(
    caller.mcpQuery({ name: "tdx_quotes", args: {} }),
  ).rejects.toThrow("暂时停用");
  await expect(caller.mcpTools()).rejects.toThrow("暂时停用");
  await expect(caller.importMcp()).rejects.toThrow("暂时停用");
  expect(fetch).not.toHaveBeenCalled();
  expect(deps.readSecret).not.toHaveBeenCalled();
  expect(deps.newJob).not.toHaveBeenCalled();
  expect(jobSummaries()).toEqual(jobsBefore);
});

it("requests the selected chart source through the rendered source selector", () => {
  type MarketProps = ComponentProps<typeof MarketView>;
  const mutate = vi.fn<MarketProps["state"]["load"]["mutate"]>();
  const setMarketSource = vi.fn();
  renderToStaticMarkup(
    createElement(MarketView, {
      embedded: true,
      notify: vi.fn(),
      state: {
        marketSource: "auto",
        marketView: "chart",
        setMarketView: vi.fn(),
        setMarketSource,
        symbol: source.symbol,
        setSymbol: vi.fn(),
        period: "day",
        loaded: null,
        load: {
          mutate,
          isPending: false,
          isRevalidating: false,
          error: null,
          acceptSnapshot: vi.fn(),
          acceptFrozenSnapshot: vi.fn(),
        },
        browse: null,
        setBrowse: vi.fn(),
        chartPeriod: "day",
        setChartPeriod: vi.fn(),
        chartMode: "k",
        setChartMode: vi.fn(),
        adjustment: "none",
        setAdjustment: vi.fn(),
      },
    }),
  );
  const sourceSelector = (
    deps.select.mock.calls as [ComponentProps<typeof Select>][]
  )
    .map(([props]) => props)
    .find(({ children }) => {
      // Read the accessible name from the select's rendered trigger.
      return renderToStaticMarkup(createElement(Select, { children })).includes(
        'aria-label="行情数据源"',
      );
    });
  expect(sourceSelector?.onValueChange).toBeTypeOf("function");
  for (const id of marketSourceSchema.options) {
    mutate.mockClear();
    setMarketSource.mockClear();
    sourceSelector?.onValueChange?.(id);
    expect(setMarketSource).toHaveBeenCalledExactlyOnceWith(id);
    expect(mutate).toHaveBeenCalledExactlyOnceWith({
      symbol: source.symbol,
      period: "day",
      source: id,
    });
  }
});

it("only activates one task history view when navigating to the task page", async () => {
  const entry = searchNav("/system/tasks").find(
    (item) => item.href === "/system/tasks",
  );
  expect(entry).toBeDefined();
  const renderShell = (children: ReactNode) =>
    renderToStaticMarkup(createElement(WorkbenchLayout, { children }));
  renderShell(null);
  expect(deps.taskHistory).not.toHaveBeenCalled();

  deps.location = new URL(entry!.href, deps.location);
  expect(navItemFor(deps.location.pathname, deps.location.search)?.href).toBe(
    entry!.href,
  );
  renderShell(await TasksPage());
  expect(deps.taskHistory).toHaveBeenCalledTimes(1);
});
