import { expect, it } from "vitest";
import {
  archiveReturnHref,
  archiveSearch,
  parseArchiveSearch,
} from "../../src/lib/research/workflow/archive-navigation";
it("round trips committed filters and constrains return destinations to reports", () => {
  const filter = {
    kinds: ["chan-report" as const],
    keyword: "中文 %_ &",
    symbol: "sh600519",
    from: "2026-09-28",
  };
  const query = archiveSearch(filter);
  expect(parseArchiveSearch(query)).toEqual(filter);
  expect(archiveReturnHref(`?archive=${encodeURIComponent(query)}`)).toBe(
    `/reports?${query}`,
  );
  expect(archiveReturnHref("?archive=https://evil.test/")).toBe("/reports");
  expect(parseArchiveSearch("kinds=unknown&from=2026-02-30")).toEqual({});
});
