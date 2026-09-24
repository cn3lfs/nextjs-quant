import { describe, expect, it } from "vitest";
import {
  compareSortValues,
  parseSortValue,
  sortGroups,
} from "../../src/lib/common/table-sort";

describe("table display-value sorting", () => {
  it("parses broker-style numbers with units and signs", () => {
    expect(parseSortValue("1,234.5")).toEqual({ kind: "number", value: 1234.5 });
    expect(parseSortValue("+3.21%")).toEqual({ kind: "number", value: 3.21 });
    expect(parseSortValue("-0.5%")).toEqual({ kind: "number", value: -0.5 });
    expect(parseSortValue("12.3亿")).toEqual({ kind: "number", value: 1.23e9 });
    expect(parseSortValue("4.5万")).toEqual({ kind: "number", value: 45000 });
    expect(parseSortValue("¥88.00 元")).toEqual({ kind: "number", value: 88 });
    expect(parseSortValue("—")).toEqual({ kind: "empty" });
    expect(parseSortValue("")).toEqual({ kind: "empty" });
    expect(parseSortValue("2026-09-24")).toEqual({
      kind: "text",
      value: "2026-09-24",
    });
  });
  it("sorts numerically, keeps empties last in both directions, and is stable", () => {
    const rows = ["10", "—", "9", "1.5万", "9"];
    expect(sortGroups(rows, (v) => v, "asc")).toEqual([
      "9",
      "9",
      "10",
      "1.5万",
      "—",
    ]);
    expect(sortGroups(rows, (v) => v, "desc")).toEqual([
      "1.5万",
      "10",
      "9",
      "9",
      "—",
    ]);
  });
  it("orders Chinese text and dates as text", () => {
    expect(sortGroups(["2026-09-02", "2026-10-01", "2026-09-10"], (v) => v, "asc"))
      .toEqual(["2026-09-02", "2026-09-10", "2026-10-01"]);
    expect(
      compareSortValues(parseSortValue("1"), parseSortValue("甲"), "desc"),
    ).toBeLessThan(0);
  });
});
