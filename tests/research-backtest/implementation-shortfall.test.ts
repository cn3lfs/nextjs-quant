import Database from "better-sqlite3";
import { migrate } from "~/server/db/migrations";
import { loadAccountBook } from "~/server/portfolio/account-workspace-service";
import { AccountWorkspaceRepository } from "~/server/db/account-workspace-repository";
import {
  createDeployment,
  setGlobalAutoSimEnabled,
} from "~/server/db/deployment-repository";
import {
  getOrCreatePipelineRun,
  insertOrderIntents,
} from "~/server/db/pipeline-repository";
import { executePipelineRun } from "~/server/execution/pipeline-executor";
import { runPipelinePlanning } from "~/server/pipeline/signal-risk-runner";
import {
  createSimAccount,
  executePipelineSimOrder,
} from "~/server/portfolio/sim-accounts/service";
import { createTRPCClient, httpBatchStreamLink } from "@trpc/client";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import SuperJSON from "superjson";
import { describe, expect, it, vi } from "vitest";
import {
  calculateImplementationShortfall,
  shortfallComponentKeys,
  type ImplementationShortfallInput,
} from "~/lib/portfolio/implementation-shortfall";
import type {
  AccountPosition,
  AccountTrade,
} from "~/lib/portfolio/account-workspace";
import type { Bar } from "~/lib/domain";
import { accountsRouter } from "~/server/api/routers/accounts";
import { portfolioReviewRouter } from "~/server/api/routers/portfolio-review";
import type { AccountBook } from "~/server/portfolio/account-workspace-service";
import { readImplementationShortfall } from "~/server/portfolio/implementation-shortfall-service";
import * as portfolioRiskService from "~/server/portfolio/portfolio-risk-service";
import {
  evaluateAccountPortfolioRisk,
  simulateAccountEntrySizing,
} from "~/server/portfolio/portfolio-risk-service";

const symbol = "sh600000";
const otherSymbol = "sz000001";
const entrySymbol = "sh600519";
const terminalDate = "2026-11-24";
const chinaTime = (date: string, time: string) =>
  Date.parse(`${date}T${time}+08:00`);
const signalAt = chinaTime("2026-11-23", "15:00:00");
const arrivalAt = chinaTime(terminalDate, "09:30:00");
const filledAt = chinaTime(terminalDate, "09:35:00");

function ledgers(): ImplementationShortfallInput {
  return {
    openingNav: 100_000,
    commonTerminalValue: 100_000,
    terminalDate,
    theoretical: [
      {
        id: "p",
        symbol,
        side: "buy",
        signalAt,
        decisionPrice: 10,
        quantity: 100,
        fees: 5,
      },
    ],
    executable: [
      {
        instructionId: "p",
        arrivalAt,
        arrivalPrice: 10.5,
        quantity: 80,
        fees: 7,
      },
    ],
    actual: [
      {
        id: "a",
        instructionId: "p",
        symbol,
        side: "buy",
        date: terminalDate,
        filledAt,
        fillPrice: 11,
        quantity: 60,
        fees: 12,
      },
      {
        id: "b",
        instructionId: null,
        symbol,
        side: "buy",
        date: terminalDate,
        filledAt,
        fillPrice: 15,
        quantity: 10,
        fees: 8,
      },
    ],
    terminalPrices: { [symbol]: 13 },
  };
}

