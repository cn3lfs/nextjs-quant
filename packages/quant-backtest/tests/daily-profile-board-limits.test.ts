import { expect, it } from "vitest";
import { replayDailyStudy, studyLimitRate } from "../src/daily-profile.js";

it("uses 20% for ChiNext from 2020-08-24 and the shared limits for other boards", () => {
  expect(studyLimitRate("sh600519", "2010-01-04")).toBe(0.1);
  expect(studyLimitRate("sz300750", "2020-08-21")).toBe(0.1);
  expect(studyLimitRate("sz300750", "2020-08-24")).toBe(0.2);
  expect(studyLimitRate("sh688981", "2021-01-04")).toBe(0.2);
  expect(studyLimitRate("bj430047", "2024-01-04")).toBe(0.3);
});

function replayOpeningBuy(date: string, symbol?: string) {
  const warmup = Array.from({ length: 141 }, (_, i) => ({
    date: new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1000,
    amount: 100000,
  }));
  const opening = {
    date,
    open: 115,
    high: 116,
    low: 114,
    close: 115,
    volume: 1000,
    amount: 115000,
  };
  return replayDailyStudy([...warmup, opening], [], {
    strategy: "hold",
    symbol,
    start: date,
    end: date,
    initial: 100000,
  });
}

it("fills a 15% ChiNext opening rise under the 20% limit on 2020-08-24", () => {
  const result = replayOpeningBuy("2020-08-24", "sz300750");
  expect(result.fills).toMatchObject([
    { side: "buy", date: "2020-08-24", price: 115 },
  ]);
  expect(result.rejected).toHaveLength(0);
});

it.each([
  ["2020-08-21", "sz300750"],
  ["2020-08-24", undefined],
])(
  "rejects a 15% opening rise under the 10% limit on %s for %s",
  (date, symbol) => {
    const result = replayOpeningBuy(date!, symbol);
    expect(result.fills).toHaveLength(0);
    expect(result.rejected).toMatchObject([
      { date, reason: expect.stringContaining("开盘涨停") },
    ]);
  },
);
