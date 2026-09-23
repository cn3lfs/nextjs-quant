import { runStrategyResearch } from "../src/server/backtest/research-run";
import type { ResearchDataset } from "../src/server/backtest/research-dataset";
import { expect, it } from "vitest";
import {
  externalVolatilityPoint,
  type VolatilityInput,
} from "../src/lib/research-volatility-input";
import { volatilityStopTemplate } from "../src/lib/research-volatility-stops";
import { researchManagementSchema } from "../src/lib/research-management";
import {
  researchSpecSchema,
  type ResearchEvent,
} from "../src/lib/strategy-research";
import { researchPortfolio } from "../src/server/backtest/research-portfolio";
import { applyResearchManagement } from "../src/components/research/research-strategy-fields";
import { researchMethodSnapshot } from "../src/server/research/research-method";

const bars = Array.from({ length: 30 }, (_, i) => ({
  date: `2021-01-${String(i + 1).padStart(2, "0")}`,
  open: 100,
  high: 102,
  low: 98,
  close: 100,
  volume: 10000,
  amount: 1000000,
}));
const evidence = (date = "2021-01-20"): VolatilityInput => ({
  symbol: "sh600000",
  date,
  source: "fixed-input-only",
  version: "fixture-1",
  effectiveAt: `${date}T14:00:00+08:00`,
  availableAt: `${date}T14:00:00+08:00`,
  capturedAt: `${date}T14:00:00+08:00`,
  kase: {
    formulaReference: "synthetic evaluated correction; not official DevStop",
    window: 2,
    anchor: 100,
    warning: { sigma: 0, skewCorrection: 1 },
    levels: [
      { sigma: 1, skewCorrection: 2 },
      { sigma: 2, skewCorrection: 4 },
      { sigma: 3, skewCorrection: 8 },
    ],
    cumulativeFractions: [0.25, 0.5, 1],
  },
  beta: {
    value: 1,
    estimationWindow: 60,
    benchmark: "sh000300",
    windowEnd: date,
    price: 100,
    tableReference: "synthetic table; not original",
    table: [
      { betaMin: 0, betaMax: 1, priceMin: 0, priceMax: 200, distance: 5 },
      { betaMin: 1, betaMax: 2, priceMin: 0, priceMax: 200, distance: 8 },
    ],
  },
});
it("requires external parameters, provenance and all causal timestamps; no invented defaults", () => {
  expect(
    externalVolatilityPoint("rk-kase", bars, "sh600000", "2021-01-20"),
  ).toMatchObject({ status: "missing" });
  for (const field of ["effectiveAt", "availableAt", "capturedAt"] as const) {
    const e = evidence();
    e[field] = "2021-01-21T09:00:00+08:00";
    expect(
      externalVolatilityPoint("rk-kase", bars, e.symbol, e.date, [e]).status,
    ).toBe("missing");
  }
  const e = evidence();
  delete e.kase;
  expect(
    externalVolatilityPoint("rk-kase", bars, e.symbol, e.date, [e]).status,
  ).toBe("missing");
  expect(
    externalVolatilityPoint("rk-beta", bars, e.symbol, e.date, [e, e]).status,
  ).toBe("missing");
});
it("Kase applies supplied corrections to hand-calculated two-bar TR sample deviation", () => {
  const e = evidence();
  expect(
    externalVolatilityPoint("rk-kase", bars, e.symbol, e.date, [e]),
  ).toMatchObject({
    status: "available",
    stop: 92,
    warning: 99,
    levels: [98, 96, 92],
  });
  const varied = structuredClone(bars);
  varied[19]!.high = 106;
  // last two two-bar TRs are 4 and 8: sample STD=sqrt(8).
  const result = externalVolatilityPoint("rk-kase", varied, e.symbol, e.date, [
    e,
  ]);
  expect(result.status).toBe("available");
  if (result.status === "available")
    expect(result.stop).toBeCloseTo(92 - 3 * Math.sqrt(8));
  varied[19]!.volume = 0;
  expect(
    externalVolatilityPoint("rk-kase", varied, e.symbol, e.date, [e]).status,
  ).toBe("missing");
  expect(
    externalVolatilityPoint(
      "rk-kase",
      bars.filter((_, i) => i !== 18),
      e.symbol,
      e.date,
      [e],
      bars.map((b) => b.date),
    ).status,
  ).toBe("missing");
  e.kase!.levels[1].skewCorrection = 1;
  expect(
    externalVolatilityPoint("rk-kase", bars, e.symbol, e.date, [e]).status,
  ).toBe("missing");
});
it("Beta table uses left-closed right-open cells and refuses gaps/overlaps/future estimates", () => {
  const e = evidence();
  expect(
    externalVolatilityPoint("rk-beta", bars, e.symbol, e.date, [e]),
  ).toMatchObject({ status: "available", stop: 92 });
  e.beta!.value = 2;
  expect(
    externalVolatilityPoint("rk-beta", bars, e.symbol, e.date, [e]).status,
  ).toBe("missing");
  e.beta!.value = 1;
  e.beta!.table.push(e.beta!.table[1]!);
  expect(
    externalVolatilityPoint("rk-beta", bars, e.symbol, e.date, [e]).status,
  ).toBe("missing");
  e.beta!.table.pop();
  e.beta!.windowEnd = "2021-01-21";
  expect(
    externalVolatilityPoint("rk-beta", bars, e.symbol, e.date, [e]).status,
  ).toBe("missing");
});
const rules = {
  evidence: "synthetic",
  minimumBuy: 100,
  buyStep: 100,
  maximumOrder: 100000,
  minimumSell: 100,
  sellStep: 100,
  maximumSell: 100000,
  sellOddLotAll: true,
  tradable: true,
  limitUp: null,
  limitDown: null,
};
const event: ResearchEvent = {
  symbol: "sh600000",
  observedDate: "2021-01-20",
  endpointDate: "2021-01-20",
  key: "input-fixture",
  strategyVersion: "fixture",
  evidence: "fixed input only",
  partition: "development",
};
const base = researchSpecSchema.parse({
  strategy: "dual-breakout",
  start: "2021-01-20",
  end: "2021-01-30",
  validationStart: "2021-01-29",
  initialCapital: 1000000,
  costs: {
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
});
function run(
  id: "rk-kase" | "rk-kase-stages" | "rk-beta" | "rk-keltner-opposite",
  input = bars,
  inputs: VolatilityInput[] = [],
) {
  const management = volatilityStopTemplate(id);
  if (inputs.length) management.volatilityInputs = inputs;
  const spec = researchSpecSchema.parse(
    applyResearchManagement(base, management),
  );
  return researchPortfolio(
    spec,
    [event],
    input.map((b) => b.date),
    new Map([[event.symbol, input]]),
    (_s, date) => ({ ...rules, tradable: date !== "2021-01-23" }),
  );
}
it("input survives schema and frozen method snapshot; absent input refuses actual entry", () => {
  const template = {
    ...volatilityStopTemplate("rk-beta"),
    volatilityInputs: [evidence()],
  };
  expect(researchManagementSchema.parse(template)).toEqual(template);
  const spec = applyResearchManagement(base, template);
  expect(JSON.stringify(researchMethodSnapshot(spec))).toContain(
    "synthetic table",
  );
  expect(run("rk-beta").excluded[0]?.reason).toContain("missing");
  const result = run("rk-beta", bars, [evidence()]);
  expect(result.trades[0]?.initialStop).toBe(92);
  expect(
    result.trades[0]?.managementWarnings?.some((w) =>
      w.reason.includes("missing"),
    ),
  ).toBe(true);
});
it("Kase stages freeze cumulative original-position fractions and retry confirmed reductions", () => {
  const input = structuredClone(bars);
  for (const i of [21, 22, 23, 24, 25, 26])
    Object.assign(input[i]!, { open: 98, close: i >= 24 ? 96 : 98, low: 94 });
  const inputs = bars.map((b) => evidence(b.date));
  // sigma coefficients zero isolate stage decisions from the changing input range.
  for (const e of inputs) for (const level of e.kase!.levels) level.sigma = 0;
  // Later fractions cannot alter the entry-frozen plan.
  inputs[21]!.kase!.cumulativeFractions = [0.1, 0.8, 1];
  const t = run("rk-kase-stages", input, inputs).trades[0]!;
  expect(t.quantity).toBe(1200); // 1% of one million / 8, rounded down.
  expect(t.sales?.map((s) => [s.date, s.quantity])).toEqual([
    ["2021-01-24", 300],
    ["2021-01-26", 300],
  ]);
  expect(t.remainingQuantity).toBe(600);
  expect(t.managementWarnings?.some((w) => w.reason.includes("预警"))).toBe(
    true,
  );
});
it("opposite upper rail is a profit target, never a raised protective stop", () => {
  const input = structuredClone(bars);
  Object.assign(input[21]!, { open: 100, high: 120, close: 120 });
  const t = run("rk-keltner-opposite", input).trades[0]!;
  expect(t.initialStop).toBe(95);
  expect(t.exitDate).toBe("2021-01-24"); // blocked 23rd, intent persists after recovery.
  expect(t.exitReason).toContain("对侧上轨");
  expect(t.stopHistory?.every((s) => s.stop === 95)).toBe(true);
});

it("real run refuses missing external inputs before producing any backtest", async () => {
  const spec = researchSpecSchema.parse(
    applyResearchManagement(base, volatilityStopTemplate("rk-beta")),
  );
  const dataset: ResearchDataset = {
    version: "research-dataset-1",
    source: "tdx-local",
    root: "fixed",
    adjustment: "none",
    membership: {
      mode: "current-snapshot",
      symbols: [event.symbol],
      source: null,
      warning: "fixture",
    },
    benchmark: { symbol: "sh000001", bars },
    calendar: bars.map((b) => b.date),
    stocks: [
      {
        symbol: event.symbol,
        name: "fixture",
        bars,
        hash: "fixture",
        actions: [],
      },
    ],
    excluded: [],
    actionCoverage: "missing",
    actionSource: null,
    capturedAt: 0,
    hash: "fixture",
  };
  await expect(
    runStrategyResearch(spec, dataset, null, async () => {
      throw new Error("must not call DLL");
    }),
  ).rejects.toThrow("missing: Kase/Beta真实回测不可用");
});

it("Kase isolates staged targets for two symbols sharing the same event key", () => {
  const second = { ...event, symbol: "sh600001" };
  const input = structuredClone(bars);
  Object.assign(input[21]!, { open: 100, close: 98, low: 94 });
  const rows = [event.symbol, second.symbol].flatMap((symbol) =>
    bars.map((b) => {
      const e = evidence(b.date);
      e.symbol = symbol;
      for (const level of e.kase!.levels) level.sigma = 0;
      if (symbol === second.symbol) e.kase!.cumulativeFractions = [0.1, 0.8, 1];
      return e;
    }),
  );
  const management = {
    ...volatilityStopTemplate("rk-kase-stages"),
    volatilityInputs: rows,
  };
  const spec = researchSpecSchema.parse(
    applyResearchManagement(base, management),
  );
  const result = researchPortfolio(
    spec,
    [event, second],
    input.map((b) => b.date),
    new Map([
      [event.symbol, input],
      [second.symbol, input],
    ]),
    () => rules,
  );
  expect(
    result.trades.map((t) => [
      t.event.symbol,
      t.quantity,
      t.sales?.[0]?.quantity,
    ]),
  ).toEqual([
    [event.symbol, 1200, 300],
    [second.symbol, 1200, 100],
  ]);
});
