import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import {
  ReviewDiagnostics,
  groupNavDiagnostics,
} from "../src/components/trade-review-diagnostics";
it("R13 groups repeated dated causes while keeping exact evidence untouched and details unmounted", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    date: `2025-01-${String((i % 28) + 1).padStart(2, "0")}`,
    reason: `期初净值非正（${-i}），收益率无定义`,
  }));
  const before = JSON.stringify(rows);
  expect(groupNavDiagnostics(rows)).toEqual([
    "期初净值非正，收益率无定义：28 天 / 100 条（2025-01-01 至 2025-01-28）",
  ]);
  const html = renderToStaticMarkup(createElement(ReviewDiagnostics, { rows }));
  expect(html).toContain("共 100 条，1 类原因");
  expect(html).toContain('aria-expanded="false"');
  expect(html).not.toContain("期初净值非正（-99）");
  expect(JSON.stringify(rows)).toBe(before);
});
