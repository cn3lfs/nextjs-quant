import { expect, it } from "vitest";
import type {
  PortfolioFill,
  PortfolioOrder,
  PortfolioRequest,
} from "quant-backtest";
import { createPerformanceReport } from "quant-performance";
import type { FrozenLabBacktest } from "~/server/research/lab-backtest";
import { runDiagnostics } from "../../../scripts/lib/backtest-diagnose/diagnostics";
import { buildStrategy } from "../../../scripts/lib/backtest-diagnose/strategy-specs";
import type { DiagnosticsInput } from "../../../scripts/lib/backtest-diagnose/types";

const dates = ["2025-01-06", "2025-01-07", "2025-01-08"] as const;
const [signalAt, firstFillDay, secondFillDay] = dates;
const symbol = "sh600000";
const strategy = buildStrategy("hold", [symbol], "single");
const identity = { strategyId: strategy.id, sleeve: strategy.sleeve, symbol };
const bars = dates.map((date) => ({
  date,
  open: 10,
  high: 10.5,
  low: 9.5,
  close: 10,
  volume: 100_000,
  amount: 1_000_000,
}));
const request: PortfolioRequest = {
  market: "cn-equity",
  start: signalAt,
  end: secondFillDay,
  calendar: dates,
  initial: 2_500,
  instruments: [
    {
      symbol,
      market: "cn-equity",
      bars,
      signalBars: bars,
      execution: {
        evidence: "synthetic multi-fill tape",
        tradable: true,
        limitUp: null,
        limitDown: null,
      },
    },
  ],
  strategies: [strategy],
  sleeves: [
    { id: strategy.sleeve, share: 1, riskPerTrade: 0.1, maxPositions: 1 },
  ],
  costs: {
    version: "cost-experiment-1",
    commissionBps: 0,
    minimumCommission: 0,
    sellTaxBps: 0,
    slippageBps: 0,
  },
};
const frozen: FrozenLabBacktest = {
  request,
  sources: [],
  dataSource: "local",
  corporateActionCoverage: "included",
  costScenario: "fixed",
  strategyBuildHash: "",
  executionBuildHash: "",
  boundary: "synthetic multi-fill tape",
  marketPolicy: {
    signalBars: "raw",
    executionBars: "raw",
    priceLimits: "scenario",
    quantityGrid: {
      kind: "fixture",
      minimumStepCells: ["100/100"],
      evidence: "synthetic A-share lots",
    },
  },
};

function tape(
  status: PortfolioOrder["status"],
  fillCount: 1 | 2,
  options: {
    targetWeight?: number | null;
    reason?: string | null;
    capacityClipped?: true;
  } = {},
): DiagnosticsInput {
  const order: PortfolioOrder = {
    ...identity,
    id: 1,
    side: "buy",
    signalAt,
    due: firstFillDay,
    trigger: "signal",
    status,
    reason: options.reason ?? null,
    attempts: fillCount,
    ...(options.targetWeight === null
      ? {}
      : { targetWeight: options.targetWeight ?? 0.2 }),
    ...(options.capacityClipped ? { capacityClipped: true } : {}),
  };
  const receipt = {
    ...identity,
    orderId: 1,
    side: "buy",
    signalAt,
    quantity: 100,
    price: 10,
    fee: 0,
  } as const;
  const fills: PortfolioFill[] = [
    { ...receipt, date: firstFillDay, cashAfter: 1_500, holdingAfter: 100 },
    { ...receipt, date: secondFillDay, cashAfter: 500, holdingAfter: 200 },
  ].slice(0, fillCount);
  const curve = dates.map((date, index) => {
    const cash = request.initial - Math.min(index, fillCount) * 1_000;
    return {
      date,
      cash,
      equity: request.initial,
      sleeves: [{ id: strategy.sleeve, cash, equity: request.initial }],
    };
  });
  return {
    request,
    frozen,
    replay: {
      frozen,
      inputHash: "",
      timingStatus: "unknown",
      overview: createPerformanceReport(
        request.initial,
        curve.map(({ date, equity }) => ({ date, value: equity })),
      ).overview,
      signalEvidence: [],
      inputDiagnostics: [],
      result: {
        version: "portfolio-event-1",
        quality: "rule-check-only",
        orders: [order],
        fills,
        rejections: [],
        transfers: [],
        corporateActions: [],
        terminalValuations: [],
        observations: [],
        equity: curve,
        curve,
        positionSnapshots: [firstFillDay, secondFillDay].map((date, index) => {
          const quantity = Math.min(index + 1, fillCount) * 100;
          return {
            ...identity,
            date,
            quantity,
            weight: (quantity * 10) / request.initial,
          };
        }),
        positions: [
          {
            ...identity,
            key: JSON.stringify([strategy.id, symbol]),
            bought: firstFillDay,
            quantity: 100 * fillCount,
            cost: 10,
            mark: 10,
            lots: fills.map(({ date, quantity }) => ({
              bought: date,
              quantity,
            })),
          },
        ],
      },
    },
  };
}

