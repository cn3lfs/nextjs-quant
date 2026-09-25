import { describe, expect, it } from "vitest";
import {
  nextTableSort,
  sortTableRows,
  sortingState,
  tableSortSchema,
} from "../../src/lib/common/server-sort";

const rows = [
  { name: "乙", value: 2 },
  { name: "甲", value: null },
  { name: "丙", value: 10 },
  { name: "丁", value: 2 },
];
const keys = {
  name: (r: (typeof rows)[number]) => r.name,
  value: (r: (typeof rows)[number]) => r.value,
};

describe("server-side table sort", () => {
  it("sorts numbers, keeps missing values last and ties stable", () => {
    expect(
      sortTableRows(rows, { id: "value", desc: false }, keys).map((r) => r.name),
    ).toEqual(["乙", "丁", "丙", "甲"]);
    expect(
      sortTableRows(rows, { id: "value", desc: true }, keys).map((r) => r.name),
    ).toEqual(["丙", "乙", "丁", "甲"]);
  });
  it("keeps the default order for no sort or an unknown column", () => {
    expect(sortTableRows(rows, null, keys)).toEqual(rows);
    expect(sortTableRows(rows, { id: "nope", desc: true }, keys)).toEqual(rows);
  });
  it("defaults to null and round-trips TanStack sorting state", () => {
    expect(tableSortSchema.parse(undefined)).toBeNull();
    const sort = { id: "value", desc: true };
    expect(sortingState(sort)).toEqual([sort]);
    expect(nextTableSort(() => [{ id: "name", desc: false }], sort)).toEqual({
      id: "name",
      desc: false,
    });
    expect(nextTableSort([], sort)).toBeNull();
  });
});
