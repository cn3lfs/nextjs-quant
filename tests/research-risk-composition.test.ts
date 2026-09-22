import { expect, it, vi } from "vitest";
import {
  riskRepairTemplate,
  riskRepairSchema,
  replayRiskRepair,
  repairRisk,
} from "../src/lib/research-risk-repair";
import {
  riskRouteNames,
  resolveRiskRoute,
  riskRouteSchema,
  diagnoseStops,
  diagnosisDecision,
  diagnosisTemplate,
  type StopDiagnosis,
} from "../src/lib/research-risk-routing";
import { swingCalibration } from "../src/lib/research-risk-scenarios";
import { growthIntradayTemplate } from "../src/lib/research-growth-intraday";
import { researchManagementSchema } from "../src/lib/research-management";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { applyResearchManagement } from "../src/components/research-strategy-fields";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { researchMethodSnapshot } from "../src/server/research/research-method";
import {
  researchGrowthIntraday,
  growthMinuteTimes,
} from "../src/server/strategies/canslim/research-growth-intraday";
const costs = {
  version: "cost-experiment-1" as const,
  commissionBps: 0,
  minimumCommission: 0,
  sellTaxBps: 0,
  slippageBps: 0,
};
const rules = {
  evidence: "synthetic",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
  limitUp: null,
  limitDown: null,
  tradable: true,
};
const bars = Array.from({ length: 100 }, (_, i) => ({
  date: new Date(Date.UTC(2021, 0, i + 1)).toISOString().slice(0, 10),
  open: 100,
  close: 100,
  high: 101,
  low: 99,
  volume: 1000000,
  amount: 100000000,
}));
const calendar = bars.map((b) => b.date);
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: calendar[0],
  end: calendar[99],
  validationStart: calendar[80],
  initialCapital: 1000000,
  costs,
});
it.each(["cycle-switch", "add-raise", "add-reduce", "held-reduce"] as const)(
  "executes %s repair versus unchanged control",
  (kind) => {
    const input = riskRepairTemplate(kind),
      rows = bars.map((b) => ({
        ...b,
        open: 105,
        close: 105,
        high: 106,
        low: 104,
      }));
    const result = replayRiskRepair(input, rows, calendar, () => rules, costs),
      control = replayRiskRepair(
        input,
        rows,
        calendar,
        () => rules,
        costs,
        false,
      );
    expect(result.status).toBe("available");
    expect(result.actions.length).toBeGreaterThan(0);
    if (result.status !== "available" || control.status !== "available")
      throw Error("missing");
    expect(result.repaired).toBe(true);
    expect(control.repaired).toBe(false);
    expect(
      result.cash + result.book.remainingCost - result.book.realizedProfit,
    ).toBeCloseTo(result.accounting.initialCost);
    if (kind === "cycle-switch") {
      expect(result.switched).toBe(true);
      expect(result.stop).toBe(90);
      expect(result.actions[0]!.date).toBe("2021-01-07");
    }
    if (kind === "add-raise") {
      expect(result.actions[0]!.kind).toBe("raise");
      expect(result.stop).toBeCloseTo(98.3333333333);
      expect(result.book.remainingQuantity).toBe(300);
    }
    if (kind === "held-reduce") expect(result.book.remainingQuantity).toBe(300);
  },
);
it("cycle preplan cannot be invented on entry and no switch without its predicate", () => {
  const input = riskRepairTemplate("cycle-switch");
  expect(
    riskRepairSchema.safeParse({ ...input, frozenDate: input.lots[0]!.date })
      .success,
  ).toBe(false);
  expect(
    riskRepairSchema.safeParse({
      ...input,
      cycle: { ...input.cycle, structureDate: "2021-01-07" },
    }).success,
  ).toBe(false);
  const no = replayRiskRepair(
    { ...input, cycle: { ...input.cycle!, triggerPrice: 100 } },
    bars,
    calendar,
    () => rules,
    costs,
  );
  expect(no.actions).toEqual([]);
  expect(no.stop).toBe(95);
});
it("blocked cycle keeps old stop and retries reduction before widening", () => {
  const input = riskRepairTemplate("cycle-switch");
  const r = replayRiskRepair(
    input,
    bars,
    calendar.slice(0, 8),
    (d) => ({ ...rules, tradable: d !== "2021-01-07" }),
    costs,
  );
  expect(r.actions[0]).toMatchObject({ kind: "blocked", stop: 95 });
  expect(r.actions[1]).toMatchObject({ kind: "reduce", stop: 90 });
});
it("repair includes paid fees and realized gap losses, not just remaining shares", () => {
  const input = riskRepairTemplate("held-reduce");
  const bad = bars.map((b) =>
    b.date > input.observedDate
      ? { ...b, open: 80, close: 80, high: 81, low: 79 }
      : b,
  );
  const r = replayRiskRepair(input, bad, calendar, () => rules, {
    ...costs,
    minimumCommission: 5,
    sellTaxBps: 10,
  });
  expect(r.status).toBe("available");
  if (r.status !== "available") return;
  expect(r.book.remainingQuantity).toBe(0);
  expect(r.repaired).toBe(false);
  expect(r.risk).toBeGreaterThan(8000);
});
it("source summed batch risk admits equality and rejects missing observation", () => {
  const input = { ...riskRepairTemplate("add-reduce"), budget: 2000 };
  const r = replayRiskRepair(input, bars, calendar, () => rules, costs);
  expect(r.actions).toEqual([]);
  expect(
    replayRiskRepair(
      input,
      bars.filter((b) => b.date !== input.observedDate),
      calendar,
      () => rules,
      costs,
    ).status,
  ).toBe("missing");
  expect(
    riskRepairSchema.safeParse({ ...input, availableDate: "2021-01-07" })
      .success,
  ).toBe(false);
});
const training = (variant: StopDiagnosis["variant"]): StopDiagnosis => ({
  version: "stop-diagnosis-v1",
  provenance: "manual-scenario",
  cutoff: calendar[80]!,
  variant,
  records: Array.from({ length: 100 }, (_, i) => ({
    id: String(i),
    strategyVersion: "synthetic",
    entryDate: calendar[5]!,
    exitDate: calendar[6]!,
    availableDate: calendar[6]!,
    entry: 100,
    stop: 97,
    atr: 3,
    pivot: 94,
    delayBars: 3,
    profit: i < 30 ? -1 : 1,
    stopped: i < 30,
  })),
});
it("diagnosis freezes exact frequency/late/mismatch thresholds and never accepts future settlement", () => {
  const v = training("timing-v1"),
    d = diagnoseStops(v);
  expect(d).toMatchObject({
    frequent: true,
    late: true,
    mismatch: true,
    stopLossRate: 0.3,
  });
  expect(diagnosisDecision(v, calendar[81]!, 100, 3, 94).allow).toBe(true);
  expect(diagnosisDecision(v, calendar[81]!, 100, 3, 93.99).allow).toBe(false);
  expect(diagnosisDecision(v, calendar[79]!, 100, 3, 94).allow).toBe(false);
  expect(
    diagnoseStops({ ...v, records: v.records.slice(1) }).reason,
  ).not.toBeNull();
  expect(
    diagnoseStops({
      ...v,
      records: v.records.map((r, i) =>
        i ? r : { ...r, availableDate: v.cutoff },
      ),
    }).reason,
  ).not.toBeNull();
  expect(
    diagnoseStops({
      ...v,
      records: v.records.map((r) => ({ ...r, stop: 95.5 })),
    }).mismatch,
  ).toBe(false);
});
it("ATR correction resizes while the 3-to-8 control preserves excessive risk", () => {
  const corrected = diagnosisDecision(
    training("atr-resize-v1"),
    calendar[81]!,
    100,
    3,
    94,
  );
  expect(corrected).toMatchObject({ stop: 94, sizingStop: 94 });
  expect(
    diagnosisDecision(
      training("naive-3-to-8-control"),
      calendar[81]!,
      100,
      3,
      94,
    ),
  ).toMatchObject({ stop: 92, sizingStop: 97 });
  expect(
    diagnosisDecision(training("atr-resize-v1"), calendar[81]!, 100, null, 94)
      .allow,
  ).toBe(false);
  const event: ResearchEvent = {
    symbol: "sh600000",
    key: "fixture",
    strategyVersion: "fixture",
    partition: "validation",
    observedDate: calendar[81]!,
    endpointDate: calendar[81]!,
    initialStop: 94,
    stopAtr: 3,
    evidence: "synthetic",
  };
  const run = (variant: StopDiagnosis["variant"]) =>
    researchPortfolio(
      researchSpecSchema.parse({
        ...base,
        start: calendar[79],
        holdingDays: 60,
        risk: { fraction: 0.01, maxWeight: 0.2 },
        management: diagnosisTemplate(),
        stopDiagnosis: training(variant),
      }),
      [event],
      calendar,
      new Map([[event.symbol, bars]]),
      () => rules,
    );
  const a = run("atr-resize-v1"),
    n = run("naive-3-to-8-control");
  expect(a.trades[0]!.quantity).toBe(1600);
  expect(n.trades[0]!.quantity).toBe(2000);
  expect(n.trades[0]!.initialStop).toBe(92);
  expect(n.trades[0]!.quantity * (100 - 92)).toBeGreaterThan(10000);
});
it.each(Object.keys(riskRouteNames))(
  "route %s preserves named primary and alternative and saved evidence",
  (scenario) => {
    for (const branch of ["primary", "alternative"]) {
      const parsed = riskRouteSchema.safeParse({
        version: "risk-route-v1",
        provenance: "manual-scenario",
        knownOn: base.start,
        scenario,
        branch,
      });
      if (!parsed.success) {
        expect(["unmonitored", "records100"]).toContain(scenario);
        expect(branch).toBe("alternative");
        continue;
      }
      const route = resolveRiskRoute(parsed.data);
      const selected = route.management
        ? applyResearchManagement(
            {
              ...base,
              risk: { fraction: 0.01, maxWeight: 0.2 },
              holdingDays: 60,
            },
            researchManagementSchema.parse(route.management),
          )
        : { ...base, riskExtension: route.extension! };
      const spec = researchSpecSchema.parse({
        ...selected,
        riskRoute: parsed.data,
      });
      expect(researchMethodSnapshot(spec).riskRoute?.input).toEqual(
        parsed.data,
      );
      expect(
        researchSpecSchema.safeParse({
          ...spec,
          riskRoute: { ...parsed.data, knownOn: calendar[1] },
        }).success,
      ).toBe(false);
    }
  },
);
it("swing calibration is a full 100-trade review and does not pick a winning parameter", () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({
    version: "v1",
    mae: i < 50 ? 1 : 3,
    profit: i < 50 ? 1 : -1,
    atr: 2,
    entry: 100,
  }));
  expect(swingCalibration(rows)).toMatchObject({
    count: 100,
    winnerMaeAtrQ90: 0.5,
    loserMaeAtrQ90: 1.5,
    parametersChanged: false,
  });
  expect(swingCalibration(rows.slice(1)).reason).not.toBeNull();
  expect(
    swingCalibration(rows.map((r, i) => (i ? r : { ...r, atr: NaN }))).reason,
  ).not.toBeNull();
});
function swingFixture() {
  const spec = researchSpecSchema.parse(
    applyResearchManagement(
      {
        ...base,
        start: calendar[60]!,
        end: calendar[79]!,
        validationStart: calendar[75]!,
      },
      growthIntradayTemplate("RK-C-swing-system"),
    ),
  );
  const inputs = calendar.map((date) => ({
    symbol: "sh600000",
    date,
    source: "synthetic",
    version: "1",
    effectiveAt: `${date}T15:00:00+08:00`,
    availableAt: `${date}T15:00:00+08:00`,
    capturedAt: `${date}T15:00:00+08:00`,
    scheduledEvent: {
      evidence: "synthetic complete calendar",
      coverageComplete: true as const,
      id: "none",
      eventDate: null,
      announcedAt: `${date}T15:00:00+08:00`,
    },
  }));
  spec.management!.contextRiskInputs = inputs;
  const event: ResearchEvent = {
    symbol: "sh600000",
    key: "swing",
    strategyVersion: "fixture",
    partition: "development",
    observedDate: calendar[61]!,
    endpointDate: calendar[61]!,
    initialStop: 98,
    stopAtr: 2,
    evidence: "synthetic",
  };
  const minutes = bars.flatMap((b) =>
    growthMinuteTimes.map((time) => ({
      ...b,
      date: `${b.date}T${time}:00+08:00`,
      volume: b.volume / 48,
      amount: b.amount / 48,
    })),
  );
  const run = () =>
    researchGrowthIntraday(
      spec,
      [event],
      calendar,
      new Map([[event.symbol, bars]]),
      new Map([[event.symbol, minutes]]),
      () => rules,
      researchPortfolio(
        spec,
        [],
        calendar,
        new Map([[event.symbol, bars]]),
        () => rules,
      ),
    );
  return { spec, event, minutes, run };
}
it("complete swing enforces structure, liquidity, time exit and missing event calendar", () => {
  const f = swingFixture(),
    r = f.run();
  expect(r.trades).toHaveLength(1);
  expect(r.trades[0]!.initialStop).toBe(97.4);
  expect(r.trades[0]!.quantity).toBe(2000);
  expect(r.trades[0]!.exitReason).toContain("10日");
  f.event.initialStop = 95;
  expect(f.run().trades).toHaveLength(0);
  f.event.initialStop = 98;
  f.spec.management!.contextRiskInputs = [];
  expect(f.run().trades).toHaveLength(0);
});
it("swing uses minute catastrophe as backup, not technical intrabar touching", () => {
  const f = swingFixture(),
    day = calendar[63]!;
  const row = f.minutes.find((b) => b.date === `${day}T10:00:00+08:00`)!;
  row.low = 97;
  expect(f.run().trades[0]!.exitReason).toContain("10日");
  row.low = 94;
  const t = f.run().trades[0]!;
  expect(t.sales![0]!.date).toBe(`${day}T10:00:00+08:00`);
  expect(t.sales![0]!.triggerDate).toBe(`${day}T10:00:00+08:00`);
  expect(t.exitDate).toBe(day);
});
it("swing locks 1R, halves at2R and retains an early known event reduction", () => {
  const f = swingFixture(),
    day = calendar[63]!;
  for (const b of f.minutes.filter((b) => b.date.startsWith(day))) {
    b.open = 106;
    b.close = 106;
    b.high = 107;
    b.low = 105;
  }
  const t = f.run().trades[0]!;
  expect(t.stopHistory!.some((h) => Math.abs(h.stop - 102.6) < 1e-8)).toBe(
    true,
  );
  expect(
    t.sales!.some((s) => s.reason.startsWith("2R") && s.quantity === 1000),
  ).toBe(true);
  const g = swingFixture(),
    row = g.spec.management!.contextRiskInputs!.find((r) => r.date === day)!;
  row.scheduledEvent = {
    evidence: "synthetic announcement",
    coverageComplete: true,
    id: "earnings",
    eventDate: calendar[66]!,
    announcedAt: row.availableAt,
  };
  expect(g.run().trades[0]!.sales![0]).toMatchObject({
    quantity: 1000,
    reason: "已知事件前三交易日减半",
  });
});

