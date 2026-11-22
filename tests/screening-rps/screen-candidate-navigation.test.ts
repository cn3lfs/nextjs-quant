import { expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Candidate, Snapshot } from "~/lib/domain";

const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(nav.search),
}));
vi.mock("~/components/screening/formula-screen", () => ({
  FormulaScreen: () => null,
}));
vi.mock("~/components/research/factor-evaluation-panel", () => ({
  FactorEvaluationPanel: () => null,
}));
vi.mock("~/components/screening/screen-task-progress", () => ({
  ScreenTaskProgress: () => null,
}));

import { PanelVisibility } from "~/components/workbench/keep-alive";
import { ScreenView } from "~/components/workbench/screen-view";
import {
  currentScreenCandidateIndex,
  openScreenCandidate,
  screenCandidateHref,
} from "~/lib/screening/screen-candidate-navigation";

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    id: "s1",
    symbol: "sh600000",
    period: "day",
    source: "tdx-local",
    adjustment: "forward",
    createdAt: 1,
    bars: [],
    hash: "fixture",
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const candidates: Candidate[] = [
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
  {
    symbol: "sh600001",
    name: "乙",
    snapshotId: "s2",
    metrics: {
      close: 11,
      change: 2,
      fast: 10,
      slow: 9,
      volumeRatio: 2,
      matched: true,
      date: "2026-11-17",
      score: 2,
    },
  },
  {
    symbol: "sh600002",
    name: "丙",
    snapshotId: "s3",
    metrics: {
      close: 12,
      change: 3,
      fast: 11,
      slow: 10,
      volumeRatio: 3,
      matched: true,
      date: "2026-11-17",
      score: 3,
    },
  },
];

it("locates the URL candidate only by symbol and snapshot together", () => {
  const rows = candidates.map(({ symbol, snapshotId }) => ({
    symbol,
    snapshotId,
  }));
  expect(
    currentScreenCandidateIndex(rows, {
      symbol: "sh600001",
      snapshotId: "s2",
    }),
  ).toBe(1);
  // Same symbol with another frozen snapshot belongs to a different candidate.
  expect(
    currentScreenCandidateIndex(rows, {
      symbol: "sh600001",
      snapshotId: "s1",
    }),
  ).toBe(-1);
  expect(
    currentScreenCandidateIndex(rows, { symbol: null, snapshotId: "s2" }),
  ).toBe(-1);
  expect(
    currentScreenCandidateIndex(rows, { symbol: "sh600001", snapshotId: null }),
  ).toBe(-1);
});

it("builds the exact frozen URL and refuses a mismatched snapshot", () => {
  expect(
    screenCandidateHref(
      { symbol: "sh600000", snapshotId: "s1" },
      "job-1",
      snapshot({ adjustment: "forward" }),
    ),
  ).toBe(
    "/scan?tab=formula&job=job-1&symbol=sh600000&screenSnapshot=s1&screenJob=job-1&adjustment=forward",
  );
  expect(
    screenCandidateHref(
      { symbol: "sh600000", snapshotId: "s1" },
      "job-1",
      snapshot({ symbol: "sh600001" }),
    ),
  ).toBeNull();
  expect(
    screenCandidateHref(
      { symbol: "sh600000", snapshotId: "s1" },
      "job-1",
      snapshot({ id: "s2" }),
    ),
  ).toBeNull();
});

it("restores the same task from both job and screenJob", () => {
  const href = screenCandidateHref(
    { symbol: "sh600000", snapshotId: "s1" },
    "job-1",
    snapshot(),
  )!;
  const params = new URL(href, "http://fixture").searchParams;
  // ScreenRouteSelection reads `job`; prepareScreenPlan reads `screenJob`.
  expect(params.get("job")).toBe("job-1");
  expect(params.get("screenJob")).toBe("job-1");
});

it("navigates only after a matching snapshot for the current confirmed page", async () => {
  const navigations: string[] = [];
  const outcome = await openScreenCandidate({
    candidate: { symbol: "sh600001", snapshotId: "s2" },
    jobId: "job-1",
    pageKey: "page-1",
    fetchSnapshot: () =>
      Promise.resolve(snapshot({ id: "s2", symbol: "sh600001" })),
    readPageKey: () => "page-1",
    containsCandidate: () => true,
    isLatest: () => true,
    navigate: (href) => navigations.push(href),
  });
  expect(outcome).toEqual({ status: "opened" });
  expect(navigations).toEqual([
    "/scan?tab=formula&job=job-1&symbol=sh600001&screenSnapshot=s2&screenJob=job-1&adjustment=forward",
  ]);
});

