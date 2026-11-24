import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { expect, it, vi } from "vitest";
import { runPortfolio, type PortfolioRequest } from "quant-backtest";
import { readStableFinancialFile } from "tstdx/local";
import { researchExecutionCosts } from "trading-strategy-core/costs";
import {
  readGp29Evidence,
  resolveSessionEvidence,
  type SuspensionAnnouncement,
  type Gp29Evidence,
} from "~/server/research/diagnose/session-evidence";
import {
  lifecycleDailyEvidence,
  scoreLifecycleResult,
  summarizePortfolioSuspensions,
} from "~/server/research/lifecycle-score";

vi.mock("tstdx/local", async (importOriginal) => ({
  ...(await importOriginal<typeof import("tstdx/local")>()),
  readStableFinancialFile: vi.fn(),
}));

const symbol = "sh688981";
const resume = "2025-09-09";
const gap = [
  "2025-09-01",
  "2025-09-02",
  "2025-09-03",
  "2025-09-04",
  "2025-09-05",
  "2025-09-08",
];
const asOf = "2025-10-01T10:00:00+08:00";
// Independent synthetic open-session axis, long enough for annualized Calmar.
const calendar: string[] = [];
for (let t = Date.parse("2025-09-30"); calendar.length < 940; t -= 86400000) {
  const date = new Date(t);
  if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
    calendar.unshift(date.toISOString().slice(0, 10));
}
function bar(date: string, price: number) {
  return {
    date,
    open: price,
    close: price,
    high: price + 1,
    low: price - 1,
    volume: 100000,
    amount: 100000 * price,
  };
}
const benchmark = calendar.map((date, i) => bar(date, 100 + (i % 3)));
const bars = calendar
  .filter((d) => !gap.includes(d))
  .map((date, i) =>
    bar(
      date,
      date >= resume ? 14 + (i % 2) : date === "2025-08-29" ? 10 : 10 + (i % 2),
    ),
  );
const sleeves = ["a", "b", "c", "d"];
const root = resolve("synthetic-tdx");
const path = resolve(root, "vipdoc/cw/gpsh688981.dat");
const notice: SuspensionAnnouncement = {
  kind: "announcement",
  symbol,
  sourcePath: "exchange-fixture.json",
  sourceSha256: createHash("sha256").update("notice 42").digest("hex"),
  recordId: "42",
  effectiveDate: gap[0]!,
  throughDate: gap.at(-1)!,
  knownAt: "2025-08-29",
};
function record(group: number, date: number, value: number) {
  const b = Buffer.alloc(13);
  b.writeUInt8(group);
  b.writeUInt32LE(date, 1);
  b.writeFloatLE(value, 5);
  return b;
}
async function load(...records: Buffer[]) {
  const body = Buffer.concat(records);
  vi.mocked(readStableFinancialFile).mockResolvedValueOnce({
    key: "fixture",
    body,
    loadedAt: Date.parse(asOf),
  });
  return readGp29Evidence(root, symbol);
}
async function gp29(n = 6) {
  return load(record(16, 20250909, 123), record(29, 20250909, n));
}
function evidence(
  gp29?: Gp29Evidence,
  source = bars,
  announcements: SuspensionAnnouncement[] = [],
) {
  return resolveSessionEvidence({
    symbol,
    calendar,
    bars: source,
    gp29,
    announcements,
    asOf,
  });
}
function request(
  source = bars,
  certificates?: PortfolioRequest["instruments"][number]["certifiedSuspensions"],
): PortfolioRequest {
  return {
    market: "cn-equity",
    start: calendar[0]!,
    end: calendar.at(-1)!,
    calendar,
    initial: 1_000_000,
    collectDailyDecisionCounts: true,
    costs: researchExecutionCosts("cn-equity", "base"),
    instruments: [
      {
        symbol,
        market: "cn-equity",
        bars: source,
        signalBars: source,
        certifiedSuspensions: certificates,
        execution: {
          tradable: true,
          evidence: "fixture",
          limitUp: null,
          limitDown: null,
        },
      },
    ],
    sleeves: sleeves.map((id) => ({
      id,
      share: 0.25,
      maxPositions: 1,
      riskPerTrade: 0.02,
    })),
    strategies: sleeves.map((id) => ({
      id,
      sleeve: id,
      version: 1,
      market: "cn-equity",
      period: "day",
      universe: { kind: "symbols", symbols: [symbol] },
      entry: { kind: "constant", value: true },
      exit: { stop: { kind: "fixed", fraction: 0.5 } },
      sizing: { kind: "weight", weight: 0.25 },
    })),
  };
}
function metrics(score: ReturnType<typeof scoreLifecycleResult>) {
  const { basis: _basis, ...risk } = score.riskAdjusted!;
  return [score.return, score.excess, score.drawdown, ...Object.values(risk)];
}
function expectMissing(req: PortfolioRequest, date: string) {
  const result = runPortfolio(req);
  expect(
    result.dailyDecisionCounts
      ?.filter((c) => c.date === date)
      .map((c) => c.unknown),
  ).toEqual([1, 1, 1, 1]);
  expect(
    lifecycleDailyEvidence(result, req, calendar).find((d) => d.date === date),
  ).toMatchObject({ missing: true, return: null });
  expect(
    metrics(scoreLifecycleResult(result, req, benchmark, calendar, "fixture")),
  ).toEqual(Array(9).fill(null));
}

