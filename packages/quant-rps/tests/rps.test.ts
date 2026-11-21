import { expect, it } from "vitest";
import {
  aggregateGroupRps,
  calculateRps,
  calculateRpsAtIndex,
  rankRps,
  rpsPeriods,
  rpsPolicy,
  rpsPoolExclusion,
  type RpsSecurity,
} from "../src/index.js";

const calendar: string[] = [];
for (let day = Date.UTC(2020, 0, 2); calendar.length < 550; day += 86400000) {
  if (![0, 6].includes(new Date(day).getUTCDay()))
    calendar.push(new Date(day).toISOString().slice(0, 10));
}
const index = 520,
  date = calendar[index]!;
function security(symbol = "sh600000", close = 100): RpsSecurity {
  const closes = new Map(
    calendar.map((day) => [day, { close: 100, volume: 100 }]),
  );
  closes.get(date)!.close = close;
  return {
    symbol,
    name: `样本${symbol}`,
    firstDate: calendar[0]!,
    closes,
    unsupportedDates: [],
  };
}

it("uses one-based average ranks, exact ties and each pool's own denominator without mutating inputs", () => {
  const values = [
    { symbol: "a", return: 0.3 },
    { symbol: "c", return: 0.2 },
    { symbol: "b", return: 0.2 },
    { symbol: "d", return: -0.1 },
  ];
  const before = structuredClone(values),
    result = rankRps(values);
  expect([...result.keys()]).toEqual(["a", "b", "c", "d"]);
  expect(result.get("a")).toEqual({ return: 0.3, rank: 1, rps: 75 });
  expect(result.get("b")).toEqual({ return: 0.2, rank: 2.5, rps: 37.5 });
  expect(result.get("c")).toEqual(result.get("b"));
  expect(result.get("d")).toEqual({ return: -0.1, rank: 4, rps: 0 });
  expect(values).toEqual(before);
});

it("handles empty pools, singleton pools and an entirely tied pool with the documented formula", () => {
  expect(rankRps([]).size).toBe(0);
  expect(rankRps([{ symbol: "a", return: 0 }]).get("a")).toEqual({
    return: 0,
    rank: 1,
    rps: 0,
  });
  for (const value of rankRps(
    ["a", "b", "c"].map((symbol) => ({ symbol, return: 0 })),
  ).values()) {
    expect(value.rank).toBe(2);
    expect(value.rps).toBeCloseTo(100 / 3);
  }
});

it("rejects nonfinite ranking returns and duplicate securities", () => {
  for (const value of [NaN, Infinity, -Infinity])
    expect(() => rankRps([{ symbol: "a", return: value }])).toThrow("收益无效");
  expect(() =>
    rankRps([
      { symbol: "a", return: 0 },
      { symbol: "a", return: 1 },
    ]),
  ).toThrow("证券重复");
});

it("calculates all seven trading-session endpoints independently and preserves requested period order", () => {
  expect(rpsPeriods).toEqual([1, 3, 5, 10, 20, 50, 120]);
  const stocks = [security("sh600000", 120), security("sz000001")];
  const bases = [100, 150, 80, 100, 60, 120, 200];
  rpsPeriods.forEach((period, i) => {
    stocks[0]!.closes.get(calendar[index - period]!)!.close = bases[i]!;
  });
  const before = structuredClone(stocks),
    result = calculateRps(stocks, calendar, date);
  const expected = [0.2, -0.2, 0.5, 0.2, 1, 0, -0.4];
  result.rows[0]!.values.forEach((value, i) =>
    expect(value!.return).toBeCloseTo(expected[i]!, 12),
  );
  expect(result.rows[0]!.values.map((value) => value!.rps)).toEqual([
    50, 0, 50, 50, 50, 25, 0,
  ]);
  expect(result.counts).toEqual(Array(7).fill(2));
  const reordered = calculateRps(stocks, calendar, date, [120, 1, 3]);
  expect(reordered.rows.map((row) => row.values)).toEqual(
    result.rows.map((row) => [row.values[6], row.values[0], row.values[1]]),
  );
  expect(stocks).toEqual(before);
});

it("produces the same rankings and diagnostics when addressed by calendar index or date", () => {
  const stocks = [
    security("sz000001", 110),
    security("sh600000", 120),
    { ...security("sh600001"), name: "ST样本" },
  ];
  stocks[0]!.closes.delete(calendar[index - 3]!);
  stocks[1]!.closes.get(calendar[index + 1]!)!.close = 90;
  for (const dayIndex of [index - 1, index, index + 1]) {
    const day = calendar[dayIndex]!;
    expect(calculateRpsAtIndex(stocks, calendar, dayIndex)).toEqual(
      calculateRps(stocks, calendar, day),
    );
    expect(
      calculateRpsAtIndex(stocks, calendar, dayIndex, [5, 1, 3], day),
    ).toEqual(calculateRps(stocks, calendar, day, [5, 1, 3]));
  }
});

