import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  DataTable,
  type DataTableProps,
} from "../src/components/ui/data-table";

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
