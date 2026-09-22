import { expect, it } from "vitest";
import { aggregateIndustryRps } from "../src/lib/industry-rps";
import {
  calculateRpsDay,
  prepareRpsSecurity,
} from "../src/server/screening/rps-engine";
import { rpsBars, rpsCalendar, rpsDate, tenStocks } from "./rps-fixture";
import { industrySnapshot } from "./industry-rps-fixture";

it("three industries have calculator-verifiable equal-weight returns and ranks in all six periods", () => {
  const gains = [1.25, 3.75, 5, 5, -2.5, 0];
  const stocks = gains.map((gain, i) =>
    prepareRpsSecurity(
      `sz00000${i}`,
      `样本${i}`,
      rpsBars(gain),
      [],
      rpsCalendar[0]!,
    ),
  );
  const snapshot = industrySnapshot({
    甲: ["sz000000", "sz000001"],
    乙: ["sz000002", "sz000003"],
    丙: ["sz000004", "sz000005"],
  });
  const result = aggregateIndustryRps(
    snapshot,
    calculateRpsDay(stocks, rpsCalendar, rpsDate),
  );
  // Six base closes are all 10. A=((11.25/10-1)+(13.75/10-1))/2=0.25;
  // B=((15/10-1)+(15/10-1))/2=0.5; C=((7.5/10-1)+(10/10-1))/2=-0.125.
  // Descending ranks: B=1,A=2,C=3. RPS=(1-rank/3)*100: 66.6667,33.3333,0.
  for (const [i, row] of result.rows.entries()) {
    for (const value of row.values) {
      expect(value!.return).toBe([0.25, 0.5, -0.125][i]);
      expect(value!.rank).toBe([2, 1, 3][i]);
      expect(value!.rps).toBeCloseTo([100 / 3, 200 / 3, 0][i]!, 12);
    }
  }
  expect(result.counts).toEqual([3, 3, 3, 3, 3, 3]);
  expect(result.industry.members.map((m) => m.included)).toEqual(
    Array.from({ length: 3 }, () => [2, 2, 2, 2, 2, 2]),
  );
});

it("ST, young, long-suspended and Beijing components are excluded before averaging and counted", () => {
  const stocks = tenStocks().slice(0, 6);
  stocks[1]!.name = "*ST样本";
  stocks[2]!.firstDate = rpsCalendar[519]!;
  for (const d of rpsCalendar.slice(501, 521)) stocks[3]!.closes.delete(d);
  stocks[4]!.symbol = "bj920001";
  const result = aggregateIndustryRps(
    industrySnapshot({ 过滤组: stocks.map((s) => s.symbol) }),
    calculateRpsDay(stocks, rpsCalendar, rpsDate),
  );
  // Remaining members 0 and 5: ((10/10-1)+(15/10-1))/2=0.25.
  expect(result.rows[0]!.values.map((v) => v!.return)).toEqual([
    0.25, 0.25, 0.25, 0.25, 0.25, 0.25,
  ]);
  expect(result.industry.members[0]).toMatchObject({
    total: 6,
    eligible: 2,
    included: [2, 2, 2, 2, 2, 2],
    excluded: { st: 1, young: 1, suspended: 1, market: 1 },
  });
  expect(result.industry.excluded).toEqual({
    market: 1,
    nameUnknown: 0,
    st: 1,
    young: 1,
    suspended: 1,
    unsupportedAction: 0,
    missingEndpoint: 0,
    unavailable: 0,
  });
});

it("empty and fully filtered industries never become zero-return ranked members", () => {
  const stocks = tenStocks().slice(0, 2);
  stocks[1]!.name = "ST样本";
  const result = aggregateIndustryRps(
    industrySnapshot({
      有效: [stocks[0]!.symbol],
      空名单: [],
      全剔除: [stocks[1]!.symbol],
      无本地行情: ["sz000888"],
      无北交所行情: ["bj920001"],
    }),
    calculateRpsDay(stocks, rpsCalendar, rpsDate),
  );
  expect(result.counts).toEqual([1, 1, 1, 1, 1, 1]);
  expect(result.rows[0]!.values.map((v) => v!.rank)).toEqual([
    1, 1, 1, 1, 1, 1,
  ]);
  expect(
    result.rows.slice(1).every((r) => r.values.every((v) => v === null)),
  ).toBe(true);
  expect(result.industry.members[1]!.empty).toEqual(
    Array(6).fill("empty-list"),
  );
  expect(result.industry.members[2]!.empty).toEqual(
    Array(6).fill("all-filtered"),
  );
  expect(result.industry.excluded.unavailable).toBe(1);
  expect(result.industry.excluded.market).toBe(1);
});

