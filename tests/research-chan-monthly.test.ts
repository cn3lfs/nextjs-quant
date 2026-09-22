import { expect, it } from "vitest";
import type { Snapshot } from "../src/lib/domain";
import { researchChanMonthlyInput } from "../src/server/strategies/chan/research-chan-monthly";
const days = Array.from({ length: 60 }, (_, i) =>
  new Date(Date.UTC(2020, 0, i + 1)).toISOString().slice(0, 10),
).filter((d) => ![0, 6].includes(new Date(d).getUTCDay()));
const snapshot: Snapshot = {
  id: "monthly-fixture",
  symbol: "sh600000",
  period: "day",
  adjustment: "none",
  source: "fixture",
  createdAt: 0,
  hash: "fixed",
  bars: days.map((date, i) => ({
    date,
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 100 + i,
    amount: 1000,
  })),
};
const calendar = {
  days,
  source: "fixture-calendar",
  hash: "fixed",
  availableAt: "2019-12-31T15:00:00+08:00",
};
it("CH13 adapter uses complete real monthly aggregates and no unfinished month or weekly substitute", async () => {
  let count = 0;
  const run = await researchChanMonthlyInput(
    snapshot,
    calendar,
    "2020-02-14",
    async (bars, anchor) => {
      expect(anchor).toBe(3);
      count++;
      expect(bars).toHaveLength(1);
      expect(bars[0]!.date).toBe("2020-01-31");
      return {
        status: "no-structure",
        sourceCommit: "b67f3c6",
        hash: "fixture",
        families: [],
      };
    },
  );
  expect(run.status).toBe("input-ready");
  expect(count).toBe(1);
  expect(run.reason).toContain("不产入场");
  await expect(
    researchChanMonthlyInput(
      { ...snapshot, period: "week" as Snapshot["period"] },
      calendar,
      "2020-02-14",
      async () => {
        throw new Error("not called");
      },
    ),
  ).rejects.toThrow("日线");
});
it("CH13 rejects missing days, entire missing months and late calendars without invoking DLL", async () => {
  const noCall = async () => {
    throw new Error("must not invoke");
  };
  const missing = {
    ...snapshot,
    bars: snapshot.bars.filter((b) => b.date !== "2020-01-15"),
  };
  expect(
    (await researchChanMonthlyInput(missing, calendar, "2020-02-14", noCall))
      .status,
  ).toBe("missing");
  expect(
    (
      await researchChanMonthlyInput(
        snapshot,
        { ...calendar, availableAt: "2021-01-01T15:00:00+08:00" },
        "2020-02-14",
        noCall,
      )
    ).status,
  ).toBe("missing");
});

it("CH13 detects an entirely absent last completed month", async () => {
  const january = {
    ...snapshot,
    bars: snapshot.bars.filter((b) => b.date.startsWith("2020-01")),
  };
  const result = await researchChanMonthlyInput(
    january,
    calendar,
    "2020-03-02",
    async () => {
      throw new Error("must not invoke");
    },
  );
  expect(result).toMatchObject({ status: "missing", reason: "月线整月缺失" });
});
