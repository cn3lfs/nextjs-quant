import Database from "better-sqlite3";
import { afterEach, expect, it } from "vitest";
import { aggregateIndustryRps } from "../../../src/lib/screening/industry-rps";
import { migrate } from "../../../src/server/db/migrations";
import { RpsStore } from "../../../src/server/db/rps-store";
import { industryRpsPage } from "../../../src/server/screening/industry-rps-query";
import { calculateRpsDay } from "../../../src/server/screening/rps-adapter";
import {
  industrySnapshot,
  industryDay,
} from "../../helpers/industry-rps-fixture";
import {
  rpsCalendar,
  rpsDate,
  rpsDay,
  tenStocks,
} from "../../helpers/rps-fixture";

const dbs: Database.Database[] = [];
afterEach(() => dbs.splice(0).forEach((db) => db.close()));
function setup() {
  const db = new Database(":memory:");
  dbs.push(db);
  migrate(db);
  return { db, store: new RpsStore(db, "industry") };
}
const group = (groups: Record<string, string[]>, periods?: readonly number[]) =>
  aggregateIndustryRps(
    industrySnapshot(groups),
    calculateRpsDay(tenStocks(), rpsCalendar, rpsDate),
    periods,
  );
const dayFor = (
  date: string,
  periods: number[],
  result: ReturnType<typeof group>,
) => ({
  ...rpsDay().day,
  date,
  periods,
  total: result.industry.snapshot.files.length,
  pool: result.pool,
  counts: result.counts,
  missing: result.missing,
  industry: result.industry,
});

it("a missing condition value never matches, even at threshold 0, and paging follows the filtered set", () => {
  const { store } = setup();
  const groups = {
    甲: ["sz000000", "sz000001"],
    乙: ["sz000008", "sz000009"],
    丙: ["sz000003", "sz000004"],
    空行业: [],
  };
  const result = group(groups);
  store.saveDay(
    dayFor(rpsDate, [...rpsDay().day.periods], result),
    result.rows,
  );

  const first = industryRpsPage(store, {
    period: 20,
    conditions: [{ period: 20, side: "gte", value: 0 }],
    page: 0,
  });
  // 空行业 has no condition value and must not be counted as a 0-RPS hit.
  expect(first.total).toBe(3);
  expect(first.conditions).toEqual([
    { period: 20, side: "gte", value: 0, count: 3, periodMissing: false },
  ]);
  expect(first.rows.map((row) => row.name)).not.toContain("空行业");
  expect(
    first.rows.every((row) => row.conditionValues?.["20"]?.rps != null),
  ).toBe(true);

  const withEmpty = industryRpsPage(store, {
    period: 20,
    conditions: [],
    page: 0,
  });
  expect(withEmpty.total).toBe(4);
});

it("a historical condition only reads that day's stored batch and reports a missing period", () => {
  const { store } = setup();
  const oldDate = rpsCalendar[519]!;
  const short = group(
    {
      甲: ["sz000000", "sz000001"],
      乙: ["sz000008", "sz000009"],
      丙: ["sz000003", "sz000004"],
    },
    [5, 10],
  );
  store.saveDay(dayFor(oldDate, [5, 10], short), short.rows);
  const latest = industryDay();
  store.saveDay(latest.day, latest.rows);

  const historical = industryRpsPage(store, {
    date: oldDate,
    period: 5,
    conditions: [{ period: 20, side: "gte", value: 0 }],
    page: 0,
  });
  expect(historical.day?.date).toBe(oldDate);
  expect(historical.conditions).toEqual([
    { period: 20, side: "gte", value: 0, count: null, periodMissing: true },
  ]);
  expect(historical.rows).toEqual([]);
  expect(historical.total).toBe(0);

  // Without a date the newer batch is used; the condition now has a base.
  const current = industryRpsPage(store, {
    period: 5,
    conditions: [{ period: 20, side: "gte", value: 0 }],
    page: 0,
  });
  expect(current.day?.date).toBe(rpsDate);
  expect(current.conditions?.[0]).toMatchObject({ periodMissing: false });
  expect(current.total).toBe(3);
});

it("filtering keeps the batch ranks instead of re-ranking the filtered rows", () => {
  const { store } = setup();
  const groups = Object.fromEntries(
    Array.from({ length: 25 }, (_, i) => [`行业${i}`, [`sz00000${i % 10}`]]),
  );
  const result = group(groups);
  store.saveDay(
    dayFor(rpsDate, [...rpsDay().day.periods], result),
    result.rows,
  );

  const filtered = industryRpsPage(store, {
    period: 20,
    conditions: [{ period: 20, side: "lte", value: 40 }],
    page: 0,
  });
  // RPS ≤ 40 selects the tied tail of the batch; the first row must still
  // show its batch rank (15), not 1, because filtering never re-ranks.
  expect(filtered.total).toBe(12);
  expect(filtered.rows[0]!.value?.rank).toBe(15);
  expect(filtered.rows.every((row) => row.value!.rps <= 40)).toBe(true);
});