describe("three frozen Perold ledgers", () => {
  it("reconciles the independent terminal values and the five disjoint amounts to 215 CNY", () => {
    // 60 × (10.5 − 10) + 60 × (11 − 10.5) + (20 missed + 20 clipped) × (13 − 10)
    // + 10 × (15 − 13) + (12 + 8 − 5) = 30 + 30 + 120 + 20 + 15 = 215.
    // Theory = 100000 + 100 × 3 − 5 = 100295. Executable = 100000 + 80 × 2.5 − 7 = 100193.
    // Actual = 100000 + 60 × 2 − 12 − 10 × 2 − 8 = 100080.
    const result = calculateImplementationShortfall(ledgers());
    expect(result.status).toBe("complete");
    const resultAmounts = result.reconciliation!;
    expect(resultAmounts).toMatchObject({
      theoreticalTerminalValue: 100295,
      executableTerminalValue: 100193,
      actualTerminalValue: 100080,
      terminalDiff: -215,
    });
    const components = shortfallComponentKeys.map(
      (key) => resultAmounts.amounts[key].cny,
    );
    expect(components).toEqual([30, 30, 120, 20, 15]);
    expect(resultAmounts.amounts.totalShortfall).toEqual({
      cny: 215,
      bps: 21.5,
    });
    expect(
      Math.abs(
        resultAmounts.actualTerminalValue -
          resultAmounts.theoreticalTerminalValue +
          components.reduce((a, b) => a + b),
      ),
    ).toBeLessThan(1e-9);
    expect(result.rows[0]).toMatchObject({
      matchedQuantity: 60,
      executableQuantity: 80,
      theoreticalQuantity: 100,
      reconciliation: { amounts: { totalShortfall: { cny: 187, bps: 1870 } } },
    });
    expect(result.rows[1]?.fills).toEqual([
      { tradeId: "b", actualQuantity: 10, matchedQuantity: 0 },
    ]);
    expect(result).toMatchObject({
      unplannedFillCount: 1,
      missedTradeRate: 0.25,
      disciplineAdherenceRate: 60 / 70,
    });
  });

  it("charges a sell below arrival as positive slippage with explicit zero fees", () => {
    const result = calculateImplementationShortfall({
      ...ledgers(),
      theoretical: [
        { ...ledgers().theoretical[0]!, side: "sell", quantity: 100, fees: 0 },
      ],
      executable: [
        {
          ...ledgers().executable[0]!,
          arrivalPrice: 9.8,
          quantity: 100,
          fees: 0,
        },
      ],
      actual: [
        {
          ...ledgers().actual[0]!,
          side: "sell",
          fillPrice: 9.6,
          quantity: 100,
          fees: 0,
        },
      ],
    });
    expect(result.reconciliation).toMatchObject({
      terminalDiff: -40,
      amounts: {
        signalToArrivalDelay: { cny: 20 },
        arrivalToFillSlippage: { cny: 20 },
        feeDifference: { cny: 0 },
      },
    });
  });

  it("allocates chronological partial fills up to the executable cap and assigns excess exactly once", () => {
    const input = ledgers();
    const first = { ...input.actual[0]!, quantity: 60 };
    input.actual = [
      {
        ...first,
        id: "later",
        filledAt: filledAt + 1,
        quantity: 30,
        fillPrice: 15,
      },
      first,
    ];
    const result = calculateImplementationShortfall(input);
    expect(
      result.rows[0]?.fills.map((fill) => [fill.tradeId, fill.matchedQuantity]),
    ).toEqual([
      ["a", 60],
      ["later", 20],
    ]);
    expect(result.reconciliation?.amounts).toMatchObject({
      signalToArrivalDelay: { cny: 40 },
      arrivalToFillSlippage: { cny: 120 },
      missedTradeOpportunityCost: { cny: 60 },
      behaviorDeviation: { cny: 20 },
    });
    expect(result.unplannedFillCount).toBe(1);
    expect(() =>
      calculateImplementationShortfall({ ...input, actual: [first, first] }),
    ).toThrow("实际成交编号重复");
  });

  it.each([
    ["arrival day", terminalDate, "p"],
    ["later day", "2026-11-23", "p"],
    ["unassigned fill on arrival day", terminalDate, undefined],
  ] as const)(
    "withholds ambiguous allocations on %s",
    (_, arrivalDay, instructionId) => {
      const input = ledgers();
      input.executable = [
        {
          ...input.executable[0]!,
          arrivalAt: chinaTime(arrivalDay, "09:30:00"),
          quantity: 100,
        },
      ];
      input.theoretical[0]!.signalAt = chinaTime(arrivalDay, "09:00:00");
      const fill = input.actual[0]!;
      input.actual = [
        {
          ...fill,
          filledAt: chinaTime(terminalDate, "10:00:00"),
          quantity: 100,
        },
        {
          ...fill,
          id: "untimed",
          instructionId,
          filledAt: null,
          fillPrice: 12,
        },
      ];
      const result = calculateImplementationShortfall(input);
      expect(result).toMatchObject({
        status: "incomplete",
        reconciliation: null,
        disciplineAdherenceRate: null,
        rows: expect.arrayContaining([
          expect.objectContaining({
            instructionId: "p",
            matchedQuantity: null,
            reconciliation: null,
          }),
        ]),
      });
      expect(result.missing).toContainEqual(
        expect.objectContaining({
          field: "filledAt",
          tradeId: "untimed",
          reason: expect.stringContaining("时刻"),
        }),
      );
    },
  );

  it("allocates untimed later-day fills when all candidates fit and skips confirmed deviations", () => {
    const input = ledgers();
    const first = "2026-11-23";
    input.theoretical[0]!.signalAt = chinaTime(first, "09:00:00");
    input.executable[0]!.arrivalAt = chinaTime(first, "09:30:00");
    const fill = input.actual[0]!;
    input.actual = [
      fill,
      { ...fill, id: "untimed", filledAt: null, quantity: 20 },
      { ...input.actual[1]!, filledAt: null },
    ];
    const result = calculateImplementationShortfall(input);
    expect(result.status).toBe("complete");
    expect(result.rows[0]?.fills.map((row) => row.matchedQuantity)).toEqual([
      60, 20,
    ]);
    expect(result.unplannedFillCount).toBe(1);
  });

  it("returns null with precise missing arrival, mark and fee reasons", () => {
    const input = ledgers();
    input.executable[0]!.arrivalPrice = null;
    input.terminalPrices = {};
    input.actual[1]!.fees = null;
    const result = calculateImplementationShortfall(input);
    expect(result.status).toBe("incomplete");
    expect(result.reconciliation).toBeNull();
    expect(result.missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: "arrivalPrice", instructionId: "p" }),
        expect.objectContaining({
          field: "terminalPrice",
          symbol,
          reason: `缺少 ${terminalDate} 期末估值`,
        }),
        expect.objectContaining({ field: "actualFees", tradeId: "b" }),
      ]),
    );
    expect(result.rows.every((row) => row.reconciliation === null)).toBe(true);
  });

  it("treats a known zero executable quantity as clipping, even without an arrival price", () => {
    const input = ledgers();
    input.executable = [{ instructionId: "p", quantity: 0, fees: 0 }];
    input.actual = [];
    const result = calculateImplementationShortfall(input);
    expect(result.reconciliation).toMatchObject({
      executableTerminalValue: 100000,
      amounts: {
        missedTradeOpportunityCost: { cny: 300 },
        signalToArrivalDelay: { cny: 0 },
      },
    });
    expect(result.missedTradeRate).toBeNull();
  });

  it("leaves amounts unavailable if number encoding cannot keep the published NAVs reconciled", () => {
    const result = calculateImplementationShortfall({
      ...ledgers(),
      commonTerminalValue: 1e16,
    });
    expect(result.status).toBe("incomplete");
    expect(result.reconciliation).toBeNull();
    expect(result.missing).toContainEqual(
      expect.objectContaining({ field: "numericPrecision" }),
    );
  });
});

