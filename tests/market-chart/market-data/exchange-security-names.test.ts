import { expect, it } from "vitest";
import {
  exchangeNames,
  exchangeNamesSchema,
} from "../../../src/server/market/exchange-security-names";
import snapshot from "../../../src/server/data/exchange-delisted.json";

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
  expect(exchangeNames.get("sz000022")).toMatchObject({
    name: "深赤湾A",
    status: "code-changed",
    successor: "sz001872",
    date: "2018-12-26",
  });
  expect(exchangeNames.get("sz000043")).toMatchObject({
    name: "中航善达",
    status: "code-changed",
    successor: "sz001914",
  });
  expect(exchangeNames.get("bj920305")).toMatchObject({
    name: "云创退",
    status: "delisted",
    date: "2026-07-30",
  });
  expect(exchangeNames.get("bj920680")).toMatchObject({
    name: "广道退",
    status: "delisted",
    date: "2026-01-05",
  });
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
