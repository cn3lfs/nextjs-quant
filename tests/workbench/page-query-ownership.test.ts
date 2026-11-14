import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const rpc = vi.hoisted(() => ({
  search: "",
  queries: [] as { name: string; enabled: boolean; interval: unknown }[],
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace() {} }),
  useSearchParams: () => new URLSearchParams(rpc.search),
}));
vi.mock("~/components/workbench/use-task-visible", async () => {
  const { usePanelVisible } = await import("~/components/workbench/keep-alive");
  return { useTaskVisible: usePanelVisible };
});
vi.mock("~/components/workbench/use-now", () => ({
  useNow: () => Date.parse("2026-11-13T07:00:00Z"),
}));
vi.mock("~/components/market/use-quote-session", () => ({
  useQuoteRefreshInterval: () => 3000,
}));
vi.mock("~/trpc/react", () => ({
  api: new Proxy(
    {},
    {
      get: (_, name: string) => ({
        useQuery: (
          _input: unknown,
          options?: { enabled?: boolean; refetchInterval?: unknown },
        ) => {
          rpc.queries.push({
            name,
            enabled: options?.enabled !== false,
            interval: options?.refetchInterval,
          });
          return {
            data:
              name === "reportHistory"
                ? {
                    items: [
                      {
                        id: "report-fixture",
                        createdAt: 1,
                        securityContext: { symbol: "sh600000" },
                      },
                    ],
                  }
                : undefined,
          };
        },
      }),
    },
  ),
}));
import { TodayOverview } from "~/components/overview/today-overview";
import { LatestReport } from "~/components/research/latest-report";
import { PanelVisibility } from "~/components/workbench/keep-alive";
import { useSecurityNames } from "~/components/market/use-security-names";

beforeEach(() => {
  rpc.queries.length = 0;
  rpc.search = "";
});

it.each([true, false])(
  "page name directory follows visibility=%s",
  (visible) => {
    function Names() {
      useSecurityNames();
      return null;
    }
    renderToStaticMarkup(
      createElement(PanelVisibility, {
        visible,
        children: createElement(Names),
      }),
    );
    expect(rpc.queries).toEqual([
      {
        name: "securityNames",
        enabled: visible,
        interval: visible ? 300000 : false,
      },
    ]);
  },
);

it("hidden overview does not start any page query or quote refresh", () => {
  renderToStaticMarkup(
    createElement(PanelVisibility, {
      visible: false,
      children: createElement(TodayOverview),
    }),
  );
  expect(rpc.queries.length).toBeGreaterThan(5);
  expect(rpc.queries.filter((query) => query.enabled)).toEqual([]);
  expect(
    rpc.queries.filter((query) => typeof query.interval === "number"),
  ).toEqual([]);
});

it("hidden latest report does not read names, history or detail even with a loaded symbol", () => {
  renderToStaticMarkup(
    createElement(PanelVisibility, {
      visible: false,
      children: createElement(LatestReport, { symbol: "sh600000" }),
    }),
  );
  expect(rpc.queries.map((query) => query.name)).toEqual([
    "securityNames",
    "reportHistory",
    "archivedReport",
  ]);
  expect(rpc.queries.filter((query) => query.enabled)).toEqual([]);
});

it.each([
  ["", "industryRpsPage", "conceptRpsPage"],
  ["rank=concept", "conceptRpsPage", "industryRpsPage"],
])("overview reads ranking selection from %s", (search, active, inactive) => {
  rpc.search = search;
  renderToStaticMarkup(createElement(TodayOverview));
  expect(rpc.queries.find((query) => query.name === active)?.enabled).toBe(
    true,
  );
  expect(rpc.queries.find((query) => query.name === inactive)?.enabled).toBe(
    false,
  );
  for (const name of ["status", "securityNames", "monitorWorkspaceSummary"]) {
    const query = rpc.queries.find((query) => query.name === name);
    expect(query?.enabled).toBe(true);
    if (name === "status") expect(query?.interval).toBe(30000);
    else expect(query?.interval).toBeUndefined();
  }
});
