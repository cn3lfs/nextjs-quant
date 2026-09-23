import { expect, it } from "vitest";
import type { Bar } from "~/lib/domain";
import {
  buildDailyEventCoverage,
  mergeVolumeEvidence,
} from "../../../src/lib/research/factors/research-event-coverage";

const bar = (date: string, close: number, volume = 100): Bar => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume,
  amount: close * volume,
});

it("按历史生效日派生主板/创业板/科创板/北交所的常规限制档位", () => {
  const cases = [
    ["sh600000", "2020-01-02", 0.1],
    ["sz300001", "2020-08-24", 0.2],
    ["sh688001", "2019-07-22", 0.2],
    ["bj430001", "2021-11-15", 0.3],
  ] as const;
  for (const [symbol, date, rate] of cases) {
    const result = buildDailyEventCoverage(
      symbol,
      [bar("2020-01-01", 10), bar(date, 10)],
      [],
      ["2020-01-01", date],
    );
    expect(result.rows.at(-1)?.priceLimit.rate).toBe(rate);
    expect(result.rows.at(-1)?.priceLimit.status).toBe("derived");
  }
});

it("把除权、零成交量和缺K线分别标成派生或未知", () => {
  const result = buildDailyEventCoverage(
    "sh600000",
    [bar("2020-01-01", 10, 0), bar("2020-01-03", 10, 100)],
    [{ date: "2020-01-03", category: 1, name: "除权除息" }],
    ["2020-01-01", "2020-01-02", "2020-01-03"],
  );
  expect(result.rows.map((row) => row.suspension.state)).toEqual([
    "suspended",
    "unknown",
    "resumed",
  ]);
  expect(result.rows[1]!.suspension.status).toBe("unknown");
  expect(result.rows[2]!.corporateAction).toMatchObject({
    status: "derived",
    present: true,
    categories: [1],
  });
});

it("把流通股本和事件标记合并为量价证据", () => {
  const result = buildDailyEventCoverage(
    "sh600000",
    [bar("2020-01-01", 10)],
    [],
    ["2020-01-01"],
  );
  const evidence = mergeVolumeEvidence(
    {
      "2020-01-01": {
        date: "2020-01-01",
        availableDate: "2020-01-01",
        availableAt: "2020-01-01T15:00:00+08:00",
        source: "fixture",
        floatShares: 1000,
        volumeUnit: "share",
      },
    },
    result,
  );
  expect(evidence["2020-01-01"]).toMatchObject({
    floatShares: 1000,
    suspension: false,
    resumption: false,
  });
});
