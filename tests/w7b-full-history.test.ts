import { expect, it } from "vitest";
import valid from "./fixtures/breakout-valid.json";
import {
  retrospectiveSignals,
  type SignalBacktestInput,
} from "../src/server/backtest/signal-backtest";
import {
  bonusAdjustedSignals,
  AdjustmentUnavailableError,
} from "../src/server/backtest/bonus-adjusted-signals";
import {
  actionReview,
  type BacktestActions,
} from "../src/server/backtest/backtest-actions";
import { analyzeBreakout } from "../src/server/strategies/breakout/breakout";
import { ledgerOutcome, type LedgerRow } from "../src/lib/signal-ledger";
import { benchmarkStratification } from "../src/server/backtest/signal-backtest-benchmark";
import { signalInformation } from "../src/lib/signal-information";
import type { Bar } from "../src/lib/domain";
import { sqlite } from "../src/server/db";

const event = (
  date: string,
  patch: Partial<BacktestActions["events"][number]> = {},
) => ({
  date,
  category: 1,
  name: "送转",
  dividend: 0,
  rightsPrice: 0,
  bonusRatio: 1,
  rightsRatio: 0,
  ...patch,
});
const review = (bars: Bar[], events: BacktestActions["events"]) =>
  actionReview({ symbol: "sh600000", source: "tdx-local", bars }, events, {
    file: "fixture",
    modified: 1,
    fetchedAt: 1,
  });
