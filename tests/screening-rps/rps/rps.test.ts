import { expect, it } from "vitest";
import { rankRps, rpsPeriods } from "../../../src/lib/screening/rps";
import {
  calculateRpsDay,
  prepareRpsSecurity,
  rpsPoolExclusion,
} from "../../../src/server/screening/rps-engine";
import { rpsBars, rpsCalendar, rpsDate, tenStocks } from "../../rps-fixture";

it("10 calculator-checkable stocks rank identically across all six parameterized periods", () => {
  const result = calculateRpsDay(tenStocks(), rpsCalendar, rpsDate);
  expect(result.counts).toEqual([10, 10, 10, 10, 10, 10]);
  // All six base closes=10; final closes=10,11,...,19.
  // Gain_i=(10+i)/10-1=i/10; descending rank=10-i;
  // RPS_i=(1-(10-i)/10)*100=10*i. Thus best=90, worst=0.
  result.rows.forEach((row, i) =>
    row.values.forEach((v) => {
      expect(v!.return).toBeCloseTo(i / 10, 12);
      expect(v!.rank).toBe(10 - i);
      expect(v!.rps).toBeCloseTo(i * 10, 12);
    }),
  );
  expect(result.rows.map((r) => r.symbol)).toEqual(
    tenStocks().map((s) => s.symbol),
  );
  expect(
    calculateRpsDay(tenStocks(), rpsCalendar, rpsDate, [10]).rows[9]!.values,
  ).toEqual([result.rows[9]!.values[1]]);
});

it("10-for-10 bonus: backward-adjusted strong stock ranks FIRST; raw prices rank LAST", () => {
  const bars = rpsBars(0).filter((b) => b.date <= rpsDate);
  bars[bars.length - 1] = {
    ...bars.at(-1)!,
    close: 9.75,
    open: 9.75,
    high: 9.75,
    low: 9.75,
  };
  const events = [
    { date: rpsDate, category: 1, name: "除权除息", bonusRatio: 1 },
  ];
  const adjusted = prepareRpsSecurity(
    "sz000009",
    "送转强股",
    bars,
    events,
    rpsCalendar[0]!,
  );
  const raw = prepareRpsSecurity(
    "sz000009",
    "送转强股",
    bars,
    [],
    rpsCalendar[0]!,
  );
  const peers = tenStocks().slice(0, 9);
  const corrected = calculateRpsDay(
    [...peers, adjusted],
    rpsCalendar,
    rpsDate,
  ).rows.at(-1)!;
  const wrong = calculateRpsDay([...peers, raw], rpsCalendar, rpsDate).rows.at(
    -1,
  )!;
  // Pre-ex price=10/(1+1)=5; factor=10/5=2; 9.75*2/10-1=+95%.
  // Raw=9.75/10-1=-2.5%, below all peers (0..80%).
  // Correct rank 1 => (1-1/10)*100=90; raw rank 10 => 0.
  for (let p = 0; p < rpsPeriods.length; p++) {
    expect(corrected.values[p]!.return).toBeCloseTo(0.95, 12);
    expect(corrected.values[p]!.rank).toBe(1);
    expect(corrected.values[p]!.rps).toBe(90);
    expect(wrong.values[p]!.return).toBeCloseTo(-0.025, 12);
    expect(wrong.values[p]!.rank).toBe(10);
    expect(wrong.values[p]!.rps).toBe(0);
  }
});

it("cash plus rights uses existing GBBQ factor semantics", () => {
  const bars = rpsBars().filter((b) => b.date <= rpsDate);
  bars.at(-1)!.close = 10;
  const adjusted = prepareRpsSecurity(
    "sz000000",
    "配股",
    bars,
    [
      {
        date: rpsDate,
        category: 1,
        name: "除权",
        dividend: 1,
        rightsRatio: 0.5,
        rightsPrice: 4,
      },
    ],
    rpsCalendar[0]!,
  );
  // Theoretical=(10-1+0.5*4)/1.5=22/3; factor=15/11.
  expect(adjusted.closes.get(rpsDate)!.close).toBeCloseTo(150 / 11, 12);
});

it("future bars and a future ex-right event cannot alter any historical RPS", () => {
  const past = tenStocks(),
    future = tenStocks();
  const bars = rpsBars(9),
    futureDay = rpsCalendar[525]!;
  const events = [
    { date: futureDay, category: 1, name: "未来送转", bonusRatio: 2 },
  ];
  past[9] = prepareRpsSecurity(
    "sz000009",
    "样本9",
    bars.filter((b) => b.date <= rpsDate),
    events,
    rpsCalendar[0]!,
  );
  future[9] = prepareRpsSecurity(
    "sz000009",
    "样本9",
    bars,
    events,
    rpsCalendar[0]!,
  );
  for (const day of rpsCalendar.slice(500, 521))
    expect(calculateRpsDay(future, rpsCalendar, day)).toEqual(
      calculateRpsDay(
        past,
        rpsCalendar.filter((d) => d <= rpsDate),
        day,
      ),
    );
});