const dates = Array.from(
  { length: 17 },
  (_, i) => new Date(Date.UTC(2026, 10, i + 2)),
)
  .filter((d) => d.getUTCDay() > 0 && d.getUTCDay() < 6)
  .concat([19, 20, 23, 24].map((day) => new Date(Date.UTC(2026, 10, day))))
  .map((d) => d.toISOString().slice(0, 10));
const at = chinaTime(terminalDate, "15:10:00");
const bar = (date: string, close: number): Bar => ({
  date,
  open: close,
  high: close + 0.51,
  low: close - 0.51,
  close,
  volume: 100000,
  amount: 100000 * close,
});

type DeliveryFill = AccountBook["facts"]["fills"][number];
function deliveryFill(
  id: string,
  security: string,
  quantity: number,
  balanceCash: number,
  rowIndex: number,
): DeliveryFill {
  return {
    id,
    account: "live",
    batchId: "import",
    kind: "buy",
    rowIndex,
    tradeDate: dates[0]!,
    tradeTime: "09:35:00",
    code: security.slice(2),
    symbol: security,
    instrument: "stock",
    name: null,
    quantity,
    price: 10,
    amount: quantity * 10,
    fees: { commission: 0, stampTax: 0, transferFee: 0, otherFee: 0, total: 0 },
    netAmount: -quantity * 10,
    balanceShares: quantity,
    balanceCash,
    orderId: null,
    dealId: null,
    businessFlag: null,
    summary: "",
    fingerprintSource: id,
    anomalies: [],
  };
}
function position(
  id: string,
  account: string,
  kind: AccountPosition["kind"],
  security: string,
  quantity: number,
  stop: number | null,
  groups: string[],
): AccountPosition {
  return {
    id,
    account,
    kind,
    market: "cn-equity",
    currency: "CNY",
    symbol: security,
    sleeve: "test",
    industry: "未知",
    industryGroups: groups,
    quantity,
    cost: 10,
    price: 10,
    value: quantity * 10,
    stop,
    at: terminalDate,
    strategyId: null,
    strategyVersion: null,
    reasons: [],
  };
}

function accountBook() {
  const fills = [
    deliveryFill("r1", symbol, 3000, 70000, 0),
    deliveryFill("r2", otherSymbol, 1000, 60000, 1),
  ];
  // Typed service fixture uses only the checkpoint fields read by these services.
  const paper = {
    id: "paper",
    market: "cn-equity",
    currency: "CNY",
    initial: 100000,
  };
  const paperState = {
    request: { calendar: dates, strategies: [], instruments: [] },
    result: {
      curve: [],
      fills: [],
      equity: dates.map((date) => ({ date, cash: 90000, equity: 100000 })),
    },
  };
  const trades: AccountTrade[] = [
    {
      id: "delivery:r1",
      account: "live",
      kind: "real",
      market: "cn-equity",
      symbol,
      side: "buy",
      date: dates[0]!,
      time: chinaTime(dates[0]!, "09:35:00"),
      timePrecision: "instant",
      price: 10,
      quantity: 3000,
      strategyId: "strategy",
      strategyVersion: 2,
      sleeve: "main",
      planId: "p",
      alertKey: null,
    },
  ];
  return {
    facts: {
      version: "fixture",
      fills,
      cashFlows: [],
      local: [],
      batches: [{ account: "live" }],
      crypto: [],
      paper: [
        { account: paper, state: paperState },
        {
          account: {
            ...paper,
            id: "paper-usdt",
            market: "crypto",
            currency: "USDT",
            initial: 8e8,
          },
          state: paperState,
        },
      ],
    },
    trades,
    positions: [
      position("real", "live", "real", symbol, 3000, 8, ["Bank", "Finance"]),
      position("unknown", "live", "real", otherSymbol, 1000, null, []),
      position("paper", "paper", "paper", otherSymbol, 1000, 9, []),
      position("simulation", "sim", "exchange-simulation", symbol, 900000, 1, [
        "Bank",
      ]),
      {
        ...position(
          "usdt",
          "paper-usdt",
          "paper",
          otherSymbol,
          800000,
          null,
          [],
        ),
        market: "crypto",
        currency: "USDT",
      },
    ],
    calendar: dates,
    context: { evidence: () => ({ coverageEnd: terminalDate, events: [] }) },
    bars: Object.fromEntries(
      [symbol, otherSymbol, entrySymbol].map((security) => [
        security,
        dates.map((date) => bar(date, 10)),
      ]),
    ),
    industrySource: null,
    industryBySymbol: new Map<string, string[]>(),
  } as unknown as AccountBook;
}