function input(): SignalBacktestInput {
  const split = valid.bars.length - 8;
  const bars = valid.bars.map((b, i) => ({
    ...b,
    open: b.open / (i >= split ? 2 : 1),
    high: b.high / (i >= split ? 2 : 1),
    low: b.low / (i >= split ? 2 : 1),
    close: b.close / (i >= split ? 2 : 1),
  }));
  return {
    symbol: "sh600000",
    bars,
    start: bars.at(-10)!.date,
    end: bars.at(-1)!.date,
    days: bars.map((b) => b.date),
    calendarSource: "fixture",
    actions: { dates: [], source: "fixture", coverageEnd: "2030-01-01" },
    completedThrough: bars.at(-1)!.date,
    adjustment: "backward",
    corporateActions: review(bars, [event(bars[split]!.date)]),
  };
}
it("W7b split-adjusted points restore the existing engine and differ from W7 raw signals; returns remain raw", () => {
  const data = input();
  const result = retrospectiveSignals(data);
  const raw = retrospectiveSignals({ ...data, adjustment: "none" });
  expect(result.rows.length).toBeGreaterThan(0);
  expect(
    result.rows.map((r) => [r.observedDate, r.direction, r.score]),
  ).not.toEqual(raw.rows.map((r) => [r.observedDate, r.direction, r.score]));
  expect(bonusAdjustedSignals(data.bars, data.corporateActions).bars).toEqual(
    valid.bars,
  );
  for (const point of result.points)
    expect(point).toEqual(
      analyzeBreakout(valid.bars.slice(0, point.index + 1)).latest,
    );
  for (const row of result.rows)
    for (const outcome of row.outcomes)
      expect(outcome).toEqual(
        ledgerOutcome(
          row,
          outcome.horizon,
          data.bars,
          data.days,
          data.calendarSource,
          data.actions,
          data.completedThrough,
        ),
      );
  // Extend raw prices: 10 open to 11 close means +10%, even though signal prices doubled.
  const tail = Array.from({ length: 20 }, (_, i) => ({
    date: new Date(Date.parse(data.end) + (i + 1) * 86400000)
      .toISOString()
      .slice(0, 10),
    open: 10,
    high: 12,
    low: 9,
    close: 11,
    volume: 100,
    amount: 1000,
  }));
  const bars = [...data.bars, ...tail];
  const extended = {
    ...data,
    bars,
    days: bars.map((b) => b.date),
    completedThrough: tail.at(-1)!.date,
    corporateActions: review(bars, data.corporateActions!.events),
  };
  const last = retrospectiveSignals(extended).rows.find(
    (r) => r.observedDate === data.end,
  )!;
  expect(last.outcomes.map((o) => o.returnPct)).toEqual([
    expect.closeTo(10, 10),
    expect.closeTo(10, 10),
    expect.closeTo(10, 10),
  ]);
});
it.each(["rights", 11, 12, 13, 14] as const)(
  "rejects whole input including warmup and tail: %s",
  (category) => {
    for (const index of [0, valid.bars.length - 1]) {
      const data = input();
      data.corporateActions = review(data.bars, [
        event(
          data.bars[index]!.date,
          category === "rights" ? { rightsRatio: 0.1 } : { category },
        ),
      ]);
      data.end = data.bars.at(-3)!.date;
      try {
        retrospectiveSignals(data);
        throw new Error("must reject");
      } catch (error) {
        expect(error).toBeInstanceOf(AdjustmentUnavailableError);
        expect(
          (error as AdjustmentUnavailableError).diagnostics.blockedEvents.count,
        ).toBe(1);
      }
    }
  },
);
it("missing action source rejects before empty observation range can bypass W1", () => {
  const data = input();
  expect(() =>
    retrospectiveSignals({
      ...data,
      start: "2040-01-01",
      corporateActions: undefined,
    }),
  ).toThrow(AdjustmentUnavailableError);
});
it("adjusted path writes no signal ledger tables", () => {
  const db = sqlite();
  const names = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'signal_ledger%'",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  const counts = () =>
    names.map(
      (n) =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${n}`).get() as { n: number }).n,
    );
  const before = counts();
  retrospectiveSignals(input());
  expect(counts()).toEqual(before);
});
it("excess reuses identical holding dates, never negates short, preserves absolute IC and bin membership with missing benchmark", () => {
  const days = Array.from({ length: 35 }, (_, i) =>
    new Date(Date.UTC(2007, 0, 1 + i)).toISOString().slice(0, 10),
  );
  const bars = days.map((date) => ({
    date,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 100,
    amount: 10000,
  }));
  const base = retrospectiveSignals(input()).rows.at(-1)!;
  const rows: LedgerRow[] = Array.from({ length: 60 }, (_, i) => {
    const row = {
      ...base,
      id: String(i),
      symbol: `stock${i}`,
      observedDate: i < 30 ? days[0]! : days[14]!,
      direction: "short" as const,
      score: i % 3,
    };
    return {
      ...row,
      outcomes: ([5, 10, 20] as const).map((h) => ({
        ...ledgerOutcome(
          row,
          h,
          bars,
          days,
          "fixture",
          { dates: [], source: "fixture", coverageEnd: days.at(-1)! },
          days.at(-1)!,
        ),
        returnPct: (i % 3) + 10,
      })),
    };
  });
  const result = benchmarkStratification(
    rows,
    bars.slice(14),
    days,
    "fixture",
    days.at(-1)!,
  );
  expect(result.information).toEqual(signalInformation(rows));
  for (const g of result.groups) {
    expect(g.bins.reduce((n, b) => n + b.count, 0)).toBe(60);
    expect(g.bins.reduce((n, b) => n + b.excessCount, 0)).toBe(30);
    expect(g.bins.reduce((n, b) => n + b.excessMissing, 0)).toBe(30);
  }
  expect(
    result.observations
      .filter((o) => o.observedDate < days[14]!)
      .every(
        (o) =>
          o.excess === null && o.reasons.some((r) => r.includes("历史未覆盖")),
      ),
  ).toBe(true);
  for (const o of result.observations.filter((o) => o.excess !== null)) {
    expect(o.benchmarkReturn).toBeCloseTo(5, 10);
    expect(o.excess).toBeCloseTo(o.absolute! - 5, 10);
  }
  const missing = benchmarkStratification(
    rows,
    bars.filter((b) => b.date !== days[16]),
    days,
    "fixture",
    days.at(-1)!,
  );
  expect(
    missing.observations
      .filter((o) => o.observedDate === days[14]!)
      .every(
        (o) =>
          o.excess === null && o.reasons.some((r) => r.includes("行情缺失")),
      ),
  ).toBe(true);
});

it("A slice of full B equals direct A with the same full-history warmup", () => {
  const data = input();
  const full = retrospectiveSignals({ ...data, start: data.bars[0]!.date });
  expect(full.rows.filter((row) => row.observedDate >= data.start)).toEqual(
    retrospectiveSignals(data).rows,
  );
  expect(full.points.filter((point) => point.date >= data.start)).toEqual(
    retrospectiveSignals(data).points,
  );
});
