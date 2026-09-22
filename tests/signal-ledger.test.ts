import { beforeAll, afterAll, expect, it, vi } from "vitest";
import { prepareCzscTestRuntime } from "./helpers/czsc-runtime";
import Database from "better-sqlite3";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import valid from "./fixtures/breakout-valid.json";
import { migrate } from "../src/server/db/migrations";
import { SignalLedgerStore } from "../src/server/monitoring/signal-ledger-store";
import {
  runSignalLedger,
  localLedgerActions,
  type LedgerDependencies,
} from "../src/server/monitoring/signal-ledger-job";
import { analyzeCzsc, closeCzsc } from "../src/server/strategies/chan/czsc";
import { analyzeBreakout } from "../src/server/strategies/breakout/breakout";
import { ledgerSignals } from "../src/server/monitoring/signal-ledger-engine";
import {
  aggregateLedger,
  ledgerOutcome,
  type LedgerSignal,
  type ActionEvidence,
} from "../src/lib/signal-ledger";
import { SignalLedgerView } from "../src/components/signal-ledger-view";
import type { Bar } from "../src/lib/domain";
import type { CzscResult } from "../src/lib/czsc";

const databases: Database.Database[] = [];
// Own the existing M3 runtime prerequisite so this case also runs independently
// in a checkout without generated runtime files. No alternative engine/worker.
beforeAll(prepareCzscTestRuntime);
function store() {
  const db = new Database(":memory:");
  databases.push(db);
  migrate(db);
  return new SignalLedgerStore(db);
}
afterAll(async () => {
  databases.forEach((db) => db.close());
  await closeCzsc();
});
const day = "2025-03-07";
const nextDays = [
  "2025-03-10",
  "2025-03-11",
  "2025-03-12",
  "2025-03-13",
  "2025-03-14",
  "2025-03-17",
  "2025-03-18",
  "2025-03-19",
  "2025-03-20",
  "2025-03-21",
  "2025-03-24",
  "2025-03-25",
  "2025-03-26",
  "2025-03-27",
  "2025-03-28",
  "2025-03-31",
  "2025-04-01",
  "2025-04-02",
  "2025-04-03",
  "2025-04-07",
];
const days = [day, ...nextDays];
const future: Bar[] = nextDays.map((date, i) => ({
  date,
  open: 100,
  high: 150,
  low: 80,
  close: i === 4 ? 110 : i === 9 ? 90 : 100,
  volume: 100,
  amount: 10000,
}));
const clear: ActionEvidence = {
  dates: [],
  source: "受控fixture完整事件日历",
  coverageEnd: "2025-12-31",
};
const signal: LedgerSignal = {
  id: "fixture",
  strategy: "dual-breakout",
  symbol: valid.symbol,
  observedDate: day,
  endpointDate: day,
  direction: "long",
  quality: "4/5",
  score: 4,
  evidence: "fixture",
  invalidation: "fixture",
  snapshotHash: "fixture",
  strategyVersion: "dual-breakout-1",
  dllVersion: null,
  source: "tdx-local",
};
const clock = (date: string, time = "15:05") =>
  Date.parse(`${date}T${time}:00+08:00`);
const emptyCzsc: CzscResult = {
  status: "no-structure",
  hash: "dll",
  sourceCommit: "b67f3c6",
  families: [],
};