describe("account-backed read services", () => {
  it("retains associated trade provenance and reports missing frozen benchmarks and exact terminal marks", async () => {
    const book = accountBook();
    const result = await readImplementationShortfall(
      { account: "live", from: dates[0]!, to: "2026-11-22" },
      async () => book,
      at,
    );
    expect(result.status).toBe("incomplete");
    expect(result.reconciliation).toBeNull();
    expect(result.source).toMatchObject({
      kind: "account",
      trades: [{ tradeId: "delivery:r1", strategyId: "strategy", planId: "p" }],
    });
    expect(result.missing.map((reason) => reason.field)).toEqual(
      expect.arrayContaining(["frozenPlan", "terminalPrice"]),
    );
  });

  it("joins exact statement fees and a linked frozen plan while excluding paper and simulation fills", async () => {
    const book = accountBook();
    const first = dates[0]!;
    const { theoretical, executable, openingNav, commonTerminalValue } =
      ledgers();
    book.trades.push(
      { ...book.trades[0]!, id: "sim", kind: "exchange-simulation" },
      { ...book.trades[0]!, id: "paper", kind: "paper" },
    );
    const result = await readImplementationShortfall(
      {
        account: "live",
        from: first,
        to: terminalDate,
        frozenPlan: {
          openingNav,
          commonTerminalValue,
          terminalPrices: {},
          theoretical: [
            {
              ...theoretical[0]!,
              signalAt: chinaTime(first, "09:00:00"),
              quantity: 3000,
              fees: 1,
            },
          ],
          executable: [
            {
              ...executable[0]!,
              arrivalAt: chinaTime(first, "09:30:00"),
              arrivalPrice: 10,
              quantity: 3000,
              fees: 1,
            },
          ],
        },
      },
      async () => book,
      at,
    );
    expect(result.reconciliation?.amounts.totalShortfall.cny).toBe(-1);
    expect(result.rows[0]?.fills).toEqual([
      { tradeId: "delivery:r1", actualQuantity: 3000, matchedQuantity: 3000 },
    ]);
  });

  it.each([
    { scope: "real", account: "live", coverageEnd: null },
    { scope: "real", account: "live", coverageEnd: "2026-11-23" },
    { scope: "paper", account: "paper", coverageEnd: null },
    { scope: "paper", account: "paper", coverageEnd: "2026-11-23" },
  ] as const)(
    "withholds the $scope reconciliation when GBBQ coverage ends at $coverageEnd",
    async ({ account, scope, coverageEnd }) => {
      const book = accountBook();
      book.context.evidence = (security) => ({
        coverageEnd,
        events: [],
        source: `fixture ${security}`,
        bonusListings: undefined,
      });
      const { actual: _actual, terminalDate: _date, ...frozenPlan } = ledgers();
      const result = await readImplementationShortfall(
        { account, scope, from: "2026-11-23", to: terminalDate, frozenPlan },
        async () => book,
        at,
      );
      expect(result).toMatchObject({
        status: "incomplete",
        reconciliation: null,
      });
      expect(result.rows[0]?.reconciliation).toBeNull();
      expect(result.missing).toContainEqual({
        field: "corporateActionCoverage",
        symbol,
        reason: `GBBQ 公司行动覆盖截止日 ${coverageEnd ?? "未知"}，无法核验至估值结束日 ${terminalDate}`,
      });
    },
  );

  it("withholds reconciliation for an action recorded in the paper snapshot", async () => {
    const book = accountBook();
    book.facts.paper[0]!.state!.request.instruments = [
      {
        symbol,
        market: "cn-equity",
        bars: [],
        signalBars: [],
        execution: {},
        actions: [
          {
            date: terminalDate,
            availableAt: terminalDate,
            dividend: 0,
            bonus: 0.5,
            evidence: "frozen paper fixture",
          },
        ],
      },
    ];
    const { actual: _actual, terminalDate: _date, ...frozenPlan } = ledgers();
    const result = await readImplementationShortfall(
      {
        scope: "paper",
        account: "paper",
        from: "2026-11-23",
        to: terminalDate,
        frozenPlan,
      },
      async () => book,
      at,
    );
    expect(result).toMatchObject({
      status: "incomplete",
      reconciliation: null,
    });
    expect(result.rows[0]?.reconciliation).toBeNull();
    expect(result.missing).toContainEqual(
      expect.objectContaining({ field: "quantityUnit", symbol }),
    );
  });

  it("isolates real, CNY paper and exchange simulation, with 5% risk and 25% industry limits", async () => {
    const book = accountBook();
    const live = evaluateAccountPortfolioRisk(book, {}, at);
    expect(live).toMatchObject({
      status: "complete",
      scope: "real",
      accounts: ["live"],
      equityCny: 100000,
      cashCny: 60000,
      state: { mode: "normal", drawdown: 0 },
      stopRisk: {
        knownStopRiskCny: 6000,
        estimatedMissingStopRiskCny: 1000,
        totalStopRiskCny: 7000,
        weight: 0.07,
        limit: 0.05,
        exceeded: true,
        missingStopPositions: [{ id: "unknown", symbol: otherSymbol }],
      },
    });
    expect(live.industries).toEqual([
      {
        key: "Bank",
        marketValueCny: 30000,
        weight: 0.3,
        limit: 0.25,
        exceeded: true,
      },
      {
        key: "Finance",
        marketValueCny: 30000,
        weight: 0.3,
        limit: 0.25,
        exceeded: true,
      },
      {
        key: "unknown",
        marketValueCny: 10000,
        weight: 0.1,
        limit: 0.25,
        exceeded: false,
      },
    ]);
    expect(
      live.instruments.find((group) => group.key === symbol),
    ).toMatchObject({ weight: 0.3, limit: 0.1, exceeded: true });
    expect(
      evaluateAccountPortfolioRisk(
        book,
        { policy: { missingStopFraction: null } },
        at,
      ).stopRisk.totalStopRiskCny,
    ).toBeNull();
    const paper = evaluateAccountPortfolioRisk(book, { scope: "paper" }, at);
    expect(paper).toMatchObject({
      status: "complete",
      accounts: ["paper"],
      currency: "CNY",
      cashCny: 90000,
      stopRisk: { totalStopRiskCny: 1000, missingStopPositions: [] },
    });
    const riskCap = await simulateAccountEntrySizing(
      book,
      { symbol: entrySymbol, price: 10, stopPrice: 8 },
      at,
    );
    expect(riskCap.sizing).toMatchObject({
      quantity: 0,
      reasons: ["total_stop_risk_cap", "lot_rounded_zero"],
    });
    const industryCap = await simulateAccountEntrySizing(
      book,
      {
        symbol: entrySymbol,
        price: 10,
        stopPrice: 8,
        industry: "Finance",
        policy: { maxTotalStopRisk: 0.2 },
      },
      at,
    );
    expect(industryCap.sizing).toMatchObject({
      quantity: 0,
      reasons: ["industry_cap", "lot_rounded_zero"],
    });
  });

  it("replays normal, reduced, paused and three qualifying closes without advancing on a partial day", async () => {
    const book = accountBook();
    book.facts.fills = [deliveryFill("r1", symbol, 10000, 0, 0)];
    const marks = [10, 9.5, 9.2, 9.7, 9.8, 9.9];
    book.bars[symbol] = marks.map((mark, i) => bar(dates[i]!, mark));
    for (const [i, [mode, days]] of [
      ["normal", 0],
      ["reduced", 3],
      ["paused", 3],
      ["paused", 2],
      ["paused", 1],
      ["normal", 0],
    ].entries()) {
      book.positions = [
        {
          ...position("real", "live", "real", symbol, 10000, 8, []),
          price: marks[i]!,
          value: 10000 * marks[i]!,
          at: dates[i]!,
        },
      ];
      const snapshot = evaluateAccountPortfolioRisk(
        book,
        {},
        chinaTime(dates[i]!, "15:10:00"),
      );
      expect(snapshot.state?.mode).toBe(mode);
      expect(snapshot.recoveryDaysRemaining).toBe(days);
      if (i === 2) {
        expect(
          (
            await simulateAccountEntrySizing(
              book,
              { symbol: entrySymbol, price: 10, stopPrice: 8 },
              chinaTime(dates[i]!, "15:10:00"),
            )
          ).sizing,
        ).toMatchObject({ quantity: 0, reasons: ["drawdown_paused"] });
      }
    }
    expect(
      evaluateAccountPortfolioRisk(book, {}, chinaTime(dates[5]!, "14:59:00"))
        .state?.mode,
    ).toBe("paused");
  });

  it("computes Wilder ATR(14) from completed bars and rounds 245.09 shares down to 200", async () => {
    const result = await simulateAccountEntrySizing(
      accountBook(),
      { scope: "paper", symbol: entrySymbol, price: 10 },
      at,
    );
    expect(result).toMatchObject({
      status: "complete",
      atrSource: "wilder14",
      asOf: terminalDate,
    });
    expect(result.atr).toBeCloseTo(1.02, 10);
    expect(result.sizing).toMatchObject({
      quantity: 200,
      notionalCny: 2000,
      estimatedFeesCny: 5.02,
      cashRequiredCny: 2005.02,
      reasons: ["trade_risk_cap"],
    });
    expect(result.sizing?.stopPrice).toBeCloseTo(7.96, 10);
    expect(result.sizing?.tradeRiskCny).toBeCloseTo(408, 9);
  });

  it.each([
    [entrySymbol, 1000, 0, 0, ["cash_cap", "lot_rounded_zero"]],
    [entrySymbol, 1005, 0, 0, ["cash_cap", "lot_rounded_zero"]],
    [entrySymbol, 1005.01, 100, 5.01, []],
    [entrySymbol, 1005.1, 100, 5.01, []],
    ["sh510300", 1005, 100, 5, []],
  ] as const)(
    "sizes %s with %d CNY cash to %d shares including buy fees",
    async (security, cash, quantity, fees, reasons) => {
      const book = accountBook();
      const paper = book.facts.paper[0]!;
      paper.account.initial = cash + 10000;
      for (const day of paper.state!.result.equity) {
        day.cash = cash;
        day.equity = paper.account.initial;
      }
      const result = await simulateAccountEntrySizing(
        book,
        {
          scope: "paper",
          symbol: security,
          price: 10,
          stopPrice: 9.9,
          industry: "entry",
          policy: { maxTotalStopRisk: 0.2 },
          requestedQuantity: 100,
        },
        at,
      );
      expect(result).toMatchObject({
        status: "complete",
        sizing: {
          quantity,
          notionalCny: quantity * 10,
          estimatedFeesCny: fees,
          cashRequiredCny: quantity * 10 + fees,
          reasons,
        },
      });
    },
  );

  it("preserves the last close's tier but withholds sizing after a newer intraday fill", async () => {
    const book = accountBook();
    const intraday = chinaTime(terminalDate, "13:00:00");
    const lastClose = dates.at(-2)!;
    for (const position of book.positions) position.at = lastClose;
    book.trades.push({
      ...book.trades[0]!,
      id: "intraday",
      date: terminalDate,
      time: intraday,
    });
    const result = evaluateAccountPortfolioRisk(book, {}, intraday);
    expect(result).toMatchObject({
      status: "incomplete",
      asOf: lastClose,
      state: { mode: "normal" },
      stopRisk: { totalStopRiskCny: null },
    });
    expect(result.reasons).toContain(
      "账本已有收盘点之后的成交或资金变动，资金与持仓待同日估值",
    );
    expect(
      (
        await simulateAccountEntrySizing(
          book,
          { symbol: entrySymbol, price: 10, stopPrice: 8 },
          intraday,
        )
      ).sizing,
    ).toBeNull();
  });

  it("uses frozen paper units to remove a cash transfer before recalculating the tier", () => {
    const book = accountBook();
    const state = book.facts.paper[0]!.state!;
    state.request.externalCashFlows = [
      { date: terminalDate, sleeve: "main", amount: 20000 },
    ];
    state.result.equity.at(-1)!.cash = 102000;
    state.result.equity.at(-1)!.equity = 112000;
    // The closing equity rose from 100000 to 112000, but its adjusted unit
    // NAV fell 8%. Replay the frozen units under the dashboard's own policy.
    state.result.riskAudit = {
      daily: dates.map((date) => ({
        date,
        unitNav: date === terminalDate ? 0.92 : 1,
        peakUnitNav: 1,
        drawdown: date === terminalDate ? 0.08 : 0,
        mode: "normal",
        scale: 1,
        recoveryCloses: 0,
      })),
      missingCloses: [],
      blocked: 0,
      reduced: 0,
      reductions: [],
      entries: [],
    };
    expect(
      evaluateAccountPortfolioRisk(book, { scope: "paper" }, at),
    ).toMatchObject({
      equityCny: 112000,
      state: { unitNav: 0.92, drawdown: 0.08, mode: "paused" },
    });
    delete state.result.riskAudit;
    expect(
      evaluateAccountPortfolioRisk(book, { scope: "paper" }, at),
    ).toMatchObject({ status: "incomplete", state: null });
  });

  it("returns the explicit report through the normal read caller", async () => {
    const caller = portfolioReviewRouter.createCaller({
      headers: new Headers(),
    });
    const result = await caller.implementationShortfall({ ledgers: ledgers() });
    expect(result.source.kind).toBe("explicit");
    expect(result.reconciliation?.amounts.totalShortfall.cny).toBe(215);
  });

  it("reconciles a valid frozen plan over 20 KiB through the POST JSON transport", async () => {
    const { actual: _actual, terminalDate: _date, ...frozenPlan } = ledgers();
    const plan = frozenPlan.theoretical[0]!;
    const baseline = frozenPlan.executable[0]!;
    const instructionIds = Array.from(
      { length: 100 },
      (_, i) => `frozen-plan-instruction-${i}`,
    );
    frozenPlan.theoretical = instructionIds.map((id) => ({ ...plan, id }));
    frozenPlan.executable = instructionIds.map((instructionId) => ({
      ...baseline,
      instructionId,
    }));
    const input = {
      account: "live",
      from: "2026-11-23",
      to: terminalDate,
      frozenPlan,
    };
    expect(Buffer.byteLength(JSON.stringify(frozenPlan))).toBeGreaterThan(
      20 * 1024,
    );
    const readBook = vi
      .spyOn(portfolioRiskService, "loadReadOnlyAccountBook")
      .mockResolvedValue(accountBook());
    try {
      const client = createTRPCClient<typeof portfolioReviewRouter>({
        links: [
          httpBatchStreamLink({
            transformer: SuperJSON,
            url: "http://localhost/api/trpc",
            fetch: async (url, init) => {
              const req = new Request(url, init);
              expect(req.method).toBe("POST");
              expect(new URL(req.url).searchParams.has("input")).toBe(false);
              expect(
                Buffer.byteLength(await req.clone().text()),
              ).toBeGreaterThan(20 * 1024);
              return fetchRequestHandler({
                endpoint: "/api/trpc",
                req,
                router: portfolioReviewRouter,
                createContext: () => ({ headers: req.headers }),
              });
            },
          }),
        ],
      });
      const result = await client.implementationShortfall.mutate(input);
      expect(result).toMatchObject({
        source: { kind: "account", account: "live" },
        status: "complete",
        reconciliation: {
          theoreticalTerminalValue: 129500,
          executableTerminalValue: 119300,
          actualTerminalValue: 100000,
          terminalDiff: -29500,
          amounts: { totalShortfall: { cny: 29500 } },
        },
      });
      expect(result.rows).toHaveLength(instructionIds.length);
    } finally {
      readBook.mockRestore();
    }
  });

  it("binds each added tRPC endpoint to portfolio read", () => {
    for (const [route, type] of [
      [accountsRouter.accountPortfolioRisk, "query"],
      [accountsRouter.accountEntrySizingPreview, "query"],
      [portfolioReviewRouter.implementationShortfall, "mutation"],
    ] as const) {
      expect(route._def.type).toBe(type);
      expect(route._def.meta).toEqual({
        capability: "portfolio",
        operation: "read",
      });
    }
  });
});