it.each(["ST样本", "*ST样本", "S*ST样本", " SST样本"])(
  "excludes ST name %s",
  (name) => {
    const stock = { ...tenStocks()[0]!, name };
    expect(rpsPoolExclusion(stock, rpsCalendar, 520, 250)).toBe("st");
  },
);
it("excludes young listings and includes the one-year boundary", () => {
  const stock = {
    ...tenStocks()[0]!,
    firstDate: `${Number(rpsDate.slice(0, 4)) - 1}${rpsDate.slice(4)}`,
  };
  expect(rpsPoolExclusion(stock, rpsCalendar, 520, 250)).toBeNull();
  stock.firstDate = rpsCalendar[519]!;
  expect(rpsPoolExclusion(stock, rpsCalendar, 520, 250)).toBe("young");
});
it("excludes Beijing and unknown names with distinct reasons", () => {
  expect(
    rpsPoolExclusion(
      { ...tenStocks()[0]!, symbol: "bj920001" },
      rpsCalendar,
      520,
      250,
    ),
  ).toBe("market");
  expect(
    rpsPoolExclusion(
      { ...tenStocks()[0]!, name: "sz000000" },
      rpsCalendar,
      520,
      250,
    ),
  ).toBe("nameUnknown");
});
it("20 consecutive no-trade sessions excludes; 19 does not; no endpoint price filling", () => {
  const stock = tenStocks()[0]!;
  for (const d of rpsCalendar.slice(502, 521)) stock.closes.delete(d);
  expect(rpsPoolExclusion(stock, rpsCalendar, 520, 250)).toBeNull();
  expect(calculateRpsDay([stock], rpsCalendar, rpsDate).missing).toEqual([
    1, 1, 1, 1, 1, 1,
  ]);
  stock.closes.get(rpsCalendar[501]!)!.volume = 0;
  expect(rpsPoolExclusion(stock, rpsCalendar, 520, 250)).toBe("suspended");
});
it("missing endpoints only reduce that period's denominator", () => {
  const stocks = tenStocks();
  stocks[0]!.closes.delete(rpsCalendar[515]!);
  const result = calculateRpsDay(stocks, rpsCalendar, rpsDate);
  expect(result.counts).toEqual([9, 10, 10, 10, 10, 10]);
  expect(result.rows[0]!.values[0]).toBeNull();
});
it("ties use mean occupied 1-based ranks; all tied and singleton never become 100", () => {
  // Returns 30%,20%,20%,0% occupy ranks 1,2.5,2.5,4 => 75,37.5,37.5,0.
  const values = rankRps(
    [0.3, 0.2, 0.2, 0].map((value, i) => ({
      symbol: String(i),
      return: value,
    })),
  );
  expect([...values.values()].map((v) => v.rps)).toEqual([75, 37.5, 37.5, 0]);
  expect(
    [
      ...rankRps([
        { symbol: "a", return: 0 },
        { symbol: "b", return: 0 },
      ]).values(),
    ].map((v) => v.rps),
  ).toEqual([25, 25]);
  expect(rankRps([{ symbol: "a", return: 0 }]).get("a")!.rps).toBe(0);
  expect(rankRps([]).size).toBe(0);
});
it("unsupported shrink and invalid ex-price remain explicit exclusions", () => {
  for (const event of [
    { date: rpsDate, category: 11, name: "缩股", shrinkRatio: 2 },
    { date: rpsDate, category: 1, name: "无效派息", dividend: 11 },
  ]) {
    const stock = prepareRpsSecurity(
      "sz000000",
      "测试",
      rpsBars(),
      [event],
      rpsCalendar[0]!,
    );
    expect(rpsPoolExclusion(stock, rpsCalendar, 520, 250)).toBe(
      "unsupportedAction",
    );
  }
});
it("rejects invalid ranks, duplicate symbols, invalid periods and incomplete calendar", () => {
  expect(() => rankRps([{ symbol: "a", return: NaN }])).toThrow();
  expect(() =>
    rankRps([
      { symbol: "a", return: 0 },
      { symbol: "a", return: 1 },
    ]),
  ).toThrow();
  expect(() =>
    calculateRpsDay(tenStocks(), rpsCalendar, rpsDate, [5, 5]),
  ).toThrow();
  expect(() =>
    calculateRpsDay(tenStocks(), rpsCalendar.slice(500), rpsDate),
  ).toThrow("日历不足");
});
