import { expect, it } from "vitest";
import {
  exchangeNames,
  exchangeNamesSchema,
} from "../src/server/exchange-security-names";
import snapshot from "../src/server/data/exchange-delisted.json";

it("uses exchange names and distinguishes code changes from delisting", () => {
  expect(exchangeNames.get("sh600001")).toMatchObject({
    name: "邯郸钢铁",
    date: "2009-12-29",
    status: "delisted",
  });
  expect(exchangeNames.get("sz000004")).toMatchObject({
    name: "国华退",
    status: "delisted",
  });
  expect(exchangeNames.get("sz300114")).toMatchObject({
    name: "中航电测",
    status: "code-changed",
    successor: "sz302132",
  });
  expect(exchangeNames.get("sh600849")?.status).toBe("code-changed");
});
it("rejects corrupt identities, invalid dates and duplicates", () => {
  for (const entry of [
    { ...snapshot.entries[0], symbol: "sz999999" },
    { ...snapshot.entries[0], name: "" },
    { ...snapshot.entries[0], delistingDate: "2026-99-99" },
  ])
    expect(
      exchangeNamesSchema.safeParse({ ...snapshot, entries: [entry] }).success,
    ).toBe(false);
  expect(
    exchangeNamesSchema.safeParse({
      ...snapshot,
      entries: [snapshot.entries[0], snapshot.entries[0]],
    }).success,
  ).toBe(false);
});
