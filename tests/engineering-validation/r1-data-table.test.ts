import { createElement, useLayoutEffect, useRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useAccumulatedPages } from "../../src/components/ui/use-infinite-table";
import {
  DataTable,
  type DataTableProps,
} from "../../src/components/ui/data-table";

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useRef: vi.fn(react.useRef),
    useLayoutEffect: vi.fn(react.useLayoutEffect),
  };
});

type Row = { id: string; value: number };
const rows = [
  { id: "server-first", value: 90 },
  { id: "server-second", value: 10 },
];
const props: DataTableProps<Row> = {
  data: rows,
  columns: [
    { accessorKey: "id", header: "ID" },
    { accessorKey: "value", header: "Value" },
  ],
  rowCount: 42,
  pagination: { pageIndex: 3, pageSize: 2 },
  sorting: [{ id: "value", desc: false }],
  getRowId: (row) => row.id,
  onPaginationChange: () => {},
  onSortingChange: () => {},
  label: "Server results",
};
const render = (overrides: Partial<DataTableProps<Row>> = {}) =>
  renderToStaticMarkup(
    createElement(DataTable<Row>, { ...props, ...overrides }),
  );

describe("R1 server-owned DataTable", () => {
  it("associates keyboard sorting help with sortable tables only", () => {
    const markup = render();
    const id = /aria-describedby="([^"]+)"/.exec(markup)?.[1];
    expect(id).toBeDefined();
    expect(markup).toContain(`id="${id}"`);
    expect(markup).toContain("按 Enter 或空格切换排序方向");
    const unsortable = render({
      columns: [{ id: "plain", header: "说明", enableSorting: false }],
    });
    expect(unsortable).not.toContain("aria-describedby");
    expect(unsortable).not.toContain("按 Enter");
  });
  it("R2 can retain the existing external pager and empty-state text without changing row order", () => {
    const markup = render({ showPagination: false, emptyMessage: null });
    expect(markup).not.toContain("下一页");
    expect(markup.indexOf("server-first")).toBeLessThan(
      markup.indexOf("server-second"),
    );
    const empty = render({
      showPagination: false,
      emptyMessage: null,
      data: [],
    });
    expect(empty).not.toContain("暂无数据");
    expect(empty).toContain('<tbody data-slot="table-body"');
  });
  it("preserves server order despite conflicting sorting state and never slices the supplied page again", () => {
    const markup = render();
    expect(markup.indexOf("server-first")).toBeLessThan(
      markup.indexOf("server-second"),
    );
    expect(markup).toContain("server-first");
    expect(markup).toContain("server-second");
    expect(markup).toContain('aria-sort="ascending"');
    expect(markup).toContain("共 42 条 · 第 4 / 21 页");
    expect(rows.map((row) => row.value)).toEqual([90, 10]);
  });
  it("uses the server total rather than the page length to enable the next page", () => {
    expect(render()).not.toMatch(/disabled=""[^>]*>下一页/);
    expect(render({ rowCount: 8 })).toMatch(/disabled=""[^>]*>下一页/);
  });
  it("distinguishes empty, pending and failed responses and hides stale rows", () => {
    expect(
      render({
        data: [],
        rowCount: 0,
        pagination: { pageIndex: 0, pageSize: 2 },
      }),
    ).toContain("暂无数据。");
    const pending = render({ loading: true });
    expect(pending).toContain('aria-busy="true"');
    expect(pending).toContain("正在加载…");
    expect(pending).not.toContain("server-first");
    const failed = render({ error: "请求失败", onRetry: () => {} });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("请求失败");
    expect(failed).toContain("重试");
    expect(failed).not.toContain("server-first");
  });
});

