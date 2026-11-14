import { expect, it } from "vitest";
import {
  marketRules,
  sessionFor,
  priceLimitsFor,
} from "~/lib/market/market-rules";
import { instrumentFor } from "~/lib/market/instrument";
import { availablePeriods, periodSchema } from "~/lib/market/periods";
import { aggregateChartBars } from "~/lib/market/bar-aggregation";
import { aggregateCryptoBars } from "~/lib/market/crypto-aggregation";
import type { Bar } from "~/lib/domain";
import { completedBar } from "trading-strategy-core/completed-bars";
import { build } from "esbuild";
it("bundles the rule table for browsers without Node dependencies", async () => {
  const result = await build({
    entryPoints: ["src/lib/market/market-rules.ts"],
    bundle: true,
    platform: "browser",
    write: false,
  });
  expect(result.errors).toEqual([]);
  expect(result.outputFiles).toHaveLength(1);
});
const bar = (date: string, close = 10): Bar => ({
  date,
  open: close,
  high: close + 1,
  low: close - 1,
  close,
  volume: 100,
  amount: 1000,
});
it("resolves markets, settlement, size, evidence-dependent contract rules and explicit-date price limits", () => {
  expect(instrumentFor("cxBTCUSDT").market).toBe("crypto");
  expect(marketRules["cn-equity"].settlementDays).toBe(1);
  expect(marketRules.crypto.quantity).toEqual({
    kind: "venue-step",
    minimum: null,
    step: null,
  });
  expect(marketRules.futures.costs).toBeNull();
  expect(
    priceLimitsFor(instrumentFor("sh688001"), 10, {
      ruleDate: 20261114,
      listedDays: 10,
    }).percent,
  ).toBe(20);
  expect(
    priceLimitsFor(instrumentFor("sz000001"), 10, {
      ruleDate: 20261114,
      listedDays: 10,
    }).up,
  ).toBe(11);
  expect(
    sessionFor(instrumentFor("cxBTCUSDT"), Date.parse("2026-11-15T00:00Z"))
      .kind,
  ).toBe("continuous");
  expect(
    sessionFor(instrumentFor("sh600000"), Date.parse("2026-11-15T00:00Z")).kind,
  ).toBe("closed-day");
  expect(availablePeriods("cn-equity", ["day"])).toEqual(["day", "week"]);
  expect(periodSchema.options).toContain("4h");
});
it("aggregates 60m without crossing lunch, flags forming prefixes and excludes gaps", () => {
  const rows = Array.from({ length: 12 }, (_, i) =>
    bar(
      `2026-01-05T${String(Math.floor((575 + i * 5) / 60)).padStart(2, "0")}:${String((575 + i * 5) % 60).padStart(2, "0")}:00+08:00`,
      10 + i,
    ),
  );
  const done = aggregateChartBars(
    rows,
    "5m",
    "60m",
    Date.parse("2026-01-05T12:00+08:00"),
  );
  expect(done.bars).toEqual([
    {
      date: "2026-01-05T10:30:00+08:00",
      open: 10,
      high: 22,
      low: 9,
      close: 21,
      volume: 1200,
      amount: 12000,
    },
  ]);
  expect(
    aggregateChartBars(
      rows.slice(1),
      "5m",
      "60m",
      Date.parse("2026-01-05T12:00+08:00"),
    ).excluded,
  ).toHaveLength(1);
  const forming = aggregateChartBars(
    rows.slice(0, 2),
    "5m",
    "60m",
    Date.parse("2026-01-05T09:41+08:00"),
  );
  expect(forming.formingDates).toEqual(["2026-01-05T10:30:00+08:00"]);
});
it("weekly bars retain partial status and reject a proven missing trading day", () => {
  expect(
    completedBar("2026-01-05", "week", Date.parse("2026-01-06T08:00Z")),
  ).toBe(false);
  expect(
    completedBar("2026-01-09", "week", Date.parse("2026-01-09T15:04+08:00")),
  ).toBe(false);
  expect(
    completedBar("2026-01-09", "week", Date.parse("2026-01-09T15:05+08:00")),
  ).toBe(true);
  const rows = [5, 6, 7, 8, 9].map((d) => bar(`2026-01-0${d}`));
  expect(
    aggregateChartBars(rows, "day", "week", Date.parse("2026-01-10T00:00Z"))
      .bars[0]?.volume,
  ).toBe(500);
  expect(
    aggregateChartBars(
      rows.slice(0, 2),
      "day",
      "week",
      Date.parse("2026-01-06T08:00Z"),
    ).formingDates,
  ).toEqual(["2026-01-06"]);
  expect(
    aggregateChartBars(
      rows.filter((b) => b.date !== "2026-01-07"),
      "day",
      "week",
      Date.parse("2026-01-10T00:00Z"),
      { days: rows.map((b) => b.date) },
    ).bars,
  ).toEqual([]);
});
it("crypto 4h and weeks are continuous UTC, including weekend gaps and forming prefixes", () => {
  const rows = [1, 2, 3, 4].map((h) => bar(`2026-01-03T0${h}:00:00+00:00`));
  expect(
    aggregateCryptoBars(rows, "1h", "4h", Date.parse("2026-01-03T05:00Z"))
      .bars[0]?.volume,
  ).toBe(400);
  expect(
    aggregateCryptoBars(
      rows.slice(1),
      "1h",
      "4h",
      Date.parse("2026-01-03T05:00Z"),
    ).bars,
  ).toEqual([]);
  expect(
    aggregateCryptoBars(
      rows.slice(0, 2),
      "1h",
      "4h",
      Date.parse("2026-01-03T01:30Z"),
    ).formingDates,
  ).toEqual(["2026-01-03T04:00:00+00:00"]);
});