it("keeps the chart and URL when the snapshot cannot be read", async () => {
  const navigations: string[] = [];
  const outcome = await openScreenCandidate({
    candidate: { symbol: "sh600001", snapshotId: "s2" },
    jobId: "job-1",
    pageKey: "page-1",
    fetchSnapshot: () =>
      Promise.reject(new Error("候选原始快照不存在，请重新运行选股")),
    readPageKey: () => "page-1",
    containsCandidate: () => true,
    isLatest: () => true,
    navigate: (href) => navigations.push(href),
  });
  expect(outcome).toEqual({
    status: "failed",
    message: "候选原始快照不存在，请重新运行选股",
  });
  expect(navigations).toEqual([]);
});

it("never reads a snapshot after the page identity was lost", async () => {
  const fetchSnapshot = vi.fn();
  const outcome = await openScreenCandidate({
    candidate: { symbol: "sh600001", snapshotId: "s2" },
    jobId: "job-1",
    pageKey: "page-1",
    fetchSnapshot,
    readPageKey: () => "page-2",
    containsCandidate: () => true,
    isLatest: () => true,
    navigate: vi.fn(),
  });
  expect(outcome).toEqual({ status: "ignored" });
  expect(fetchSnapshot).not.toHaveBeenCalled();
});

it("silences a failure that arrives after leaving the page", async () => {
  const pending = deferred<Snapshot>();
  let owns = true;
  const outcomePromise = openScreenCandidate({
    candidate: { symbol: "sh600001", snapshotId: "s2" },
    jobId: "job-1",
    pageKey: "page-1",
    fetchSnapshot: () => pending.promise,
    readPageKey: () => "page-1",
    containsCandidate: () => owns,
    isLatest: () => owns,
    navigate: vi.fn(),
  });
  owns = false;
  pending.reject(new Error("候选原始快照不存在，请重新运行选股"));
  expect(await outcomePromise).toEqual({ status: "ignored" });
});

it("does not replace the chart with the wrong security", async () => {
  const navigations: string[] = [];
  const outcome = await openScreenCandidate({
    candidate: { symbol: "sh600001", snapshotId: "s2" },
    jobId: "job-1",
    pageKey: "page-1",
    fetchSnapshot: () =>
      Promise.resolve(snapshot({ id: "s2", symbol: "sh600009" })),
    readPageKey: () => "page-1",
    containsCandidate: () => true,
    isLatest: () => true,
    navigate: (href) => navigations.push(href),
  });
  expect(outcome).toEqual({
    status: "invalid",
    message: "候选快照与所选证券不一致，未替换当前图表",
  });
  expect(navigations).toEqual([]);
});

it("ignores a late response after a newer selection", async () => {
  const first = deferred<Snapshot>();
  const second = deferred<Snapshot>();
  const navigations: string[] = [];
  let latest = 1;
  const base = {
    jobId: "job-1",
    pageKey: "page-1",
    readPageKey: () => "page-1",
    containsCandidate: () => true,
  };
  const stale = openScreenCandidate({
    ...base,
    candidate: { symbol: "sh600000", snapshotId: "s1" },
    fetchSnapshot: () => first.promise,
    isLatest: () => latest === 1,
    navigate: (href) => navigations.push(href),
  });
  latest = 2;
  const current = openScreenCandidate({
    ...base,
    candidate: { symbol: "sh600001", snapshotId: "s2" },
    fetchSnapshot: () => second.promise,
    isLatest: () => latest === 2,
    navigate: (href) => navigations.push(href),
  });
  first.resolve(snapshot());
  expect(await stale).toEqual({ status: "ignored" });
  expect(navigations).toEqual([]);
  second.resolve(snapshot({ id: "s2", symbol: "sh600001" }));
  expect(await current).toEqual({ status: "opened" });
  expect(navigations).toEqual([
    "/scan?tab=formula&job=job-1&symbol=sh600001&screenSnapshot=s2&screenJob=job-1&adjustment=forward",
  ]);
});

it("drops a response after the query or confirmed page changed", async () => {
  const read = deferred<Snapshot>();
  const navigations: string[] = [];
  let pageKey = "page-1";
  const outcome = openScreenCandidate({
    candidate: { symbol: "sh600000", snapshotId: "s1" },
    jobId: "job-1",
    pageKey,
    fetchSnapshot: () => read.promise,
    readPageKey: () => pageKey,
    containsCandidate: () => true,
    isLatest: () => true,
    navigate: (href) => navigations.push(href),
  });
  pageKey = "page-2";
  read.resolve(snapshot());
  expect(await outcome).toEqual({ status: "ignored" });
  expect(navigations).toEqual([]);
});