describe("infinite-scroll DataTable", () => {
  const onLoadMore = () => {};
  it("keeps accumulated rows visible and disables load more while fetching another page", () => {
    const markup = render({
      loading: true,
      infiniteScroll: { hasMore: true, loadingMore: true, onLoadMore },
    });
    expect(markup).toContain("server-first");
    expect(markup).toContain("server-second");
    expect(markup).not.toContain("正在加载…");
    expect(markup).toMatch(/disabled=""[^>]*>加载中…/);
    expect(
      render({
        data: [],
        loading: true,
        infiniteScroll: { hasMore: false, onLoadMore },
      }),
    ).toContain("正在加载…");
  });
  it("reports the loaded count and exposes a manual fallback without a pager", () => {
    const markup = render({ infiniteScroll: { hasMore: true, onLoadMore } });
    expect(markup).toContain("已加载 2 / 共 42 条");
    expect(markup).toContain(">加载更多</button>");
    expect(markup).not.toContain("上一页");
    expect(markup).not.toContain("下一页");
  });
  it("keeps the global count when a restored deep link reaches the end", () => {
    const markup = render({
      infiniteScroll: { hasMore: false, startOffset: 40, onLoadMore },
    });
    expect(markup).toContain("已加载 2 / 共 42 条");
    expect(markup).toContain("从第 41 条起");
    expect(markup).not.toContain("已全部加载");
  });
  it("reports completion and removes the fallback after the final batch", () => {
    const markup = render({
      rowCount: 2,
      infiniteScroll: { hasMore: false, onLoadMore },
    });
    expect(markup).toContain("已全部加载 · 共 2 条");
    expect(markup).not.toContain("加载更多");
  });
});

describe("useAccumulatedPages", () => {
  // Static rendering supplies React's render phase. Carry the ref between
  // renders and run the layout effect afterwards to simulate the commit.
  function mountPages() {
    const onSnapshotDrift = vi.fn();
    let ref: { current: unknown } | undefined;
    function renderPage(
      pageIndex: number,
      items: string[],
      total: number,
      snapshotKey?: string | number | null,
      isSuccess = true,
    ) {
      let commit: (() => void) | undefined;
      let result!: ReturnType<typeof useAccumulatedPages<string, string>>;
      function Probe() {
        result = useAccumulatedPages({
          resetKey: "feed",
          pageIndex,
          items,
          total,
          snapshotKey,
          isSuccess,
          getKey: (key) => key,
          metadata: items[0],
          pageSize: 2,
          onSnapshotDrift,
        });
        return null;
      }
      vi.mocked(useRef).mockImplementationOnce(
        (initial) => (ref ??= { current: initial }),
      );
      vi.mocked(useLayoutEffect).mockImplementationOnce((effect) => {
        commit = effect;
      });
      renderToStaticMarkup(createElement(Probe));
      commit?.();
      return result;
    }
    return { renderPage, onSnapshotDrift };
  }

  it.each([
    ["new RPS batch with unchanged total", "batch-A", "batch-B", 4],
    ["insert at offset zero", 4, 5, 5],
    ["changed total within a named batch", "batch-A", "batch-A", 5],
  ] as const)(
    "rejects %s and pins the fresh first page",
    (_, before, after, total) => {
      const { renderPage, onSnapshotDrift } = mountPages();
      renderPage(0, ["a", "b"], 4, before);
      expect(renderPage(1, ["b", "c"], total, after, false).rows).toEqual([
        "a",
        "b",
      ]);
      expect(onSnapshotDrift).not.toHaveBeenCalled();
      expect(renderPage(1, ["b", "c"], total, after)).toMatchObject({
        rows: [],
        total: 0,
        metadata: undefined,
      });
      renderPage(1, ["b", "c"], total, after);
      expect(onSnapshotDrift).toHaveBeenCalledTimes(1);
      renderPage(0, ["new", "a"], total, after);
      expect(renderPage(1, ["b", "c"], total, after).rows).toEqual([
        "new",
        "a",
        "b",
        "c",
      ]);
      expect(onSnapshotDrift).toHaveBeenCalledTimes(1);
    },
  );

  it("deduplicates full overlapping pages and stops on a short final page", () => {
    const { renderPage } = mountPages();
    renderPage(0, ["a", "b"], 4);
    expect(renderPage(1, ["b", "c"], 4)).toMatchObject({
      rows: ["a", "b", "c"],
      hasMore: true,
    });
    expect(renderPage(2, ["d"], 4)).toMatchObject({
      rows: ["a", "b", "c", "d"],
      hasMore: false,
    });
    expect(renderPage(0, ["a"], 4)).toMatchObject({
      rows: ["a"],
      hasMore: false,
    });
  });

  it("restarts a keyed feed if a short tail cannot account for its pinned total", () => {
    const { renderPage, onSnapshotDrift } = mountPages();
    renderPage(0, ["a", "b"], 4, 4);
    expect(renderPage(1, ["b", "c"], 4, 4).hasMore).toBe(true);
    expect(renderPage(2, [], 4, 4)).toMatchObject({ rows: [], hasMore: true });
    expect(onSnapshotDrift).toHaveBeenCalledTimes(1);
  });
});
