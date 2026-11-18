import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("~/components/screening/formula-screen", () => ({
  FormulaScreen: () => createElement("section", null, "current-formula-editor"),
}));
vi.mock("~/components/research/factor-evaluation-panel", () => ({
  FactorEvaluationPanel: () =>
    createElement("section", null, "current-factor-evaluation"),
}));
vi.mock("~/components/screening/screen-task-progress", () => ({
  ScreenTaskProgress: () => null,
}));
import { ScreenView } from "~/components/workbench/screen-view";

it("shows current formula/factor workflows without old condition editors or automatic-analysis promises", () => {
  const state = {
    names: {},
    jobs: { data: [] },
    screened: {},
    reviews: {},
    screenReport: {},
    screenPage: 0,
    excludedPage: 0,
    errorPage: 0,
    screenQuery: "",
    screenSort: "original",
    screenDirection: "desc",
  } as unknown as Parameters<typeof ScreenView>[0]["state"];
  const html = renderToStaticMarkup(createElement(ScreenView, { state }));
  expect(html).toContain("current-formula-editor");
  expect(html).toContain("单因子评估");
  expect(html).not.toContain("本地条件草案");
  expect(html).not.toContain("本地可复现条件");
  expect(html).not.toContain("生成条件草案");
  expect(html).not.toContain("默认自动进行 AI");
  expect(html).toContain("不会自动生成分析、通知或交易");
});

it("keeps frozen candidate stepping disabled until the URL names a candidate", () => {
  nav.search = "tab=formula&job=job-1&screenJob=job-1";
  const state = {
    names: {},
    jobs: { data: [] },
    utils: { savedSnapshot: { fetch: vi.fn() } },
    screened: {
      isFetching: false,
      isPlaceholderData: false,
      isError: false,
      error: null as Error | null,
      refetch: vi.fn(),
    },
    screenJob: { id: "job-1", status: "completed" },
    screenId: "job-1",
    selectedScreen: {},
    firstScreenPage: null,
    screenResult: {
      candidates: [
        {
          symbol: "sh600000",
          name: "甲",
          snapshotId: "s1",
          metrics: {
            close: 10,
            change: 1,
            fast: 9,
            slow: 8,
            volumeRatio: 1,
            matched: true,
            date: "2026-11-17",
            score: 1,
          },
        },
      ],
      count: 1,
      candidateTotal: 1,
      total: 1,
      excludedTotal: 0,
      errorTotal: 0,
      excluded: [],
      errors: [],
      researchWarnings: [],
      asOf: "2026-11-17",
    },
    screenPage: 0,
    excludedPage: 0,
    errorPage: 0,
    screenQuery: "",
    screenSort: "original",
    screenDirection: "desc",
    setScreenPage: vi.fn(),
    setExcludedPage: vi.fn(),
    setErrorPage: vi.fn(),
    setScreenQuery: vi.fn(),
    setScreenSort: vi.fn(),
    setScreenDirection: vi.fn(),
    exportingScreen: false,
    exportScreen: vi.fn(),
    selectFormulaJob: vi.fn(),
  } as unknown as Parameters<typeof ScreenView>[0]["state"];
  const html = renderToStaticMarkup(createElement(ScreenView, { state }));
  expect(html).toContain("本页 —/1");
  // Re-opening a row of the confirmed page remains allowed.
  const row = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(([value]) => value)
    .find((value) => value.includes("个股研究"));
  expect(row).toBeDefined();
  expect(row!).not.toContain('disabled=""');
});

function monitorState() {
  const candidates = Array.from({ length: 25 }, (_, index) => ({
    symbol: `sh${String(600000 + index)}`,
    name: `候选${index}`,
    snapshotId: `snapshot-${index}`,
    metrics: {
      close: 10,
      change: 1,
      fast: 9,
      slow: 8,
      volumeRatio: 1,
      matched: true,
      date: "2026-11-17",
      score: 1,
    },
  }));
  return {
    names: {},
    jobs: { data: [] },
    utils: { savedSnapshot: { fetch: vi.fn() } },
    screened: {
      isFetching: false,
      isPlaceholderData: false,
      isError: false,
      error: null as Error | null,
      refetch: vi.fn(),
    },
    screenJob: { id: "job-1", status: "completed" },
    screenId: "job-1",
    selectedScreen: { isFetching: false, isError: false },
    firstScreenPage: null as unknown,
    screenResult: {
      candidates,
      count: 25,
      candidateTotal: 40,
      total: 40,
      excludedTotal: 0,
      errorTotal: 0,
      excluded: [],
      errors: [],
      researchWarnings: [],
      asOf: "2026-11-17",
    },
    screenPage: 0,
    excludedPage: 0,
    errorPage: 0,
    screenQuery: "",
    screenSort: "original",
    screenDirection: "desc",
    setScreenPage: vi.fn(),
    setExcludedPage: vi.fn(),
    setErrorPage: vi.fn(),
    setScreenQuery: vi.fn(),
    setScreenSort: vi.fn(),
    setScreenDirection: vi.fn(),
    exportingScreen: false,
    exportScreen: vi.fn(),
    selectFormulaJob: vi.fn(),
  };
}

function monitorTrigger(html: string) {
  return [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(([value]) => value)
    .find((value) => value.includes("查看监控名单"));
}

it("exposes a monitor list preview entry instead of an immediate redirect", () => {
  nav.search = "tab=formula&job=job-1";
  const state = monitorState();
  const html = renderToStaticMarkup(
    createElement(ScreenView, {
      state: state as unknown as Parameters<typeof ScreenView>[0]["state"],
    }),
  );
  expect(html).toContain("查看监控名单");
  expect(html).not.toContain("只加入监控");
  expect(monitorTrigger(html)).toBeDefined();
  expect(monitorTrigger(html)!).not.toContain('disabled=""');
});

it("disables the monitor entry while the page query is not confirmed", () => {
  nav.search = "tab=formula&job=job-1";
  const render = (change: (state: ReturnType<typeof monitorState>) => void) => {
    const state = monitorState();
    change(state);
    const html = renderToStaticMarkup(
      createElement(ScreenView, {
        state: state as unknown as Parameters<typeof ScreenView>[0]["state"],
      }),
    );
    return monitorTrigger(html);
  };
  expect(render((state) => (state.screened.isFetching = true))!).toContain(
    'disabled=""',
  );
  expect(
    render((state) => (state.screened.isPlaceholderData = true))!,
  ).toContain('disabled=""');
  expect(
    render((state) => {
      state.screened.isError = true;
      state.screened.error = new Error("读取失败");
    })!,
  ).toContain('disabled=""');
  // The first page is served by jobSummary, so its own state must block too.
  expect(
    render((state) => {
      state.firstScreenPage = state.screenResult;
      state.selectedScreen.isFetching = true;
    }),
  ).toContain('disabled=""');
  expect(
    render((state) => {
      state.firstScreenPage = state.screenResult;
      state.selectedScreen.isError = true;
    }),
  ).toContain('disabled=""');
  expect(
    render((state) => {
      state.firstScreenPage = state.screenResult;
    }),
  ).not.toContain('disabled=""');
});
