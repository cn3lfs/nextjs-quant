import { expect, it } from "vitest";
import { stepBrowse } from "~/lib/market/browse-list";

it("steps through the list it was opened from without wrapping", () => {
  const list = {
    label: "选股候选",
    symbols: ["sh600519", "sz000001", "sz300750"],
    index: 1,
  };
  expect(stepBrowse(list, 1)).toEqual({ ...list, index: 2 });
  expect(stepBrowse(list, -1)).toEqual({ ...list, index: 0 });
  expect(stepBrowse({ ...list, index: 2 }, 1)).toBeNull();
  expect(stepBrowse({ ...list, index: 0 }, -1)).toBeNull();
});