it("scores 940 sessions in all three legs and realizes the undivided jump after six unchanged marks in four sleeves", async () => {
  const summary = evidence(await gp29());
  expect(summary.unknownDates).toEqual([]);
  expect(summary.certifiedSuspensions.map((d) => d.date)).toEqual(gap);
  expect(summary.certifiedSuspensions[0]!.sources).toEqual([
    {
      kind: "GP29",
      symbol,
      sourcePath: path,
      sourceSha256: createHash("sha256")
        .update(
          Buffer.concat([record(16, 20250909, 123), record(29, 20250909, 6)]),
        )
        .digest("hex"),
      offset: 13,
      effectiveDate: resume,
      knownAt: new Date(asOf).toISOString(),
      suspendedSessions: 6,
    },
  ]);
  for (const leg of ["base", "doubledCost", "delayed"] as const) {
    const req = request(bars, summary.certifiedSuspensions);
    req.costs = researchExecutionCosts(
      "cn-equity",
      leg === "doubledCost" ? "double-cost" : "base",
    );
    req.signalDelayBars = leg === "delayed" ? 1 : 0;
    const result = runPortfolio(req);
    expect(
      metrics(
        scoreLifecycleResult(result, req, benchmark, calendar, "fixture"),
      ).every(Number.isFinite),
    ).toBe(true);
    expect(result.fills).toHaveLength(4);
    expect(result.fills.filter((fill) => gap.includes(fill.date))).toEqual([]);
    const held = result.positionSnapshots
      .filter((p) => p.date === "2025-08-29")
      .reduce((n, p) => n + p.quantity, 0);
    expect(held).toBeGreaterThan(0);
    const marks = new Map(
      result.equity.map((point) => [point.date, point.equity]),
    );
    const before = marks.get("2025-08-29")!;
    expect(gap.map((d) => marks.get(d))).toEqual(gap.map(() => before));
    expect(marks.get(resume)! - before).toBeCloseTo(
      held * (bars.find((b) => b.date === resume)!.close - 10),
      6,
    );
    const counts = result.dailyDecisionCounts!.filter((c) =>
      gap.includes(c.date),
    );
    expect(counts).toHaveLength(24);
    expect(
      counts.every(
        (c) =>
          c.suspended === 1 && !c.unknown && !c.entries && c.expected === 1,
      ),
    ).toBe(true);
    expect(summarizePortfolioSuspensions(result)).toEqual({
      symbolSuspensionDays: 6,
      portfolioAffectedDays: 6,
    });
  }
});