describe("automatic local execution shortfall", () => {
  async function withExecution(
    runTest: (
      db: Database.Database,
      account: string,
      foreign: string,
    ) => Promise<void>,
    carryPosition = false,
  ) {
    const db = new Database(":memory:");
    const clock = vi.spyOn(Date, "now").mockReturnValue(signalAt);
    try {
      migrate(db);
      setGlobalAutoSimEnabled(true, db);
      const submit = async (name: string, referencePrice: number) => {
        clock.mockReturnValue(signalAt);
        const { id: account } = createSimAccount(
          { name, market: "cn-equity", initialCapital: "10000" },
          db,
        );
        if (carryPosition && name === "first") {
          executePipelineSimOrder(
            {
              accountId: account,
              clientRequestId: "prior",
              symbol: otherSymbol,
              side: "buy",
              quantity: 100,
              price: 9,
              tradeDate: "2026-11-23",
            },
            db,
            signalAt,
          );
        }
        const dep = createDeployment(
          {
            name,
            market: "cn-equity",
            status: "active",
            executionMode: "auto_sim",
            strategySpec: { kind: "study-rule", strategyId: "breakout" },
            universeSpec: { kind: "fixed-symbols", symbols: [symbol] },
            regimeGate: { kind: "none" },
            riskPolicy: { maxGapPct: 0.1 },
            venueBinding: { kind: "local_sim", simAccountId: account },
            schedule: { kind: "manual_only" },
            provenance: { sourceKind: "manual" },
          },
          db,
        );
        const { run } = getOrCreatePipelineRun(
          {
            deploymentId: dep.id,
            decisionDate: "2026-11-23",
            executeDate: terminalDate,
            triggerKind: "manual",
          },
          db,
        );
        insertOrderIntents(
          run.id,
          [
            {
              runId: run.id,
              deploymentId: dep.id,
              venueKind: "local_sim",
              symbol,
              phase: 2,
              side: "BUY",
              quantity: 100,
              referencePrice,
            },
          ],
          db,
        );
        clock.mockReturnValue(filledAt);
        await executePipelineRun(
          {
            runId: run.id,
            executeDate: terminalDate,
            deps: {
              now: () => filledAt,
              readQuote: async (requestedSymbol) => ({
                symbol: requestedSymbol,
                tradeDate: terminalDate,
                observedAt: filledAt,
                openPrice: 10.2,
                lastPrice: 10.2,
                prevClose: 10,
                upperLimit: 11,
                lowerLimit: 9,
                suspended: false,
              }),
            },
          },
          db,
        );
        return account;
      };
      await runTest(
        db,
        await submit("first", 10),
        await submit("second", 10.1),
      );
    } finally {
      clock.mockRestore();
      db.close();
    }
  }
  const report = (
    db: Database.Database,
    account: string,
    scope: "local_sim" | "ths_mock" = "local_sim",
    from = terminalDate,
  ) =>
    readImplementationShortfall(
      { scope, account, from, to: terminalDate },
      async () => {
        const fixture = accountBook();
        const book = await loadAccountBook(
          new AccountWorkspaceRepository(db),
          undefined,
          at,
          {
            bars: fixture.bars,
            context: { ...fixture.context, calendar: fixture.calendar },
          },
        );
        // The fixture also supplies terminal marks for proposals clipped to
        // zero. Those instruments never appear in the account's trade list.
        return { ...book, bars: { ...fixture.bars, ...book.bars } };
      },
      at,
      db,
    );

  it.each([
    {
      maxWeight: 0.15,
      planned: 600,
      price: 9,
      executable: 500,
      opportunityCost: 500,
    },
    {
      maxWeight: 0.01,
      planned: 0,
      price: 9,
      executable: 0,
      opportunityCost: 1000,
    },
    {
      maxWeight: 0.025,
      planned: 100,
      price: 9.18,
      executable: 0,
      opportunityCost: 1000,
    },
  ])(
    "理论 1000 股，计划 $planned 股，到达价 $price 元，成交 $executable 股，三账残差为零",
    async ({ maxWeight, planned, price, executable, opportunityCost }) => {
      const decisionDate = "2026-10-30",
        executeDate = "2026-11-02";
      const clock = vi
        .spyOn(Date, "now")
        .mockReturnValue(chinaTime(decisionDate, "16:00:00"));
      const db = new Database(":memory:");
      try {
        migrate(db);
        setGlobalAutoSimEnabled(true, db);
        const { id: account } = createSimAccount(
          { name: "规则裁剪", market: "cn-equity", initialCapital: "36000" },
          db,
        );
        const dep = createDeployment(
          {
            name: "月末配置",
            market: "cn-equity",
            status: "active",
            executionMode: "auto_sim",
            strategySpec: { kind: "macro-clock" },
            universeSpec: { kind: "fixed-symbols", symbols: [symbol] },
            regimeGate: { kind: "none", unlockAvoidanceDays: 0 },
            riskPolicy: { maxSymbolWeight: maxWeight },
            venueBinding: { kind: "local_sim", simAccountId: account },
            schedule: { kind: "manual_only" },
            provenance: { sourceKind: "manual" },
          },
          db,
        );
        const { run, intents } = await runPipelinePlanning(
          {
            deploymentId: dep.id,
            decisionDate,
            executeDate,
            triggerKind: "manual",
            deps: {
              universe: { readBars: () => [] },
              readReferencePrice: () => 9,
              strategy: {
                readTradingSessions: () => [decisionDate, executeDate],
                resolveMacroClock: () => ({
                  regime: "recovery",
                  targets: { [symbol]: 0.25 },
                }),
              },
            },
          },
          db,
        );
        expect(run.riskVerdict).toMatchObject({
          theoreticalOrders: [
            {
              symbol,
              side: "BUY",
              theoreticalQuantity: 1000,
              referencePrice: 9,
            },
          ],
        });
        expect(intents.map((i) => i.quantity)).toEqual(
          planned ? [planned] : [],
        );
        clock.mockReturnValue(chinaTime(executeDate, "09:35:00"));
        await executePipelineRun(
          {
            runId: run.id,
            executeDate,
            deps: {
              readQuote: () => ({
                symbol,
                tradeDate: executeDate,
                observedAt: Date.now(),
                openPrice: price,
                lastPrice: price,
                upperLimit: 9.9,
                lowerLimit: 8.1,
                prevClose: 9,
                suspended: false,
              }),
            },
          },
          db,
        );
        const result = await report(db, account, "local_sim", executeDate);
        expect(result.missing).toEqual([]);
        expect(result.rows).toMatchObject([
          {
            theoreticalQuantity: 1000,
            executableQuantity: executable,
            matchedQuantity: executable,
          },
        ]);
        const rec = result.reconciliation!;
        expect(rec.amounts.missedTradeOpportunityCost.cny).toBe(
          opportunityCost,
        );
        expect(
          shortfallComponentKeys.reduce(
            (cents, key) => cents + Math.round(rec.amounts[key].cny * 100),
            Math.round(rec.terminalDiff * 100),
          ),
        ).toBe(0);
      } finally {
        db.close();
        clock.mockRestore();
      }
    },
  );

  it("reconciles the five costs exactly to actual settled cash and ignores the other account's identical fill sequence", async () => {
    await withExecution(async (db, account, foreign) => {
      const result = await report(db, account);
      expect(result.missing).toEqual([]);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.fills[0]?.matchedQuantity).toBe(100);
      const row = db
        .prepare<[string], { fees: number; slippage: number; cash: number }>(
          `SELECT (commission_atoms+transfer_atoms+tax_atoms)/100.0 fees, slippage_atoms/100.0 slippage,
      (SELECT SUM(delta_atoms) FROM sim_cash_flows WHERE account_id=f.account_id)/100.0 cash FROM sim_fills f WHERE account_id=?`,
        )
        .get(account)!;
      const rec = result.reconciliation!;
      expect(rec.actualTerminalValue).toBe(row.cash + 100 * 10);
      expect(rec.amounts.signalToArrivalDelay.cny).toBe(20);
      expect(rec.amounts.feeDifference.cny).toBe(row.fees);
      expect(row.slippage).toBeGreaterThan(0);
      expect(rec.amounts.arrivalToFillSlippage.cny).toBe(row.slippage);
      const cents = (amount: number) => Math.round(amount * 100);
      expect(
        shortfallComponentKeys.reduce(
          (total, key) => total + cents(rec.amounts[key].cny),
          cents(rec.terminalDiff),
        ),
      ).toBe(0);
      const other = await report(db, foreign);
      expect(other.reconciliation?.amounts.signalToArrivalDelay.cny).toBe(10);
      expect(other.rows[0]?.fills[0]?.tradeId).not.toBe(
        result.rows[0]?.fills[0]?.tradeId,
      );
    });
  });
  it("values a carry-in holding at the prior close and keeps the previous fill outside current-window attribution", async () => {
    await withExecution(async (db, account) => {
      const result = await report(db, account);
      const cash = db
        .prepare<[number, string], { prior: number; current: number }>(
          `SELECT
        SUM(CASE WHEN occurred_at < ? THEN delta_atoms ELSE 0 END)/100.0 prior,
        SUM(delta_atoms)/100.0 current FROM sim_cash_flows WHERE account_id=?`,
        )
        .get(arrivalAt, account)!;
      expect(result.status).toBe("complete");
      expect(result.rows).toHaveLength(1);
      expect(result.openingNav).toBe(cash.prior + 100 * 10);
      expect(result.reconciliation?.actualTerminalValue).toBe(
        cash.current + 200 * 10,
      );
    }, true);
  });
  it("resolves a scoped order-only link and keeps ticket-only evidence separate from executable quantities", async () => {
    await withExecution(async (db, account) => {
      db.prepare(
        "UPDATE execution_fill_links SET intent_id=NULL WHERE account_id=?",
      ).run(account);
      expect((await report(db, account)).status).toBe("complete");
      const order = {
        symbol,
        side: "buy",
        quantity: 200,
        atrStopPrice: 9,
        maxBuyPrice: 11,
        conditional: false,
        riskChecks: [
          {
            code: "ticket.estimate.v1",
            status: "passed",
            detail: JSON.stringify({ close: 9.5, estimatedFeesCny: 5 }),
          },
        ],
      };
      db.prepare(
        `INSERT INTO rebalance_plans
        (id,account_scope,account_id,source_kind,source_ref_id,as_of_date,execute_date,status,orders_json,risk_summary_json,expires_at,created_at,updated_at)
        VALUES ('ticket','paper','original','manual','source','2026-11-23',?,'confirmed',?,'{}',?,?,?)`,
      ).run(terminalDate, JSON.stringify([order]), at, signalAt, signalAt);
      db.prepare(
        "UPDATE execution_order_intents SET venue_order_id=NULL WHERE json_extract(venue_binding_json,'$.simAccountId')=?",
      ).run(account);
      db.prepare(
        "UPDATE execution_fill_links SET rebalance_plan_id='ticket' WHERE account_id=?",
      ).run(account);
      const ticket = await report(db, account);
      const row = ticket.rows.find(
        (r) => r.instructionId === JSON.stringify(["ticket", symbol, "buy"]),
      );
      expect(row).toMatchObject({
        theoreticalQuantity: 200,
        nominalCny: 1900,
        executableQuantity: null,
      });
      expect(row?.fills).toHaveLength(1);
      expect(ticket.reconciliation).toBeNull();
    });
  });
  it("keeps absent arrival, missing scoped links and unverified THS fills incomplete", async () => {
    await withExecution(async (db, account, foreign) => {
      db.prepare(
        "UPDATE execution_fill_links SET arrival_price=NULL WHERE account_id=?",
      ).run(account);
      const absent = await report(db, account);
      expect(absent.missing.map((m) => m.field)).toContain("arrivalPrice");
      expect(absent.reconciliation).toBeNull();
      db.prepare("DELETE FROM execution_fill_links WHERE account_id=?").run(
        account,
      );
      const legacy = await report(db, account);
      expect(legacy.missing.map((m) => m.field)).toContain("fillLink");
      expect(legacy.reconciliation).toBeNull();
      expect((await report(db, foreign)).status).toBe("complete");
      const ths = await report(db, account, "ths_mock");
      expect(ths.missing.map((m) => m.field)).toContain("actualFills");
      expect(ths.rows).toEqual([]);
    });
  });
});
