import { expect, it } from "vitest";
import { sortWatchSymbols } from "~/components/overview/watch-sort";

const saved = ["a", "b", "c", "d", "e", "f"];
const changes: Record<string, number | null> = {
  a: 1.5,
  b: -2,
  c: 0, // zero is a valid change, not an unknown quote
  d: 1.5, // ties with a
  e: null,
  f: Number.NaN,
};
const changeOf = (symbol: string) => changes[symbol] ?? null;

it("keeps the saved order by default without mutating the input", () => {
  expect(sortWatchSymbols(saved, changeOf, "saved")).toEqual(saved);
  expect(saved).toEqual(["a", "b", "c", "d", "e", "f"]);
});

it("sorts both directions, puts unknown changes last and keeps ties saved", () => {
  expect(sortWatchSymbols(saved, changeOf, "gain")).toEqual([
    "a",
    "d",
    "c",
    "b",
    "e",
    "f",
  ]);
  expect(sortWatchSymbols(saved, changeOf, "loss")).toEqual([
    "b",
    "c",
    "a",
    "d",
    "e",
    "f",
  ]);
  expect(saved).toEqual(["a", "b", "c", "d", "e", "f"]);
});

it("keeps the saved order when every quote is unknown", () => {
  expect(sortWatchSymbols(saved, () => null, "gain")).toEqual(saved);
  expect(sortWatchSymbols(saved, () => null, "loss")).toEqual(saved);
});