it("leaves one deleted normal session unknown and nulls every period metric including all three Calmars", async () => {
  const missing = "2025-09-17",
    source = bars.filter((b) => b.date !== missing);
  const summary = evidence(await gp29(), source);
  expect(summary.unknownDates).toEqual([missing]);
  expectMissing(request(source, summary.certifiedSuspensions), missing);
});
it("an explicit notice can certify the gap, while conflicting counts, duplicate GP29, or missing PIT veto it", async () => {
  const snapshot = await gp29();
  if (snapshot.status !== "available") throw new Error("Expected GP29 fixture");
  expect(
    evidence(undefined, bars, [notice]).certifiedSuspensions.map((d) => d.date),
  ).toEqual(gap);
  for (const summary of [
    evidence(await gp29(5), bars, [notice]),
    evidence(await load(record(29, 20250909, 6), record(29, 20250909, 6))),
    evidence(
      {
        ...snapshot,
        records: snapshot.records.map((f) => ({ ...f, knownAt: null })),
      },
      bars,
      [notice],
    ),
    evidence(await gp29(), bars, [{ ...notice, knownAt: null }]),
    evidence(snapshot, bars, [
      { ...notice, effectiveDate: resume, throughDate: resume },
    ]),
    evidence(undefined, bars, [{ ...notice, knownAt: "2025-11-01" }]),
    evidence(await load(Buffer.alloc(12)), bars, [notice]),
    evidence(),
  ]) {
    expect(summary).toEqual({ certifiedSuspensions: [], unknownDates: gap });
    expectMissing(request(bars, summary.certifiedSuspensions), gap[0]!);
  }
});
it("vetoes a conflicting GP29 on the session after the replay cutoff", async () => {
  const source = bars.filter((bar) => bar.date <= resume);
  const facts = await load(record(29, 20250909, 6), record(29, 20250910, 2));
  const summary = resolveSessionEvidence({
    symbol,
    calendar,
    replayEnd: resume,
    bars: source,
    gp29: facts,
    asOf,
  });
  expect(summary).toEqual({ certifiedSuspensions: [], unknownDates: gap });
  const req = request(source, summary.certifiedSuspensions);
  req.end = resume;
  expectMissing(req, gap[0]!);
  expect(
    resolveSessionEvidence({
      symbol,
      calendar,
      replayEnd: gap.at(-1),
      bars,
      gp29: await gp29(),
      asOf,
    }).certifiedSuspensions,
  ).toEqual([]);
});
it("counts overlapping symbols once per portfolio date and a simultaneous unknown still invalidates the period", async () => {
  const first = evidence(await gp29()).certifiedSuspensions;
  const other = "sz000001";
  const second = resolveSessionEvidence({
    symbol: other,
    calendar,
    bars,
    asOf,
    announcements: [{ ...notice, symbol: other }],
  }).certifiedSuspensions;
  const req = request(bars, first);
  req.strategies = req.strategies.map((s) => ({
    ...s,
    universe: { kind: "symbols", symbols: [symbol, other] },
  }));
  const instrument = {
    ...req.instruments[0]!,
    symbol: other,
    certifiedSuspensions: second,
  };
  req.instruments = [req.instruments[0]!, instrument];
  expect(summarizePortfolioSuspensions(runPortfolio(req))).toEqual({
    symbolSuspensionDays: 12,
    portfolioAffectedDays: 6,
  });
  req.instruments = [
    req.instruments[0]!,
    { ...instrument, certifiedSuspensions: [] },
  ];
  expectMissing(req, gap[0]!);
});
it("processes scheduled dividends while a due sell waits for the real resumption open", async () => {
  const req = request(bars, evidence(await gp29()).certifiedSuspensions);
  req.start = "2025-08-26";
  req.strategies = req.strategies.map((s) => ({
    ...s,
    exit: { rule: { kind: "external", id: "exit", side: "exit" } },
  }));
  const instrument = req.instruments[0]!;
  req.instruments = [
    {
      ...instrument,
      actions: [
        {
          date: gap[2]!,
          availableAt: gap[0]!,
          dividend: 0.1,
          bonus: 0,
          evidence: "fixture dividend",
        },
      ],
      external: {
        signals: bars
          .filter((b) => b.date >= req.start)
          .map(({ date }) => ({
            id: "exit",
            date,
            availableAt: date,
            entry: false,
            exit: date === "2025-08-29",
          })),
      },
    },
  ];
  const result = runPortfolio(req);
  const unknown = runPortfolio({
    ...req,
    instruments: req.instruments.map((instrument) => ({
      ...instrument,
      certifiedSuspensions: undefined,
    })),
  });
  expect(result.orders).toEqual(unknown.orders);
  expect(result.rejections).toEqual(unknown.rejections);
  expect(result.fills).toEqual(unknown.fills);
  expect(result.corporateActions).toHaveLength(4);
  for (const action of result.corporateActions) {
    expect(action.date).toBe(gap[2]);
    expect(action.cash).toBeGreaterThan(0);
  }
  expect(
    result.orders
      .filter((o) => o.side === "sell")
      .map((o) => [o.due, o.attempts, o.status]),
  ).toEqual(sleeves.map(() => [gap[0], gap.length + 1, "filled"]));
  expect(
    result.fills.filter((f) => f.side === "sell").map((f) => f.date),
  ).toEqual(sleeves.map(() => resume));
});
it("rejects a prefix before resumption, including when a shorter replay inherits the full evidence", async () => {
  const facts = await gp29(),
    prefix = bars.filter((b) => b.date < resume);
  expect(evidence(facts, prefix, [notice]).certifiedSuspensions).toEqual([]);
  const certificates = evidence(facts).certifiedSuspensions;
  for (const source of [bars, prefix]) {
    const req = request(source, certificates);
    req.end = gap.at(-1)!;
    expectMissing(req, gap[0]!);
  }
});
it("rejects a buy due on a missing open with identical orders, rejections and fills with or without certification", async () => {
  const cert = evidence(await gp29()).certifiedSuspensions;
  const run = (certificates?: typeof cert) => {
    const req = request(bars, certificates);
    req.observationDetail = "full";
    req.strategies = req.strategies.map((s) => ({
      ...s,
      overlay: { symbolWeight: 1 },
    }));
    req.start = "2025-08-29";
    return runPortfolio(req);
  };
  const certified = run(cert),
    unknown = run();
  expect(certified.orders).toEqual(unknown.orders);
  expect(certified.fills).toEqual(unknown.fills);
  expect(certified.rejections).toEqual(unknown.rejections);
  expect(certified.observations).toEqual(unknown.observations);
  expect(certified.bookDecisions).toEqual(unknown.bookDecisions);
  expect(certified.bookDecisions?.some((d) => d.decision.entries.length)).toBe(
    true,
  );
  const stale = certified.orders.filter((o) => o.due === gap[0]);
  expect(stale.map((o) => [o.attempts, o.status])).toEqual(
    sleeves.map(() => [1, "rejected"]),
  );
  for (const o of stale) {
    expect(certified.rejections).toContainEqual({
      orderId: o.id,
      date: gap[0],
      reason: o.reason,
    });
    expect(certified.fills.some((f) => f.orderId === o.id)).toBe(false);
  }
  expect(certified.fills.map((f) => [f.signalAt, f.date])).toEqual(
    sleeves.map(() => [resume, "2025-09-10"]),
  );
  expect(certified.observations.some((o) => gap.includes(o.date))).toBe(false);
});
