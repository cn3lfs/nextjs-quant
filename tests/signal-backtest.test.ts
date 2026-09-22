import { expect, it } from "vitest";
import valid from "./fixtures/breakout-valid.json";
import fake from "./fixtures/breakout-false.json";
import {
  retrospectiveSignals,
  type SignalBacktestInput,
} from "../src/server/backtest/signal-backtest";
import { analyzeBreakout } from "../src/server/strategies/breakout/breakout";
import { ledgerSignals } from "../src/server/monitoring/signal-ledger-engine";
import { horizons, ledgerOutcome } from "../src/lib/signal-ledger";
import { sqlite } from "../src/server/db";
import { recordResearchUsage } from "../src/server/research/research-usage";
import { signalInformation } from "../src/lib/signal-information";

function input(bars = valid.bars): SignalBacktestInput {
  return {
    symbol: "bj920748",
    bars,
    start: bars.at(-10)!.date,
    end: bars.at(-1)!.date,
    days: bars.map((b) => b.date),
    calendarSource: "fixture",
    actions: { dates: [], source: "fixture", coverageEnd: "2030-01-01" },
    completedThrough: bars.at(-1)!.date,
  };
}

it("historical points and signals equal direct prefix evaluation field for field", () => {
  const data = input();
  const result = retrospectiveSignals(data);
  expect(result.rows.length).toBeGreaterThan(0);
  for (const point of result.points) {
    const prefix = data.bars.slice(0, point.index + 1);
    const direct = analyzeBreakout(prefix).latest;
    expect(point).toEqual(direct);
    const signals = ledgerSignals(
      data.symbol,
      point.date,
      prefix,
      {
        status: "no-structure",
        hash: "",
        sourceCommit: "b67f3c6",
        families: [],
      },
      direct,
      undefined,
    ).signals;
    expect(
      result.rows
        .filter((r) => r.observedDate === point.date)
        .map(({ outcomes, ...s }) => s),
    ).toEqual(signals);
  }
  // Known violating core: a 3/5 score does not override failed volume.
  const rejected = retrospectiveSignals(input(fake.bars));
  expect(
    rejected.rows.filter((r) => r.observedDate === fake.bars.at(-1)!.date),
  ).toEqual([]);
});

it("all horizons reuse ledgerOutcome including missing, ex-date, pending and short price signs", () => {
  const base = input();
  const signal = retrospectiveSignals(base).rows.at(-1)!;
  const extra = Array.from({ length: 20 }, (_, i) => ({
    date: new Date(Date.parse(base.end) + 86400000 * (i + 1))
      .toISOString()
      .slice(0, 10),
    open: 30,
    high: 32,
    low: 28,
    close: 31,
    volume: 100,
    amount: 3000,
  }));
  const data = {
    ...base,
    bars: [...base.bars, ...extra],
    days: [...base.days, ...extra.map((b) => b.date)],
    completedThrough: extra.at(-1)!.date,
  };
  for (const variant of [
    data,
    { ...data, actions: { ...data.actions, dates: [extra[0]!.date] } },
    { ...data, bars: data.bars.filter((b) => b.date !== extra[1]!.date) },
    { ...data, completedThrough: base.end },
  ]) {
    const row = retrospectiveSignals(variant).rows.find(
      (r) => r.id === signal.id,
    )!;
    expect(row.outcomes).toEqual(
      horizons.map((h) =>
        ledgerOutcome(
          row,
          h,
          variant.bars,
          variant.days,
          variant.calendarSource,
          variant.actions,
          variant.completedThrough,
        ),
      ),
    );
  }
  const positive = retrospectiveSignals(data).rows.find(
    (r) => r.id === signal.id,
  )!;
  for (const outcome of positive.outcomes) {
    const short = ledgerOutcome(
      { ...positive, direction: "short" },
      outcome.horizon,
      data.bars,
      data.days,
      data.calendarSource,
      data.actions,
      data.completedThrough,
    );
    expect(short).toEqual(outcome);
    expect(short.returnPct).toBeCloseTo((31 / 30 - 1) * 100, 12);
  }
  const reversed = { ...positive, direction: "short" as const };
  expect(signalInformation([reversed]).groups.map((g) => g.valid)).toEqual([
    1, 1, 1,
  ]);
});

it("research and V5 recording add zero rows to every signal ledger table", () => {
  const db = sqlite();
  const names = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'signal_ledger%'",
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
  expect(names.sort()).toEqual([
    "signal_ledger",
    "signal_ledger_baselines",
    "signal_ledger_outcomes",
    "signal_ledger_runs",
  ]);
  const counts = () =>
    names.map(
      (n) =>
        (db.prepare(`SELECT COUNT(*) AS n FROM ${n}`).get() as { n: number }).n,
    );
  const before = counts();
  const data = input();
  const result = retrospectiveSignals(data);
  signalInformation(result.rows);
  const usage = recordResearchUsage(() => ({
    kind: "sample-research",
    symbols: [data.symbol],
    universeSize: 1,
    range: { start: data.start, end: data.end },
    candidateCount: result.evaluated,
    config: { kind: "w7-test" },
  }));
  expect(usage?.candidateCount).toBe(10);
  expect(counts()).toEqual(before);
});

it("a confirmed historical short keeps the positive price return through V3", () => {
  const bars = valid.bars.map((b) => ({
    ...b,
    open: 1000 - b.open,
    high: 1000 - b.low,
    low: 1000 - b.high,
    close: 1000 - b.close,
  }));
  const base = input(bars);
  const future = Array.from({ length: 20 }, (_, i) => ({
    date: new Date(Date.parse(base.end) + 86400000 * (i + 1))
      .toISOString()
      .slice(0, 10),
    open: 970,
    high: 985,
    low: 960,
    close: 980,
    volume: 100,
    amount: 97000,
  }));
  const result = retrospectiveSignals({
    ...base,
    bars: [...bars, ...future],
    days: [...base.days, ...future.map((b) => b.date)],
    completedThrough: future.at(-1)!.date,
  });
  const row = result.rows.find((r) => r.observedDate === base.end)!;
  expect(row.direction).toBe("short");
  expect(JSON.parse(row.evidence)).toEqual(analyzeBreakout(bars).latest!.short);
  const { outcomes, ...signal } = row;
  const { outcomes: pending, ...original } = retrospectiveSignals(
    base,
  ).rows.find((r) => r.id === row.id)!;
  expect(signal).toEqual(original);
  expect(pending.every((o) => !o.settled)).toBe(true);
  for (const outcome of outcomes)
    expect(outcome.returnPct).toBeCloseTo((980 / 970 - 1) * 100, 12);
  for (const group of signalInformation([row]).groups) {
    expect(group.direction).toBe("short");
    expect(group.valid).toBe(1);
    expect(group.icMean).toBeNull();
  }
});