it("requires the first occurrence of a duplicated trading date", () => {
  const stocks = [security()];
  const duplicated = [...calendar];
  duplicated.splice(120, 0, calendar[119]!);
  expect(() => calculateRpsAtIndex(stocks, duplicated, 120)).toThrow(
    "RPS参考日历索引必须是该交易日的首次出现位置",
  );
  expect(() =>
    calculateRpsAtIndex(stocks, duplicated, 121, undefined, calendar[120]!),
  ).not.toThrow();
});

it("rejects invalid indices and a trading date that disagrees with the index", () => {
  const stocks = [security()];
  for (const invalid of [-1, index + 0.5, NaN, calendar.length, 119]) {
    expect(() => calculateRpsAtIndex(stocks, calendar, invalid)).toThrow(
      "RPS参考日历不足，不能缩短收益窗口",
    );
  }
  expect(() =>
    calculateRpsAtIndex(
      stocks,
      calendar,
      index,
      undefined,
      calendar[index - 1]!,
    ),
  ).toThrow("RPS参考日历索引与日期不匹配");
});

it("reduces only the denominator for the period whose price or traded endpoint is missing", () => {
  const stocks = [security("sh600000", 110), security("sz000001")];
  stocks[0]!.closes.delete(calendar[index - 1]!);
  stocks[1]!.closes.get(calendar[index - 3]!)!.volume = 0;
  const result = calculateRps(stocks, calendar, date);
  expect(result.counts).toEqual([1, 1, 2, 2, 2, 2, 2]);
  expect(result.missing).toEqual([1, 1, 0, 0, 0, 0, 0]);
  expect(result.rows[0]!.values[0]).toBeNull();
  expect(result.rows[1]!.values[1]).toBeNull();
  expect(result.rows[1]!.values[0]!.rps).toBe(0);
  const group = aggregateGroupRps(
    [{ name: "行业", members: stocks.map((stock) => stock.symbol) }],
    result,
  );
  expect(group.members[0]!.included).toEqual([1, 1, 2, 2, 2, 2, 2]);
  expect(group.rows[0]!.values[2]!.return).toBeCloseTo(0.05);
});

it("keeps wholly missing endpoints as null diagnostics rather than real zero returns", () => {
  const stock = security();
  stock.closes.get(date)!.volume = 0;
  const result = calculateRps([stock], calendar, date);
  expect(result.pool).toBe(1);
  expect(result.excluded.missingEndpoint).toEqual([stock.symbol]);
  expect(result.rows[0]!.values).toEqual(Array(7).fill(null));
  expect(result.counts).toEqual(Array(7).fill(0));
  for (const close of [0, -1, NaN, Infinity]) {
    stock.closes.get(date)!.volume = 100;
    stock.closes.get(date)!.close = close;
    expect(calculateRps([stock], calendar, date).rows[0]!.values).toEqual(
      Array(7).fill(null),
    );
  }
});

it("applies market, known-name, ST and conservative first-date eligibility", () => {
  for (const symbol of ["bj920001", "sh510300", "sh000300"])
    expect(rpsPoolExclusion(security(symbol), calendar, index, 120)).toBe(
      "market",
    );
  for (const name of ["", "sh600000"])
    expect(
      rpsPoolExclusion({ ...security(), name }, calendar, index, 120),
    ).toBe("nameUnknown");
  for (const name of ["ST样本", "*ST样本", "S*ST样本", " st样本 "])
    expect(
      rpsPoolExclusion({ ...security(), name }, calendar, index, 120),
    ).toBe("st");
  const anniversary = `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`;
  expect(
    rpsPoolExclusion(
      { ...security(), firstDate: anniversary },
      calendar,
      index,
      120,
    ),
  ).toBeNull();
  const nextDay = new Date(Date.parse(anniversary) + 86400000)
    .toISOString()
    .slice(0, 10);
  expect(
    rpsPoolExclusion(
      { ...security(), firstDate: nextDay },
      calendar,
      index,
      120,
    ),
  ).toBe("young");
});

