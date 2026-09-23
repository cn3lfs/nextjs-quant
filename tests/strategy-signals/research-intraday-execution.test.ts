import { expect, it } from "vitest";
import {
  intradayExecutionInputsSchema,
  intradayExecutionEvidence,
  intradayEntryPolicy,
  intradayExitPolicy,
  intradaySessionActive,
  type IntradayExecutionId,
} from "../../src/lib/research/technical/research-intraday-execution";
import { growthIntradayTemplate } from "../../src/lib/research/factors/research-growth-intraday";
import {
  researchGrowthIntraday,
  growthMinuteTimes,
  growthIntradayEntries,
} from "../../src/server/strategies/canslim/research-growth-intraday";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../../src/lib/research/strategy-research";
import { researchPortfolio } from "../../src/server/backtest/research-portfolio";
import breakout from "../fixtures/breakout-valid.json";
import { runStrategyResearch } from "../../src/server/backtest/research-run";
import type { ResearchDataset } from "../../src/server/backtest/research-dataset";
import { researchMarketEvidenceSchema } from "../../src/lib/research/factors/research-market-evidence";
import { researchMethodSnapshot } from "../../src/server/research/research-method";

function fixture(id: IntradayExecutionId) {
  const daily = Array.from({ length: 12 }, (_, i) => ({
    date: `2022-11-${10 + i}`,
    open: 100,
    high: 110,
    low: 80,
    close: 100,
    volume: 4800,
    amount: 480000,
  }));
  const calendar = daily.map((b) => b.date),
    symbol = "sh600000";
  const minutes = daily.flatMap((b) =>
    growthMinuteTimes.map((t) => ({
      ...b,
      date: `${b.date}T${t}:00+08:00`,
      open: 100,
      close: 100,
      high: 101,
      low: 99,
      volume: 100,
    })),
  );
  const inputs = intradayExecutionInputsSchema.parse(
    calendar.map((date) => ({
      symbol,
      date,
      source: "synthetic execution evidence",
      version: "fixture-1",
      effectiveAt: `${date}T09:00:00+08:00`,
      availableAt: `${date}T09:00:00+08:00`,
      capturedAt: `${date}T15:00:00+08:00`,
      manualCoverage: true,
      session: {
        coverageComplete: true,
        intervals: [
          { from: `${date}T09:30:00+08:00`, to: `${date}T11:30:00+08:00` },
          { from: `${date}T13:00:00+08:00`, to: `${date}T14:57:00+08:00` },
        ],
        halts: [],
      },
      negativeNews: {
        coverageComplete: true,
        negative: false,
        publishedAt: `${date}T09:00:00+08:00`,
      },
      highPosition: true,
      haltRisk: false,
      events: { coverageComplete: true, through: calendar.at(-1), rows: [] },
    })),
  );
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: calendar[0],
    end: calendar[5],
    validationStart: calendar[5],
    holdingDays: 60,
    initialCapital: 1000000,
    risk: { fraction: 0.02, maxWeight: 1 },
    management: {
      ...growthIntradayTemplate(id),
      intradayExecutionInputs: inputs,
    },
    costs: {
      commissionBps: 0,
      minimumCommission: 0,
      sellTaxBps: 0,
      slippageBps: 0,
    },
  });
  const event: ResearchEvent = {
    symbol,
    observedDate: calendar[0]!,
    endpointDate: calendar[0]!,
    key: "synthetic baseline",
    strategyVersion: "fixture",
    partition: "development",
    evidence: "synthetic confirmed event",
  };
  const rule = {
    evidence: "synthetic rules",
    minimumBuy: 100,
    buyStep: 100,
    maximumOrder: 100000,
    minimumSell: 100,
    sellStep: 100,
    maximumSell: 100000,
    sellOddLotAll: true,
    tradable: true,
    limitUp: 120,
    limitDown: 80,
  };
  const run = () => {
    const d = new Map([[symbol, daily]]);
    return researchGrowthIntraday(
      spec,
      [event],
      calendar,
      d,
      new Map([[symbol, minutes]]),
      () => rule,
      researchPortfolio(spec, [], calendar, d, () => rule),
    );
  };
  const day = (n: number) =>
    minutes.filter((b) => b.date.startsWith(calendar[n]!));
  return {
    spec,
    event,
    rule,
    daily,
    calendar,
    minutes,
    run,
    day,
    inputs: spec.management!.intradayExecutionInputs!,
  };
}
it("market stop can gap below trigger while stop-limit preserves an unfilled request until recovery", () => {
  for (const id of ["RK-X-market-stop", "RK-X-stop-limit1"] as const) {
    const f = fixture(id);
    const rows = f.day(2);
    rows.forEach((b) =>
      Object.assign(b, { open: 90, close: 90, high: 96, low: 89 }),
    );
    rows[0]!.open = 100;
    rows[0]!.high = 101;
    for (const b of rows.slice(12))
      Object.assign(b, { open: 96, close: 96, high: 97, low: 95 });
    const t = f.run().trades[0]!;
    expect(t.sales![0]!.price).toBe(id === "RK-X-market-stop" ? 90 : 96);
    expect(t.sales![0]!.date.slice(11, 16)).toBe(
      id === "RK-X-market-stop" ? "09:35" : "10:30",
    );
    expect(t.sales![0]!.triggerDate).toBe(`${f.calendar[2]}T09:35:00+08:00`);
  }
});
it("2R target limit does not fill from high-only touches or a later open below the limit", () => {
  const f = fixture("RK-X-profit-limit"),
    rows = f.day(2);
  rows[0]!.high = 111;
  Object.assign(rows[12]!, { open: 111, high: 112, low: 110, close: 111 });
  const t = f.run().trades[0]!;
  expect(t.sales![0]!.price).toBe(111);
  expect(t.sales![0]!.date.slice(11, 16)).toBe("10:30");
  expect(t.sales![0]!.reason).toContain("2R");
});
it.each(["RK-X-manual", "RK-X-t0-old"] as const)(
  "%s consumes a timestamped manual trigger; rotation follows actual old-lot sale",
  (id) => {
    const f = fixture(id),
      date = f.calendar[2]!;
    f.inputs.push({
      ...f.inputs[2]!,
      effectiveAt: `${date}T09:58:00+08:00`,
      availableAt: `${date}T10:00:00+08:00`,
      manual: {
        id: "frozen-click",
        at: `${date}T09:58:00+08:00`,
        price: 100,
        action: id === "RK-X-t0-old" ? "rotate" : "exit",
      },
    });
    const r = f.run();
    expect(r.trades[0]!.sales![0]!.date).toBe(`${date}T10:00:00+08:00`);
    expect(r.trades).toHaveLength(id === "RK-X-t0-old" ? 2 : 1);
    if (id === "RK-X-t0-old") {
      expect(r.trades[1]!.entries![0]!.date).toBe(`${date}T10:05:00+08:00`);
      expect(r.trades[1]!.quantity).toBeLessThanOrEqual(r.trades[0]!.quantity);
      expect(r.trades[1]!.sales).toEqual([]);
    }
  },
);
it("condition orders suppress halted-bar triggers and defer fills to active intervals", () => {
  const f = fixture("RK-X-conditional"),
    date = f.calendar[2]!;
  f.inputs[2]!.session!.halts = [
    { from: `${date}T09:30:00+08:00`, to: `${date}T10:00:00+08:00` },
  ];
  f.day(2).forEach((b) => Object.assign(b, { low: 94 }));
  expect(f.run().trades[0]!.sales![0]!.date).toBe(`${date}T10:05:00+08:00`);
  expect(intradaySessionActive(f.inputs[2]!, `${date}T12:00:00+08:00`)).toBe(
    false,
  );
});
it.each(["RK-X-gap10", "RK-X-limit-budget", "RK-X-halt-cap"] as const)(
  "%s changes funded position, not just its label",
  (id) => {
    const f = fixture(id);
    if (id === "RK-X-halt-cap") f.inputs[1]!.haltRisk = true;
    const t = f.run().trades[0]!;
    expect(t.quantity).toBe(id === "RK-X-gap10" ? 2000 : 1000);
    expect(t.initialStop).toBe(95);
  },
);
it("news at limit-down locks exit until tradable; unknown future news is ignored", () => {
  const f = fixture("RK-X-limit-news"),
    date = f.calendar[2]!;
  f.inputs[2]!.negativeNews!.negative = true;
  Object.assign(f.day(2)[0]!, { close: 80, low: 80 });
  Object.assign(f.day(2)[1]!, { open: 80, close: 80, low: 80, high: 81 });
  const t = f.run().trades[0]!;
  expect(t.sales![0]!.date).toBe(`${date}T09:40:00+08:00`);
  expect(t.sales![0]!.reason).toContain("利空");
});
it("known future five-session event blocks entry, absent coverage reports a data gap", () => {
  const f = fixture("RK-X-event5");
  f.inputs[1]!.events!.rows = [
    {
      date: f.calendar[6]!,
      announcedAt: f.inputs[1]!.availableAt,
      kind: "report",
    },
  ];
  expect(f.run().trades).toEqual([]);
  delete f.inputs[1]!.events;
  expect(f.run().signalGaps!.some((g) => g.reason.includes("已公告"))).toBe(
    true,
  );
});
it("auction queue requires independent final fill proof; five-minute opens cannot invent it", () => {
  const f = fixture("RK-X-auction-queue"),
    date = f.calendar[3]!;
  Object.assign(f.daily[2]!, { open: 80, high: 80, low: 80, close: 80 });
  f.day(2).forEach((b) =>
    Object.assign(b, { open: 80, high: 80, low: 80, close: 80 }),
  );
  expect(f.run().trades[0]!.sales).toEqual([]);
  f.inputs.push({
    ...f.inputs[3]!,
    effectiveAt: `${date}T09:25:00+08:00`,
    availableAt: `${date}T09:25:00+08:00`,
    auction: {
      queueId: "queue-1",
      submittedAt: `${date}T09:20:00+08:00`,
      limitPrice: 80,
      filledQuantity: 500,
      fillPrice: 81,
      filledAt: `${date}T09:25:00+08:00`,
    },
  });
  const t = f.run().trades[0]!;
  expect(t.sales!.map((s) => [s.quantity, s.price])).toEqual([[500, 81]]);
  expect(t.sales![0]!.date).toBe(`${date}T09:25:00+08:00`);
  expect(t.remainingQuantity).toBe(t.quantity - 500);
});
it("all evidence uses unique as-of snapshots and entry policy preserves unknown status", () => {
  const f = fixture("RK-X-limit-budget"),
    r = f.inputs[1]!,
    at = `${r.date}T09:30:00+08:00`;
  expect(intradayExecutionEvidence([r, r], r.symbol, r.date, at)).toBeNull();
  expect(
    intradayExecutionEvidence(
      [{ ...r, availableAt: `${r.date}T10:00:00+08:00` }],
      r.symbol,
      r.date,
      at,
    ),
  ).toBeNull();
  expect(
    intradayEntryPolicy(
      "RK-X-limit-budget",
      null,
      r.date,
      f.calendar,
      at,
      100,
      f.rule,
    ).allow,
  ).toBe(false);
  expect(
    intradayExitPolicy("RK-X-manual", {
      row: null,
      date: r.date,
      calendar: f.calendar,
      at,
      previous: f.day(1)[0],
      entry: 100,
      stop: 95,
      rule: f.rule,
    }).missing,
  ).toContain("人工");
});
it("SW02 last30 reuses dual breakout on a partial candle; final daily prices/volume cannot leak", async () => {
  // Synthetic date-shifted algorithm fixture, not evidence of historical 2022 trading performance.
  const daily = breakout.bars.map((b, i) => ({
    ...b,
    date: new Date(Date.UTC(2010, 0, i + 1)).toISOString().slice(0, 10),
  }));
  const day = daily.at(-1)!,
    calendar = daily.map((b) => b.date);
  const minute = growthMinuteTimes.map((time) => ({
    ...day,
    date: `${day.date}T${time}:00+08:00`,
    volume: day.volume / 42,
  }));
  const spec = researchSpecSchema.parse({
    strategy: "dual-breakout",
    start: daily.at(-2)!.date,
    end: new Date(Date.parse(day.date) + 86400000).toISOString().slice(0, 10),
    validationStart: day.date,
    risk: { fraction: 0.02, maxWeight: 0.2 },
    management: growthIntradayTemplate("SW02-last30"),
  });
  const events = growthIntradayEntries(
    "sh600000",
    daily,
    minute,
    calendar,
    spec,
  );
  expect(events).toHaveLength(1);
  expect(events[0]!.intradayAt).toBe(`${day.date}T14:30:00+08:00`);
  expect(
    growthIntradayEntries(
      "sh600000",
      [...daily.slice(0, -1), { ...day, close: 0.1, volume: 1 }],
      minute,
      calendar,
      spec,
    ),
  ).toEqual(events);
  const weak = minute.map((b) => ({ ...b, volume: 1 }));
  expect(
    growthIntradayEntries("sh600000", daily, weak, calendar, spec),
  ).toEqual([]);
  const next = { ...day, date: spec.end, volume: 1 };
  const bars = [...daily, next];
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "fixture",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: ["sh600000"],
      source: null,
      warning: "synthetic fixture",
    },
    benchmark: { symbol: "sh000001", bars },
    calendar: bars.map((b) => b.date),
    stocks: [
      {
        symbol: "sh600000",
        name: "fixture",
        bars,
        minuteBars: minute,
        hash: "fixture",
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "partial",
    actionSource: null,
    capturedAt: 0,
    hash: "fixture",
    method: researchMethodSnapshot(spec),
  };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "synthetic fixed evidence",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      {
        symbol: "sh600000",
        start: daily[0]!.date,
        end: spec.end,
        evidenceId: "fixture",
      },
    ],
    rows: bars.map((b) => ({
      symbol: "sh600000",
      date: b.date,
      tradable: true,
      limitUp: null,
      limitDown: null,
      minimumBuy: 100,
      buyStep: 100,
      maximumOrder: 100000,
      minimumSell: 100,
      sellStep: 100,
      maximumSell: 100000,
      sellOddLotAll: true,
      evidenceId: "fixture",
    })),
  });
  const native = async (): Promise<never> => {
    throw Error("Unexpected native call");
  };
  const run = await runStrategyResearch(spec, dataset, evidence, native);
  expect(run.partitions[1]!.simulation!.trades[0]!.entries![0]!.date).toBe(
    `${day.date}T14:30:00+08:00`,
  );
  // corporateActionFree is legacy evidence metadata the engine no longer
  // consumes for admission: the gate is now prepareResearchAdjustedCoverage's
  // locally-derived GBBQ price coverage, which this actions-free dataset
  // satisfies regardless of the asserted window. Narrowing the window is
  // therefore inert here. The withheld-execution case it used to assert is
  // now reached through a dataset with no GBBQ source at all
  // (actionCoverage: "missing"), where the external assertion is the only
  // route and its window is checked against the whole prefix — see
  // tests/research-backtest/risk/research-risk-composition.test.ts's shortProof case.
  evidence.corporateActionFree[0]!.start = spec.start;
  const uncovered = await runStrategyResearch(spec, dataset, evidence, native);
  expect(
    uncovered.partitions.flatMap((p) => p.simulation?.trades ?? []),
  ).toEqual(run.partitions.flatMap((p) => p.simulation?.trades ?? []));
});
