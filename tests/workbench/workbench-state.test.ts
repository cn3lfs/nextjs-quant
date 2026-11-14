import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const rpc = vi.hoisted(() => ({
  visible: true,
  queries: [] as { name: string; input: unknown; enabled: boolean }[],
  mutations: [] as string[],
}));
vi.mock("~/components/workbench/use-task-visible", () => ({
  useTaskVisible: () => rpc.visible,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/backtest",
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("~/components/market/use-snapshot-load", () => ({
  useSnapshotLoad: () => ({ mutate: vi.fn() }),
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
                rpc.queries.push({
                  name,
                  input,
                  enabled: options?.enabled !== false,
                });
                return {
                  data:
                    name === "jobs"
                      ? [
                          {
                            id: "retired-backtest",
                            type: "backtest",
                            status: "completed",
                          },
                          {
                            id: "retired-screen",
                            type: "screen",
                            status: "completed",
                            isFormulaScreen: false,
                          },
                          {
                            id: "formula-result",
                            isFormulaScreen: true,
                            type: "screen",
                            status: "completed",
                          },
                        ]
                      : undefined,
                };
              },
              useMutation: () => {
                rpc.mutations.push(name);
                return { mutate: vi.fn() };
              },
            },
    },
  ),
}));
import { useWorkbenchState } from "~/components/workbench/use-workbench-state";
import { useScreenResults } from "~/components/screening/use-screen-results";

beforeEach(() => {
  rpc.queries.length = 0;
  rpc.mutations.length = 0;
  rpc.visible = true;
});

it.each([true, false])(
  "screening owns result loading and honors visibility=%s",
  (visible) => {
    rpc.visible = visible;
    function Probe() {
      const state = useScreenResults(() => {});
      return createElement("output", null, state.screenJob?.id);
    }
    expect(renderToStaticMarkup(createElement(Probe))).toContain(
      "formula-result",
    );
    expect(rpc.queries).toContainEqual(
      expect.objectContaining({ name: "jobs", enabled: visible }),
    );
    expect(rpc.queries).toContainEqual(
      expect.objectContaining({
        name: "screenResults",
        enabled: visible,
        input: expect.objectContaining({ id: "formula-result" }),
      }),
    );
    expect(rpc.queries.filter((query) => query.enabled)).not.toContainEqual(
      expect.objectContaining({
        input: expect.objectContaining({
          id: expect.stringMatching(/^retired-/),
        }),
      }),
    );
  },
);

it("does not register screening result queries from the shared shell", () => {
  function Probe() {
    const state = useWorkbenchState();
    return createElement("output", null, state.tab);
  }
  renderToStaticMarkup(createElement(Probe));
  for (const removed of ["backtest", "screen", "interpret"])
    expect(rpc.mutations).not.toContain(removed);
  expect(rpc.queries.filter((query) => query.enabled)).not.toContainEqual(
    expect.objectContaining({
      input: expect.objectContaining({
        id: expect.stringMatching(/^retired-/),
      }),
    }),
  );
  expect(rpc.queries.map((query) => query.name)).not.toContain("screenResults");
  expect(rpc.queries.map((query) => query.name)).not.toContain("jobSummary");
  for (const query of [
    "channels",
    "signalWorkspacePage",
    "securityNames",
    "jobs",
    "taskOverview",
    "monitorWorkspaceSummary",
  ])
    expect(rpc.queries.map((query) => query.name)).not.toContain(query);
  for (const mutation of ["analyze", "scan", "cancel"])
    expect(rpc.mutations).not.toContain(mutation);
  expect(rpc.mutations).not.toContain("watchlist");
  expect(rpc.queries.find((query) => query.name === "status")?.enabled).toBe(
    false,
  );
});