it.each([
  { status: "filled", fillCount: 2 },
  { status: "pending", fillCount: 1 },
] as const)(
  "accepts a $status order with $fillCount valid fill(s)",
  ({ status, fillCount }) => {
    const report = runDiagnostics(tape(status, fillCount));
    expect(report.counts.fills).toBe(fillCount);
    expect(report.status).toBe("ok");
    expect(
      report.checks.find(({ id }) => id === "orderFillCardinality")?.status,
    ).toBe("pass");
    expect(
      report.checks.find(({ id }) => id === "noDuplicateFill")?.status,
    ).toBe("pass");
    expect(
      report.checks.find(({ id }) => id === "ledgerReconcile")?.status,
    ).toBe("pass");
  },
);

it("fails multi-fill when the order has no target or capacity path", () => {
  const report = runDiagnostics(tape("filled", 2, { targetWeight: null }));
  expect(
    report.checks.find(({ id }) => id === "orderFillCardinality"),
  ).toMatchObject({
    status: "fail",
    evidence: {
      orderIds: [1],
      violations: [
        expect.objectContaining({
          order: { id: 1, status: "filled" },
          fillCount: 2,
          reason: expect.stringContaining("目标/容量裁剪路径"),
        }),
      ],
    },
  });
});

it("accepts a superseded target order that retains prior fills", () => {
  const report = runDiagnostics(
    tape("rejected", 1, {
      reason: "被新的完成bar调仓目标替代",
    }),
  );
  expect(report.status).toBe("ok");
  expect(
    report.checks.find(({ id }) => id === "orderFillConservation")?.status,
  ).toBe("pass");
  expect(
    report.checks.find(({ id }) => id === "orderFillCardinality")?.status,
  ).toBe("pass");
});

it("fails cardinality when a rejected order has a fill", () => {
  const report = runDiagnostics(tape("rejected", 1));
  expect(
    report.checks.find(({ id }) => id === "orderFillCardinality"),
  ).toMatchObject({
    status: "fail",
    evidence: {
      orderIds: [1],
      violations: [
        expect.objectContaining({
          order: { id: 1, status: "rejected" },
          fillCount: 1,
        }),
      ],
    },
  });
});

it("fails cardinality when a plain rejected order has a fill", () => {
  const report = runDiagnostics(tape("rejected", 1, { targetWeight: null }));
  expect(
    report.checks.find(({ id }) => id === "orderFillCardinality"),
  ).toMatchObject({
    status: "fail",
    evidence: {
      orderIds: [1],
      violations: [
        expect.objectContaining({
          order: { id: 1, status: "rejected" },
          fillCount: 1,
        }),
      ],
    },
  });
});

it.each([
  { field: "signalAt", mismatch: { signalAt: "2025-01-03" } },
  { field: "side", mismatch: { side: "sell" } },
  { field: "symbol", mismatch: { symbol: "sz000001" } },
  { field: "strategyId", mismatch: { strategyId: "other" } },
] as const)(
  "fails cardinality when the fill's $field differs from its order",
  ({ field, mismatch }) => {
    const input = tape("filled", 2);
    Object.assign(input.replay.result.fills[1]!, mismatch);
    const report = runDiagnostics(input);
    expect(
      report.checks.find(({ id }) => id === "orderFillCardinality"),
    ).toMatchObject({
      status: "fail",
      evidence: {
        orderIds: [1],
        violations: [
          expect.objectContaining({
            mismatchedFields: [field],
            fill: expect.objectContaining({ date: secondFillDay }),
          }),
        ],
      },
    });
  },
);