it("missing endpoints are period-specific; unsupported actions and unknown names keep S1 reasons", () => {
  const stocks = tenStocks().slice(0, 4);
  stocks[0]!.closes.delete(rpsCalendar[515]!);
  stocks[1]!.name = "";
  stocks[2]!.unsupportedDates = [rpsDate];
  stocks[3]!.closes.delete(rpsDate);
  const result = aggregateIndustryRps(
    industrySnapshot({
      分周期: [stocks[0]!.symbol],
      剔除: stocks.slice(1).map((s) => s.symbol),
    }),
    calculateRpsDay(stocks, rpsCalendar, rpsDate),
  );
  expect(result.counts).toEqual([0, 1, 1, 1, 1, 1]);
  expect(result.industry.members[0]!.empty).toEqual([
    "missing-endpoints",
    null,
    null,
    null,
    null,
    null,
  ]);
  expect(result.industry.members[0]!.missing).toEqual([1, 0, 0, 0, 0, 0]);
  expect(result.industry.excluded).toMatchObject({
    nameUnknown: 1,
    unsupportedAction: 1,
    missingEndpoint: 1,
  });
});

it("industry aggregation uses adjusted RETURNS, not constituent RPS or raw prices", () => {
  const bars = rpsBars().filter((b) => b.date <= rpsDate);
  bars.at(-1)!.close = 7.5;
  const make = (adjusted: boolean) =>
    prepareRpsSecurity(
      "sz000000",
      "送转",
      bars,
      adjusted
        ? [{ date: rpsDate, category: 1, name: "送转", bonusRatio: 1 }]
        : [],
      rpsCalendar[0]!,
    );
  const other = prepareRpsSecurity(
    "sz000001",
    "普通",
    rpsBars(2.5),
    [],
    rpsCalendar[0]!,
  );
  const snapshot = industrySnapshot({
    送转行业: ["sz000000"],
    普通行业: ["sz000001"],
  });
  const correct = aggregateIndustryRps(
    snapshot,
    calculateRpsDay([make(true), other], rpsCalendar, rpsDate),
  );
  const raw = aggregateIndustryRps(
    snapshot,
    calculateRpsDay([make(false), other], rpsCalendar, rpsDate),
  );
  // 10-for-10 factor=2; adjusted=7.5*2/10-1=50% >25%; raw=7.5/10-1=-25% <25%.
  expect(correct.rows[0]!.values[0]).toEqual({ return: 0.5, rank: 1, rps: 50 });
  expect(raw.rows[0]!.values[0]).toEqual({ return: -0.25, rank: 2, rps: 0 });
});

it("appending future bars and future corporate actions cannot change historical industry RPS", () => {
  const snapshot = industrySnapshot();
  const stocks = (future: boolean) =>
    Array.from({ length: 10 }, (_, i) =>
      prepareRpsSecurity(
        `sz00000${i}`,
        `样本${i}`,
        rpsBars(i).filter((b) => future || b.date <= rpsDate),
        [
          {
            date: rpsCalendar[525]!,
            category: 1,
            name: "未来送转",
            bonusRatio: 2,
          },
        ],
        rpsCalendar[0]!,
      ),
    );
  for (const date of rpsCalendar.slice(500, 521)) {
    expect(
      aggregateIndustryRps(
        snapshot,
        calculateRpsDay(stocks(true), rpsCalendar, date),
      ),
    ).toEqual(
      aggregateIndustryRps(
        snapshot,
        calculateRpsDay(
          stocks(false),
          rpsCalendar.filter((d) => d <= rpsDate),
          date,
        ),
      ),
    );
  }
});

it("equal industry returns share average one-based rank regardless of different membership counts", () => {
  const stocks = tenStocks().slice(0, 3);
  const result = aggregateIndustryRps(
    industrySnapshot({
      甲: [stocks[0]!.symbol],
      乙: stocks.map((s) => s.symbol),
    }),
    calculateRpsDay(stocks, rpsCalendar, rpsCalendar[519]!),
  );
  // Both returns=0; average rank=(1+2)/2=1.5; RPS=(1-1.5/2)*100=25.
  expect(result.rows.map((r) => r.values[0])).toEqual([
    { return: 0, rank: 1.5, rps: 25 },
    { return: 0, rank: 1.5, rps: 25 },
  ]);
});