it("real research entry retains repair comparison and refuses missing execution proof", async () => {
  const { runStrategyResearch } =
    await import("../src/server/backtest/research-run");
  const { researchMarketEvidenceSchema } =
    await import("../src/lib/research-market-evidence");
  const { researchSignals } =
    await import("../src/server/strategies/shared/research-signals");
  const symbol = "sh600000";
  const input = {
    ...riskRepairTemplate("held-reduce"),
    observedDate: calendar[65]!,
    availableDate: calendar[65]!,
  };
  const spec = researchSpecSchema.parse({
    ...base,
    start: calendar[61],
    riskRepair: input,
  });
  const dataset: import("../src/server/backtest/research-dataset").ResearchDataset =
    {
      version: "research-dataset-1",
      source: "tdx-local",
      root: "synthetic",
      adjustment: "none",
      membership: {
        mode: "current-snapshot",
        symbols: [symbol],
        source: null,
        warning: "fixture",
      },
      benchmark: { symbol: "sh000001", bars },
      calendar,
      stocks: [{ symbol, name: "fixture", bars, hash: "fixture", actions: [] }],
      excluded: [],
      actionCoverage: "missing",
      actionSource: null,
      capturedAt: 0,
      hash: "fixture",
    };
  const evidence = researchMarketEvidenceSchema.parse({
    version: "research-market-evidence-1",
    source: "fixture",
    exportedAt: 0,
    adjustment: "none",
    corporateActionFree: [
      { symbol, start: calendar[0], end: spec.end, evidenceId: "fixture" },
    ],
    rows: calendar.map((date) => ({
      symbol,
      date,
      ...rules,
      evidenceId: "fixture",
    })),
  });
  const native = async () => {
    throw Error("no native required");
  };
  const missing = await runStrategyResearch(spec, dataset, null, native);
  expect(missing.riskRepair).toMatchObject({
    status: "missing",
    executionEvidenceAvailable: false,
  });
  const shortProof = await runStrategyResearch(
    spec,
    dataset,
    {
      ...evidence,
      corporateActionFree: [
        {
          symbol,
          start: spec.start,
          end: spec.end,
          evidenceId: "research-period-only",
        },
      ],
    },
    native,
  );
  expect(shortProof.riskRepair).toMatchObject({
    status: "missing",
    executionEvidenceAvailable: false,
  });
  const result = await runStrategyResearch(spec, dataset, evidence, native);
  expect(result.riskRepair).toMatchObject({
    executionEvidenceAvailable: true,
    repaired: { repaired: true },
    control: { repaired: false },
    includedInSignalPortfolio: false,
  });
  expect(
    researchMethodSnapshot(spec).sources.some(
      (s) => s.path === "stop-loss/references/pitfalls.md",
    ),
  ).toBe(true);
  // The initial stop for the full system must be an actual swing low, not any nearby support.
  const breakout = await import("../src/server/strategies/breakout/breakout"),
    original = breakout.analyzeBreakout(bars);
  // S4 breakout rewrite: the signal loop calls `analyzeBreakout(bars, 0)` once
  // and reads `points[index]`, so the stub must cover every index instead of
  // only the called prefix. The injected levels/stop (and therefore the
  // behaviour this test asserts) are unchanged.
  const spy = vi
    .spyOn(breakout, "analyzeBreakout")
    .mockImplementation((calledBars) => {
      const points: typeof original.points = calledBars.map((bar) => ({
        ...original.latest!,
        date: bar.date,
        levels: [
          {
            source: "swing-low",
            price: 96,
            index: 40,
            confirmedAt: calendar[43]!,
          },
          { source: "round", price: 99, index: 45, confirmedAt: calendar[45]! },
        ],
        long: {
          ...original.latest!.long,
          status: "是",
          risk: {
            ...original.latest!.long.risk,
            stop: {
              price: 99,
              source: "round",
              index: 45,
              confirmedAt: calendar[45]!,
            },
          },
        },
      }));
      return { ...original, points, latest: points.at(-1) ?? null };
    });
  try {
    const f = swingFixture();
    f.spec.start = calendar[61]!;
    const events = await researchSignals(symbol, bars, f.spec, native);
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.initialStop).toBe(96);
  } finally {
    spy.mockRestore();
  }
});
it("cycle cannot inflate its original risk by supplying a larger budget", () => {
  const v = { ...riskRepairTemplate("cycle-switch"), budget: 10000 };
  const r = replayRiskRepair(v, bars, calendar, () => rules, costs);
  expect(r.status).toBe("available");
  if (r.status !== "available") return;
  expect(r.effectiveBudget).toBe(2000);
  expect(r.risk).toBeLessThanOrEqual(2000);
});

it("a missing held minute day cannot yield a complete MAE review", () => {
  const f = swingFixture(),
    date = calendar[64]!;
  f.minutes.splice(
    f.minutes.findIndex((b) => b.date.startsWith(date)),
    1,
  );
  const r = f.run();
  expect(r.trades[0]!.swingHistoryComplete).toBe(false);
  const records = Array.from({ length: 100 }, () => ({
    version: "v",
    mae: 1,
    atr: 2,
    entry: 100,
    profit: 1,
    complete: false,
  }));
  expect(swingCalibration(records).reason).not.toBeNull();
});

it("repair refuses invalid OHLC observation instead of manufacturing a decision", () => {
  const v = riskRepairTemplate("held-reduce");
  const rows = bars.map((b) =>
    b.date === v.observedDate ? { ...b, high: NaN } : b,
  );
  expect(replayRiskRepair(v, rows, calendar, () => rules, costs).status).toBe(
    "missing",
  );
});
