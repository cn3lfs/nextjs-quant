import { expect, it } from "vitest";
import { calculateRps } from "quant-rps";
import {
  validationMemberActive,
  validationMembersAt,
  type ValidationMember,
} from "../../src/server/research/validation-universe";

const cached: ValidationMember = {
  symbol: "sh600000",
  name: "证券甲",
  local: true,
  listingDate: "2010-01-01",
  delistingDate: "2024-06-17",
  fetchedAt: Date.parse("2024-06-18T16:00:00Z"),
  evidenceHash: "a".repeat(64),
};

it("退市日早于抓取日时，上海回放日到达抓取日才从名册和 RPS 排名分母移除", () => {
  const other = {
    ...cached,
    symbol: "sz000001",
    name: "证券乙",
    listingDate: null,
    delistingDate: null,
    fetchedAt: null,
    evidenceHash: null,
  };
  const roster = { members: [cached, other] };
  const calendar = ["2024-06-14", "2024-06-17", "2024-06-18", "2024-06-19"];
  const stocks = roster.members.map(({ symbol, name }, index) => ({
    symbol,
    name,
    firstDate: "2010-01-01",
    unsupportedDates: [],
    closes: new Map(
      calendar.map((day, step) => [
        day,
        { close: 10 + (index + 1) * step, volume: 100 },
      ]),
    ),
  }));
  for (const day of calendar.slice(1, 3)) {
    const symbols = validationMembersAt(roster, day);
    expect(symbols).toEqual([cached.symbol, other.symbol]);
    const result = calculateRps(
      stocks.filter((stock) => symbols.includes(stock.symbol)),
      calendar,
      day,
      [1],
    );
    expect(result.counts).toEqual([2]);
    expect(
      result.rows.find((row) => row.symbol === other.symbol)?.values[0],
    ).toMatchObject({ rank: 1, rps: 50 });
  }
  const day = calendar[3]!;
  const symbols = validationMembersAt(roster, day);
  expect(symbols).toEqual([other.symbol]);
  const result = calculateRps(
    stocks.filter((stock) => symbols.includes(stock.symbol)),
    calendar,
    day,
    [1],
  );
  expect(result.counts).toEqual([1]);
  expect(result.rows[0]?.values[0]).toMatchObject({ rank: 1, rps: 0 });
});

it("公告先于缓存时按公告和生效日判断，缺失抓取时间的缓存日期保持未知", () => {
  const unknown = { ...cached, fetchedAt: null };
  expect(validationMemberActive(unknown, "2024-06-19")).toBe(true);
  expect(
    validationMemberActive({ ...cached, fetchedAt: undefined }, "2024-06-19"),
  ).toBe(true);
  const withNotice = {
    ...unknown,
    terminalStatus: {
      evidenceHash: "b".repeat(64),
      lastTrading: null,
      listingEnd: {
        date: "2024-06-17",
        publishedOn: "2024-06-14",
        source: "https://example.com/delisting",
      },
    },
  };
  expect(validationMemberActive(withNotice, "2024-06-13")).toBe(true);
  expect(validationMemberActive(withNotice, "2024-06-14")).toBe(true);
  expect(validationMemberActive(withNotice, "2024-06-17")).toBe(false);
});

it("上市日期也只在回放日能看到缓存时用于名册判断", () => {
  const futureListing = {
    ...cached,
    listingDate: "2024-06-20",
    delistingDate: null,
  };
  expect(validationMemberActive(futureListing, "2024-06-18")).toBe(true);
  expect(validationMemberActive(futureListing, "2024-06-19")).toBe(false);
  expect(validationMemberActive(futureListing, "2024-06-20")).toBe(true);
});
