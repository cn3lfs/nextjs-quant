import { expect, it } from "vitest";
import { chanAnchorDateCodes } from "../../../../src/lib/research/methods/chan/czsc-movements";

it("monthly anchor is independent, with calendar-complete input owned by monthly adapter", () => {
  expect(
    chanAnchorDateCodes(["2019-12-31", "2020-01-31", "2020-02-28"], 3),
  ).toEqual([191231, 200131, 200228]);
  expect(() => chanAnchorDateCodes(["2020-01-02", "2020-01-03"], 3)).toThrow(
    "月份",
  );
  expect(() => chanAnchorDateCodes(["2020-02-30"], 3)).toThrow();
  expect(() => chanAnchorDateCodes(["2020-02-28", "2020-01-31"], 3)).toThrow();
  expect(() => chanAnchorDateCodes(["2020-01-02T09:35:00+08:00"], 3)).toThrow();
  expect(() => chanAnchorDateCodes(["2023-01-03T09:35:00+08:00"], 2)).toThrow(
    "窗口",
  );
});
