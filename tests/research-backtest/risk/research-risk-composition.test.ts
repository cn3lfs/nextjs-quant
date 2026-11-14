import { expect, it } from "vitest";
import {
  riskRepairTemplate,
  riskRepairSchema,
} from "trading-strategies/research/risk/research-risk-repair";
import { replayRiskRepair } from "../../../src/lib/research/risk/research-risk-repair";
import {
  diagnoseStops,
  diagnosisDecision,
  type StopDiagnosis,
} from "trading-strategies/research/risk/research-risk-routing";
import { swingCalibration } from "trading-strategies/research/risk/research-risk-scenarios";
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
it("distinguishes ATR correction from the naive stop-width control", () => {
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
});
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
it("cycle cannot inflate its original risk by supplying a larger budget", () => {
  const v = { ...riskRepairTemplate("cycle-switch"), budget: 10000 };
  const r = replayRiskRepair(v, bars, calendar, () => rules, costs);
  expect(r.status).toBe("available");
  if (r.status !== "available") return;
  expect(r.effectiveBudget).toBe(2000);
  expect(r.risk).toBeLessThanOrEqual(2000);
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