it("controlled E2E uses real M3/M5 engines, migrated SQLite, forward fill and the actual page aggregation", async () => {
  const s = store();
  let bars = [...valid.bars];
  const czsc = await analyzeCzsc(bars, true);
  const deps: LedgerDependencies = {
    calendar: async () => ({
      days,
      source: "fixture交易日历",
      hash: "fixture",
    }),
    universe: async () => [valid.symbol],
    bars: async () => bars,
    czsc: async (input) => (input.at(-1)?.date === day ? czsc : emptyCzsc),
    breakout: async () => ({
      candidates: [
        { symbol: valid.symbol, point: analyzeBreakout(bars).latest! },
      ],
      errors: [],
    }),
    actions: async () => () => clear,
  };
  const first = await runSignalLedger(s, deps, clock(day));
  expect(first).toMatchObject({ status: "complete", total: 1, scanned: 1 });
  const row = s.rows().find((r) => r.strategy === "dual-breakout")!;
  expect(row).toMatchObject({
    observedDate: day,
    quality: "4/5",
    direction: "long",
    dllVersion: null,
  });
  expect(row.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  expect(row.outcomes.every((o) => o.returnPct === null && !o.settled)).toBe(
    true,
  );
  const baseline = JSON.stringify(s.rows());
  expect(await runSignalLedger(s, deps, clock(day))).toEqual(first);
  expect(JSON.stringify(s.rows())).toBe(baseline);
  bars = [...valid.bars, ...future.slice(0, 5)];
  await runSignalLedger(s, deps, clock(nextDays[4]!));
  const filled = s.rows().find((r) => r.id === row.id)!;
  expect(filled.outcomes[0]).toMatchObject({
    entry: 100,
    exit: 110,
    settled: true,
    reasons: [],
  });
  expect(filled.outcomes[0]!.returnPct).toBeCloseTo(10);
  const saved = JSON.stringify(filled.outcomes[0]);
  // Even a correction to the old source, plus a large future move, cannot rewrite T+5.
  bars = [...valid.bars, ...future];
  bars[valid.bars.length + 4] = { ...future[4]!, close: 1 };
  await runSignalLedger(s, deps, clock(nextDays[19]!));
  expect(
    JSON.stringify(s.rows().find((r) => r.id === row.id)!.outcomes[0]),
  ).toBe(saved);
  const group = aggregateLedger(s.rows()).find(
    (g) => g.strategy === "dual-breakout" && g.horizon === 5,
  )!;
  expect(group).toMatchObject({
    samples: 1,
    valid: 1,
    blanks: 0,
    winRate: 100,
    payoff: null,
  });
  expect(group.median).toBeCloseTo(10);
  const html = renderToStaticMarkup(
    createElement(SignalLedgerView, { rows: s.rows(), runs: s.runs() }),
  );
  expect(html).toContain("非策略业绩");
  expect(html).toContain("10.00%");
  expect(html).toContain("4/5");
  expect(html).toContain("GBBQ 最大事件日期");
  expect(html).toContain("2025-12-31");
  expect(s.runs()[0]?.actionCoverageEnd).toBe("2025-12-31");
});

it("ex dates including entry/exit and unknown coverage blank returns, file coverage bounds absence", () => {
  for (const date of [nextDays[0]!, nextDays[2]!, nextDays[4]!]) {
    const out = ledgerOutcome(
      signal,
      5,
      future,
      days,
      "fixture",
      { ...clear, dates: [date] },
      nextDays[4]!,
    );
    expect(out).toMatchObject({
      settled: true,
      returnPct: null,
      action: "含除权，收益不可比",
    });
    expect(out.reasons).toContain("含除权，收益不可比");
  }
  const unknown = ledgerOutcome(
    signal,
    5,
    future,
    days,
    "fixture",
    { dates: [], source: "GBBQ不可读" },
    nextDays[4]!,
  );
  expect(unknown.returnPct).toBeNull();
  expect(unknown.reasons).toContain("除权状态未知");
  expect(
    ledgerOutcome(
      signal,
      5,
      future,
      days,
      "fixture",
      { ...clear, dates: [nextDays[5]!] },
      nextDays[4]!,
    ).returnPct,
  ).toBeCloseTo(10);
});

it("missing/suspended/unfinished bars blank with reasons, and T+N uses market sessions without shifting", () => {
  const early = ledgerOutcome(
    signal,
    5,
    future,
    days,
    "fixture",
    clear,
    nextDays[3]!,
  );
  expect(early).toMatchObject({
    returnPct: null,
    settled: false,
    reasons: ["T+N K线未完成"],
  });
  const missing = ledgerOutcome(
    signal,
    5,
    future.filter((b) => b.date !== nextDays[2]),
    days,
    "fixture",
    clear,
    nextDays[9]!,
  );
  expect(missing).toMatchObject({
    returnPct: null,
    settled: true,
    exitDate: nextDays[4],
  });
  expect(missing.reasons).toContain("持有区间行情缺失（可能停牌，不顺延）");
  const suspended = ledgerOutcome(
    signal,
    5,
    future.map((b, i) => (i === 2 ? { ...b, volume: 0 } : b)),
    days,
    "fixture",
    clear,
    nextDays[9]!,
  );
  expect(suspended.returnPct).toBeNull();
  expect(suspended.reasons).toContain("持有区间停牌或零成交");
  expect(
    ledgerOutcome(
      signal,
      20,
      future,
      days.slice(0, 10),
      "fixture",
      clear,
      nextDays[9]!,
    ).reasons,
  ).toContain("T+N未到期或交易日历不足");
  expect(
    ledgerOutcome(signal, 5, [], days, "fixture", clear, nextDays[9]!).reasons,
  ).toContain("入场或出场价格缺失/非法");
  expect(
    ledgerOutcome(
      signal,
      5,
      future,
      days.slice(1),
      "fixture",
      clear,
      nextDays[9]!,
    ).reasons,
  ).toContain("交易日历缺少信号日");
});

it("both directions use price change; median, zero denominator and average win/loss are explicit", () => {
  const rows = [10, -5, 0, 30].map((value, i) => ({
    ...signal,
    id: String(i),
    outcomes: [
      {
        ...ledgerOutcome(
          signal,
          5,
          future,
          days,
          "fixture",
          clear,
          nextDays[4]!,
        ),
        returnPct: value,
      },
    ],
  }));
  const g = aggregateLedger(rows)[0]!;
  expect(g).toMatchObject({
    samples: 4,
    valid: 4,
    blanks: 0,
    median: 5,
    winRate: 50,
    payoff: 4,
  });
  expect(
    ledgerOutcome(
      { ...signal, direction: "short" },
      5,
      future,
      days,
      "fixture",
      clear,
      nextDays[4]!,
    ).returnPct,
  ).toBeCloseTo(10);
});

it("first CZSC scan seeds old endpoints; newly observed points/quality are recorded today only once", () => {
  const c: CzscResult = {
    ...emptyCzsc,
    status: "structure",
    families: [
      {
        config: 0,
        points: [],
        centers: [],
        movements: [],
        qualities: [],
        divergences: [],
        signals: [{ index: 0, date: "2025-03-06", kind: 1, quality: 0 }],
      },
    ],
  };
  const first = ledgerSignals(
    valid.symbol,
    day,
    valid.bars,
    c,
    null,
    undefined,
  );
  expect(first.signals).toEqual([]);
  const changed = structuredClone(c);
  changed.families[0]!.signals[0]!.quality = 1;
  const next = ledgerSignals(
    valid.symbol,
    nextDays[0]!,
    valid.bars,
    changed,
    null,
    first,
  );
  expect(next.signals).toHaveLength(1);
  expect(next.signals[0]).toMatchObject({
    observedDate: nextDays[0],
    endpointDate: "2025-03-06",
    quality: "1",
    dllVersion: "dll",
  });
  expect(
    ledgerSignals(valid.symbol, nextDays[1]!, valid.bars, changed, null, next)
      .signals,
  ).toEqual([]);
});

it("daily scheduler needs no subscriptions; refuses preclose/non-session/stale bars and isolates future input", async () => {
  const s = store();
  const evaluate = vi.fn(async (_bars: Bar[]) => emptyCzsc);
  const deps: LedgerDependencies = {
    calendar: async () => ({ days, source: "fixture", hash: null }),
    universe: async () => [valid.symbol],
    bars: async () => [...valid.bars, ...future],
    czsc: evaluate,
    breakout: async () => ({ candidates: [], errors: [] }),
    actions: async () => () => clear,
  };
  await runSignalLedger(s, deps, clock(day, "15:04"));
  await runSignalLedger(s, deps, clock("2025-03-08"));
  expect(evaluate).not.toHaveBeenCalled();
  await runSignalLedger(s, deps, clock(day));
  expect(evaluate.mock.calls[0]![0].at(-1)?.date).toBe(day);
  expect(s.db.prepare("SELECT COUNT(*) n FROM records").get()).toEqual({
    n: 0,
  });
  const stale = store();
  await runSignalLedger(
    stale,
    { ...deps, bars: async () => valid.bars },
    clock(nextDays[0]!),
  );
  expect(stale.rows()).toEqual([]);
  expect(stale.runs()[0]!.errors[0]!.reason).toContain("过旧");
});

it("migration preserves old tables/records and repeated migrations and settled writes are idempotent", () => {
  const s = store();
  s.db.prepare("INSERT INTO records VALUES ('old','settings','{}',1)").run();
  migrate(s.db);
  expect(
    s.db.prepare("SELECT payload FROM records WHERE id='old'").get(),
  ).toEqual({ payload: "{}" });
  s.record(signal.symbol, day, [], [signal]);
  s.record(signal.symbol, day, [], [signal]);
  expect(s.rows()).toHaveLength(1);
  const out = ledgerOutcome(
    signal,
    5,
    future,
    days,
    "fixture",
    clear,
    nextDays[4]!,
  );
  s.outcome(signal.id, out);
  s.outcome(signal.id, { ...out, returnPct: 999 });
  expect(s.rows()[0]!.outcomes[0]).toEqual(out);
});

it("readable market-wide GBBQ covers symbols with no events; stale and unavailable files remain unknown", async () => {
  const event = { date: "2025-03-14", category: 2, name: "送配股上市" };
  const module = await import("../src/server/data-sources/tdx/tdx-gbbq");
  const read = vi.spyOn(module, "readGbbq");
  try {
    read.mockResolvedValue({
      path: "fixture/gbbq",
      modified: 1,
      events: new Map([["sh600000", [event]]]),
    });
    const actions = await localLedgerActions("fixture");
    const absence = actions(signal.symbol);
    expect(absence).toMatchObject({ dates: [], coverageEnd: nextDays[4] });
    const result = ledgerOutcome(
      signal,
      5,
      future,
      days,
      "fixture",
      absence,
      nextDays[4]!,
    );
    expect(result.action).toBe("区间无除权");
    expect(result.returnPct).toBeCloseTo(10);
    expect(result.actionCoverageEnd).toBe(nextDays[4]);
    const stale = ledgerOutcome(
      signal,
      10,
      future,
      days,
      "fixture",
      absence,
      nextDays[9]!,
    );
    expect(stale.action).toBe("除权状态未知");
    expect(stale.returnPct).toBeNull();
    read.mockResolvedValue({
      path: "fixture/gbbq",
      modified: 1,
      events: new Map([[signal.symbol, [{ ...event, category: 1 }]]]),
    });
    const hit = ledgerOutcome(
      signal,
      5,
      future,
      days,
      "fixture",
      (await localLedgerActions("fixture"))(signal.symbol),
      nextDays[4]!,
    );
    expect(hit).toMatchObject({
      action: "含除权，收益不可比",
      returnPct: null,
    });
    for (const reason of ["ENOENT", "gbbq 文件不完整"]) {
      read.mockRejectedValue(new Error(reason));
      const unknown = ledgerOutcome(
        signal,
        5,
        future,
        days,
        "fixture",
        (await localLedgerActions("fixture"))(signal.symbol),
        nextDays[4]!,
      );
      expect(unknown).toMatchObject({
        action: "除权状态未知",
        returnPct: null,
        actionCoverageEnd: null,
      });
    }
  } finally {
    read.mockRestore();
  }
});

it("progress is persisted during work; cancellation keeps committed rows and prevents automatic restart", async () => {
  const s = store();
  const evaluate = vi.fn(async () => emptyCzsc);
  const deps: LedgerDependencies = {
    calendar: async () => ({ days, source: "fixture", hash: null }),
    universe: async () => ["sh600000", "sh600001"],
    bars: async () => valid.bars,
    czsc: evaluate,
    breakout: async () => ({ candidates: [], errors: [] }),
    actions: async () => () => clear,
  };
  const phases: string[] = [];
  const result = await runSignalLedger(s, deps, clock(day), (progress) => {
    expect(s.run(day)?.scanned).toBe(progress.scanned);
    phases.push(progress.phase!);
    if (progress.scanned === 1) s.cancel(day);
  });
  expect(result?.status).toBe("cancelled");
  expect(phases).toContain("双突破全市场计算");
  expect(phases).toContain("扫描全市场信号");
  expect(phases.at(-1)).toBe("已取消");
  expect(s.baseline("sh600000")?.date).toBe(day);
  expect(s.baseline("sh600001")).toBeUndefined();
  const calls = evaluate.mock.calls.length;
  await runSignalLedger(s, deps, clock(day));
  expect(evaluate).toHaveBeenCalledTimes(calls);
});
