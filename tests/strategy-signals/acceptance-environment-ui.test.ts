import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { acceptanceEnvironment } from "../../src/lib/common/acceptance-environment";
import { connection } from "next/server";
const state = vi.hoisted(() => ({
  testEnvironment: undefined as string | undefined,
  loading: false,
  error: null as Error | null,
}));
vi.mock("~/components/workbench/use-task-visible", () => ({
  useScreenVisible: () => true,
}));
vi.mock("~/styles/globals.css", () => ({}));
vi.mock("next/server", () => ({ connection: vi.fn(async () => {}) }));
vi.mock("~/trpc/react", () => ({
  TRPCReactProvider: ({ children }: { children: React.ReactNode }) => children,
  api: {
    alertStatus: {
      useQuery: () => ({
        data: state.loading
          ? undefined
          : { mode: "shadow", runtime: null, gaps: [], ...state },
        error: state.error,
      }),
    },
  },
}));
vi.mock("~/components/workbench/workbench-layout", () => ({
  WorkbenchLayout: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("~/components/common/table-sort-provider", () => ({
  TableSortProvider: () => null,
}));
import { AlertStatus } from "../../src/components/signals/alert-status";
import RootLayout from "../../src/app/layout";
beforeEach(() => {
  vi.clearAllMocks();
  state.testEnvironment = undefined;
  state.loading = false;
  state.error = null;
  vi.stubEnv("E2E_FIXTURE_PROFILE", "");
});
afterEach(() => vi.unstubAllEnvs());
it("marks only explicit known acceptance profiles, never normal production", () => {
  for (const p of [undefined, "", "production", "unknown"])
    expect(acceptanceEnvironment(p)).toBeNull();
  for (const p of ["core", "pool", "workbench"])
    expect(acceptanceEnvironment(p)).toContain("合成测试数据");
});
it("leaves normal sidebar status unchanged without a test label", () => {
  expect(
    renderToStaticMarkup(createElement(AlertStatus, { compact: true })),
  ).not.toContain('role="note"');
});
it.each(["loading", "error", "success"])(
  "renders exactly one server environment notice while alerts are %s",
  async (status) => {
    vi.stubEnv("E2E_FIXTURE_PROFILE", "workbench");
    state.loading = status !== "success";
    state.error = status === "error" ? new Error("unavailable") : null;
    state.testEnvironment = acceptanceEnvironment("workbench")!;
    const html = renderToStaticMarkup(
      await RootLayout({
        children: createElement(AlertStatus, { compact: true }),
      }),
    );
    expect(html.match(/role="note"/g)).toHaveLength(1);
    expect(html).toContain("隔离验收环境");
    expect(html).toContain("非正式工作区");
    expect(connection).toHaveBeenCalledOnce();
    if (status === "error") expect(html).toContain("读取失败");
  },
);
it("omits the root notice in a normal runtime", async () => {
  const html = renderToStaticMarkup(
    await RootLayout({
      children: createElement(AlertStatus, { compact: true }),
    }),
  );
  expect(html).not.toContain('role="note"');
});