it("never navigates when the candidate left the confirmed page", async () => {
  const navigations: string[] = [];
  const outcome = await openScreenCandidate({
    candidate: { symbol: "sh600000", snapshotId: "s1" },
    jobId: "job-1",
    pageKey: "page-1",
    fetchSnapshot: () => Promise.resolve(snapshot()),
    readPageKey: () => "page-1",
    containsCandidate: () => false,
    isLatest: () => true,
    navigate: (href) => navigations.push(href),
  });
  expect(outcome).toEqual({ status: "ignored" });
  expect(navigations).toEqual([]);
});

function renderState(overrides: { fetching?: boolean; error?: boolean } = {}) {
  return {
    names: {},
    utils: { savedSnapshot: { fetch: vi.fn() } },
    screened: {
      isFetching: overrides.fetching ?? false,
      isPlaceholderData: false,
      isError: overrides.error ?? false,
      error: overrides.error ? new Error("候选读取失败") : null,
      refetch: vi.fn(),
    },
    screenJob: { id: "job-1", status: "completed" },
    screenId: "",
    selectedScreen: {},
    firstScreenPage: null,
    screenResult: {
      candidates,
      count: candidates.length,
      candidateTotal: candidates.length,
      total: candidates.length,
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
}

function render(search: string, overrides = {}, hidden = false) {
  nav.search = search;
  const view = createElement(ScreenView, { state: renderState(overrides) });
  return renderToStaticMarkup(
    hidden
      ? createElement(PanelVisibility, { visible: false, children: view })
      : view,
  );
}

function buttonWith(html: string, label: string) {
  const found = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)]
    .map(([value]) => value)
    .find((value) => value.includes(label));
  expect(found, `button ${label}`).toBeDefined();
  return found!;
}

it("shows the current position and enables both neighbours in the middle", () => {
  const html = render(
    "tab=formula&symbol=sh600001&screenSnapshot=s2&screenJob=job-1",
  );
  expect(html).toContain("本页 2/3");
  expect(buttonWith(html, "上一只")).not.toContain('disabled=""');
  expect(buttonWith(html, "下一只")).not.toContain('disabled=""');
});

it("disables the edge buttons without wrapping", () => {
  const first = render(
    "tab=formula&symbol=sh600000&screenSnapshot=s1&screenJob=job-1",
  );
  expect(first).toContain("本页 1/3");
  expect(buttonWith(first, "上一只")).toContain('disabled=""');
  expect(buttonWith(first, "下一只")).not.toContain('disabled=""');

  const last = render(
    "tab=formula&symbol=sh600002&screenSnapshot=s3&screenJob=job-1",
  );
  expect(last).toContain("本页 3/3");
  expect(buttonWith(last, "上一只")).not.toContain('disabled=""');
  expect(buttonWith(last, "下一只")).toContain('disabled=""');
});

it("disables navigation when the URL target is not on the confirmed page", () => {
  const html = render(
    "tab=formula&symbol=sh600001&screenSnapshot=s1&screenJob=job-1",
  );
  expect(html).toContain("本页 —/3");
  expect(buttonWith(html, "上一只")).toContain('disabled=""');
  expect(buttonWith(html, "下一只")).toContain('disabled=""');
});

it.each([
  ["fetching", { fetching: true }],
  ["failed", { error: true }],
])(
  "does not use placeholder rows while the page is %s",
  (_label, overrides) => {
    const html = render(
      "tab=formula&symbol=sh600001&screenSnapshot=s2&screenJob=job-1",
      overrides,
    );
    expect(html).toContain("本页 —/—");
    expect(buttonWith(html, "上一只")).toContain('disabled=""');
    expect(buttonWith(html, "下一只")).toContain('disabled=""');
  },
);

it("keeps the row opener available on a confirmed page", () => {
  const html = render(
    "tab=formula&symbol=sh600001&screenSnapshot=s2&screenJob=job-1",
  );
  expect(buttonWith(html, "个股研究")).not.toContain('disabled=""');
});

it("does not step another task's frozen candidate", () => {
  const html = render(
    "tab=formula&symbol=sh600001&screenSnapshot=s2&screenJob=job-2",
  );
  expect(html).toContain("本页 —/3");
  expect(buttonWith(html, "上一只")).toContain('disabled=""');
  expect(buttonWith(html, "下一只")).toContain('disabled=""');
  // Re-opening a row of the confirmed page is still allowed.
  expect(buttonWith(html, "个股研究")).not.toContain('disabled=""');
});

it("discards the page while the formula panel is hidden", () => {
  const html = render(
    "tab=formula&symbol=sh600001&screenSnapshot=s2&screenJob=job-1",
    {},
    true,
  );
  expect(html).toContain("本页 —/—");
  expect(buttonWith(html, "上一只")).toContain('disabled=""');
  expect(buttonWith(html, "下一只")).toContain('disabled=""');
});