it("uses exactly the last 20 reference sessions to distinguish suspended pools from missing current endpoints", () => {
  expect(rpsPolicy.suspensionSessions).toBe(20);
  const stock = security();
  for (let i = index - 19; i <= index; i++)
    stock.closes.get(calendar[i]!)!.volume = 0;
  expect(rpsPoolExclusion(stock, calendar, index, 120)).toBe("suspended");
  stock.closes.get(calendar[index - 19]!)!.volume = 1;
  expect(rpsPoolExclusion(stock, calendar, index, 120)).toBeNull();
  expect(
    calculateRps([stock], calendar, date).excluded.missingEndpoint,
  ).toEqual([stock.symbol]);
});

it("excludes unsupported actions only after the longest base date and on or before the decision", () => {
  const stock = security();
  stock.unsupportedDates = [calendar[index - 120]!, calendar[index + 1]!];
  expect(rpsPoolExclusion(stock, calendar, index, 120)).toBeNull();
  stock.unsupportedDates.push(calendar[index - 119]!);
  expect(rpsPoolExclusion(stock, calendar, index, 120)).toBe(
    "unsupportedAction",
  );
});

it("ignores later prices, volume and action facts for a completed decision", () => {
  const stock = security("sh600000", 110),
    original = calculateRps([stock], calendar, date);
  for (const day of calendar.slice(index + 1))
    stock.closes.set(day, { close: 999999, volume: 0 });
  stock.unsupportedDates.push(calendar[index + 1]!);
  expect(calculateRps([stock], calendar, date)).toEqual(original);
});

it("averages eligible member returns equally before ranking groups, rather than averaging stock RPS", () => {
  const stocks = [
    security("sh600000", 125),
    security("sz000001", 100),
    security("sh600001", 112.5),
  ];
  const calculation = calculateRps(stocks, calendar, date, [1, 3]);
  const groups = [
    { name: "组合AB", members: [stocks[0]!.symbol, stocks[1]!.symbol] },
    { name: "组合C", members: [stocks[2]!.symbol] },
  ];
  const before = structuredClone({ groups, calculation });
  const result = aggregateGroupRps(groups, calculation, [1, 3]);
  expect(
    result.rows.map((row) => row.values.map((value) => value!.return)),
  ).toEqual([
    [0.125, 0.125],
    [0.125, 0.125],
  ]);
  expect(
    result.rows.map((row) => row.values.map((value) => value!.rps)),
  ).toEqual([
    [25, 25],
    [25, 25],
  ]);
  expect(result.members.map((row) => row.included)).toEqual([
    [2, 2],
    [1, 1],
  ]);
  expect({ groups, calculation }).toEqual(before);
});

it("reports empty lists, filtered memberships, unavailable symbols and per-period missing endpoints distinctly", () => {
  const missing = security("sh600000", 110),
    st = { ...security("sz000001"), name: "ST样本" };
  missing.closes.delete(calendar[index - 1]!);
  missing.closes.delete(calendar[index - 3]!);
  const calculation = calculateRps([missing, st], calendar, date);
  const result = aggregateGroupRps(
    [
      { name: "空名单", members: [] },
      { name: "不合格", members: [st.symbol, "sh510300", "sz000099"] },
      { name: "缺端点", members: [missing.symbol] },
    ],
    calculation,
    [1, 3],
  );
  expect(result.members.map((row) => row.empty)).toEqual([
    ["empty-list", "empty-list"],
    ["all-filtered", "all-filtered"],
    ["missing-endpoints", "missing-endpoints"],
  ]);
  expect(result.members[1]!.excluded).toMatchObject({
    st: 1,
    market: 1,
    unavailable: 1,
  });
  expect(result.members[2]).toMatchObject({
    eligible: 1,
    included: [0, 0],
    missing: [1, 1],
  });
  expect(
    result.rows.every((row) => row.values.every((value) => value === null)),
  ).toBe(true);
  expect(result.counts).toEqual([0, 0]);
});

it("rejects unsupported, repeated or empty periods, repeated securities and insufficient calendar history", () => {
  const stock = security();
  for (const periods of [[], [1, 1], [2], [250], [1, 3, 5, 10, 20, 50, 120, 1]])
    expect(() => calculateRps([stock], calendar, date, periods)).toThrow(
      "周期无效",
    );
  expect(() =>
    calculateRps([stock, structuredClone(stock)], calendar, date),
  ).toThrow("证券重复");
  expect(() => calculateRps([stock], calendar, calendar[119]!)).toThrow(
    "日历不足",
  );
  expect(() => calculateRps([stock], calendar, "1990-01-01")).toThrow(
    "日历不足",
  );
  expect(() =>
    aggregateGroupRps(
      [
        { name: "重复", members: [stock.symbol] },
        { name: "重复", members: [stock.symbol] },
      ],
      calculateRps([stock], calendar, date),
    ),
  ).toThrow("证券重复");
});
