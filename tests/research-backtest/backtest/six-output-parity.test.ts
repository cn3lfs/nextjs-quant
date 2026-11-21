import { expect, it } from "vitest";
import {
  ExecutionLedger,
  postPortfolioFill,
  runPortfolio,
} from "quant-backtest";
import { atomsFrom } from "quant-execution";
import {
  allocationSymbol,
  costs,
  dates,
  initialTargetHash,
  limitUpSymbol,
  protectedSymbol,
  rebalanceTargetHash,
  sixOutputRequest,
  terminalEvidence,
} from "../../helpers/six-output-parity";

const [signal, entry, dividend, bonus, lastClose, end] = dates;
const limitReason = "开盘涨停，无法证明买入成交";
const settlementReason = "T+1：当日买入不可卖出";

function fees(gross: number, side: "buy" | "sell") {
  return {
    commission: Math.max(
      costs.minimumCommission,
      (gross * costs.commissionBps) / 10_000,
    ),
    transfer: (gross * costs.transferBps) / 10_000,
    tax: side === "sell" ? (gross * costs.sellTaxBps) / 10_000 : 0,
  };
}

it("audits scheduled buys and a target reduction, a locked-limit buy, and a T+1 stop retry", () => {
  const { orders, fills, rejections } = runPortfolio(sixOutputRequest(true));
  expect(orders).toStrictEqual([
    {
      id: 1,
      strategyId: "stop-loss",
      sleeve: "tactical",
      symbol: protectedSymbol,
      side: "buy",
      signalAt: signal,
      due: entry,
      trigger: "signal",
      status: "filled",
      reason: null,
      attempts: 1,
    },
    {
      id: 2,
      strategyId: "targets",
      sleeve: "allocation",
      symbol: allocationSymbol,
      side: "buy",
      signalAt: signal,
      due: entry,
      trigger: "signal",
      status: "filled",
      reason: null,
      attempts: 1,
      targetWeight: 0.4,
      targetSourceHash: initialTargetHash,
    },
    {
      id: 3,
      strategyId: "targets",
      sleeve: "allocation",
      symbol: limitUpSymbol,
      side: "buy",
      signalAt: signal,
      due: entry,
      trigger: "signal",
      status: "rejected",
      reason: limitReason,
      attempts: 1,
      targetWeight: 0.2,
      targetSourceHash: initialTargetHash,
    },
    {
      id: 4,
      strategyId: "stop-loss",
      sleeve: "tactical",
      symbol: protectedSymbol,
      side: "sell",
      signalAt: entry,
      due: entry,
      trigger: "stop",
      status: "filled",
      reason: null,
      attempts: 2,
    },
    {
      id: 5,
      strategyId: "targets",
      sleeve: "allocation",
      symbol: allocationSymbol,
      side: "sell",
      signalAt: dividend,
      due: bonus,
      trigger: "signal",
      status: "filled",
      reason: null,
      attempts: 1,
      targetWeight: 0.2,
      targetSourceHash: rebalanceTargetHash,
    },
  ]);
  expect(rejections).toStrictEqual([
    { orderId: 3, date: entry, reason: limitReason },
    { orderId: 4, date: entry, reason: settlementReason },
  ]);

  // 40% of 12,000 at 10 and 30% of 8,000 at 20 are rounded to 100-share lots.
  // The reduction targets 20% of (8,170.40 cash + 600 shares at 6.25),
  // rounded down to 300 shares. The 200 new bonus shares remain locked that day.
  const expected = [
    { orderId: 2, date: entry, price: 10, quantity: 400 },
    { orderId: 1, date: entry, price: 20, quantity: 100 },
    { orderId: 4, date: dividend, price: 19, quantity: 100 },
    { orderId: 5, date: bonus, price: 6.25, quantity: 300 },
  ];
  expect(fills).toStrictEqual(
    expected.map((fill) => {
      const { strategyId, sleeve, symbol, side, signalAt } =
        orders[fill.orderId - 1]!;
      return {
        ...fill,
        strategyId,
        sleeve,
        symbol,
        side,
        signalAt,
        fee: expect.any(Number),
        cashAfter: expect.any(Number),
        holdingAfter: expect.any(Number),
      };
    }),
  );
});

it("conserves cash and inventory through every fill, ex-date action, and curve row", () => {
  const request = sixOutputRequest(true);
  const result = runPortfolio(request);
  const { actions } = request.instruments[0]!;

  // Research cash and share credits occur before the ex-date open.
  const originalCost = (400 * 10 + 8 + 1.6) / 400;
  const netDividend = 400 * 0.5 * (1 - 0.1);
  const exDividendCost = (400 * originalCost - netDividend) / 400;
  expect(result.corporateActions).toMatchObject([
    {
      date: dividend,
      symbol: allocationSymbol,
      strategyId: "targets",
      evidence: actions![0]!.evidence,
      cashAvailableAt: dividend,
      timingAssumption: "ex-date-research-scenario",
      before: 400,
      quantity: 400,
      cash: netDividend,
      costBefore: expect.closeTo(originalCost, 10),
      costAfter: expect.closeTo(exDividendCost, 10),
      markAfter: 9.5,
      fractionalShares: 0,
      rightsParticipation: "none",
    },
    {
      date: bonus,
      symbol: allocationSymbol,
      strategyId: "targets",
      evidence: actions![1]!.evidence,
      cashAvailableAt: bonus,
      timingAssumption: "ex-date-research-scenario",
      before: 400,
      quantity: 400 * 1.5,
      cash: 0,
      costBefore: expect.closeTo(exDividendCost, 10),
      costAfter: expect.closeTo(exDividendCost / 1.5, 10),
      markAfter: expect.closeTo(9.5 / 1.5, 10),
      fractionalShares: 0,
      rightsParticipation: "none",
    },
  ]);

  const cash = { allocation: 12_000, tactical: 8_000 };
  const inventory = new Map<string, number>();
  const cashDeltas: number[] = [];
  const closes = [
    [10, 20],
    [10, 20.25],
    [9.5, 19.25],
    [6.4, 0],
    [6.8, 0],
    [6.8, 0],
  ] as const;
  const expectedCurve = dates.map((date, index) => {
    for (const action of result.corporateActions.filter(
      (row) => row.date === date,
    )) {
      expect(inventory.get(action.symbol)).toBe(action.before);
      cash.allocation += action.cash;
      inventory.set(action.symbol, action.quantity);
      cashDeltas.push(action.cash);
    }
    for (const fill of result.fills.filter((row) => row.date === date)) {
      const sleeve = fill.sleeve as keyof typeof cash;
      const sign = fill.side === "buy" ? 1 : -1;
      const gross = fill.quantity * fill.price;
      const { commission, transfer, tax } = fees(gross, fill.side);
      const fee = commission + transfer + tax;
      const delta = -sign * gross - fee;
      cash[sleeve] += delta;
      cashDeltas.push(delta);
      const holding = (inventory.get(fill.symbol) ?? 0) + sign * fill.quantity;
      inventory.set(fill.symbol, holding);
      expect(fill.fee).toBeCloseTo(fee, 10);
      expect(fill.cashAfter).toBeCloseTo(cash[sleeve], 8);
      expect(fill.holdingAfter).toBe(holding);
    }
    for (const terminal of result.terminalValuations.filter(
      (row) => row.date === date,
    )) {
      expect(inventory.get(terminal.symbol)).toBe(terminal.quantity);
      cash.allocation += terminal.amount;
      cashDeltas.push(terminal.amount);
      inventory.delete(terminal.symbol);
    }
    const [allocationClose, tacticalClose] = closes[index]!;
    const allocationEquity =
      cash.allocation +
      (inventory.get(allocationSymbol) ?? 0) * allocationClose;
    const tacticalEquity =
      cash.tactical + (inventory.get(protectedSymbol) ?? 0) * tacticalClose;
    return {
      date,
      cash: expect.closeTo(cash.allocation + cash.tactical, 8),
      equity: expect.closeTo(allocationEquity + tacticalEquity, 8),
      sleeves: [
        {
          id: "allocation",
          cash: expect.closeTo(cash.allocation, 8),
          equity: expect.closeTo(allocationEquity, 8),
        },
        {
          id: "tactical",
          cash: expect.closeTo(cash.tactical, 8),
          equity: expect.closeTo(tacticalEquity, 8),
        },
      ],
    };
  });
  expect(result.curve).toStrictEqual(expectedCurve);
  const finalCash = result.curve.at(-1)!.cash;
  expect(finalCash).toBeCloseTo(
    request.initial + cashDeltas.reduce((sum, delta) => sum + delta, 0),
    8,
  );
  expect(finalCash).toBeCloseTo(19_966.58, 8);
});

it("uses the evidenced last close for terminal cash and keeps shares open when evidence is absent", () => {
  const terminal = runPortfolio(sixOutputRequest(true));
  const open = runPortfolio(sixOutputRequest(false));
  const quantity = 400 - 300 + 400 * 0.5;
  const amount = quantity * 6.8;
  expect(terminal.terminalValuations).toStrictEqual([
    {
      date: lastClose,
      symbol: allocationSymbol,
      strategyId: "targets",
      sleeve: "allocation",
      quantity,
      price: 6.8,
      amount,
      evidence: terminalEvidence,
    },
  ]);
  expect(terminal.positions).toEqual([]);
  expect(open.terminalValuations).toStrictEqual([]);
  expect(open.positions).toMatchObject([
    {
      sleeve: "allocation",
      symbol: allocationSymbol,
      quantity,
      lots: [
        { quantity: 100, bought: entry },
        { quantity: 200, bought: bonus, availableOn: lastClose },
      ],
    },
  ]);
  expect(open.fills).toStrictEqual(terminal.fills);
  expect(open.curve.slice(0, dates.indexOf(lastClose))).toStrictEqual(
    terminal.curve.slice(0, dates.indexOf(lastClose)),
  );
  expect(open.curve.at(-1)).toMatchObject({
    date: end,
    cash: expect.closeTo(17_926.58, 8),
    equity: expect.closeTo(19_966.58, 8),
  });
  expect(terminal.curve.at(-1)!.cash).toBeCloseTo(
    open.curve.at(-1)!.cash + amount,
    8,
  );
  const instrument = sixOutputRequest(true).instruments[0]!;
  instrument.terminal!.evidence = "";
  const request = sixOutputRequest(false);
  expect(() =>
    runPortfolio({
      ...request,
      instruments: [instrument, ...request.instruments.slice(1)],
    }),
  ).toThrow("Invalid terminal sensitivity evidence/date");
});

it("replays each sleeve's fills and entitlements through the bigint ledger", () => {
  // The bigint ledger replays market fills and corporate actions. The paired
  // terminal test accounts for the separate last-close cash adjustment.
  const request = sixOutputRequest(false);
  const result = runPortfolio(request);
  const money = (value: number) => {
    const cents = Math.round(value * 100);
    expect(value).toBeCloseTo(cents / 100, 8);
    return atomsFrom(request.market, value.toFixed(2), "money");
  };
  const { actions } = request.instruments[0]!;
  const ledgers = new Map(
    request.sleeves.map(({ id, share }) => [
      id,
      new ExecutionLedger(request.market, money(request.initial * share), {
        ...costs,
        minimumCommission: money(costs.minimumCommission),
      }),
    ]),
  );
  const allocation = ledgers.get("allocation")!;
  for (const row of result.curve) {
    for (const action of actions!.filter((event) => event.date === row.date)) {
      const before = allocation
        .snapshot()
        .positions.find(({ symbol }) => symbol === allocationSymbol)!;
      allocation.applyCorporateAction({
        date: action.date,
        symbol: allocationSymbol,
        evidence: action.evidence,
        cashPerShare: money(action.dividend),
        shareFactor: 1,
        shareDelta: BigInt(Math.floor(Number(before.quantity) * action.bonus)),
        sharesSellableAt: action.sharesSellableAt,
      });
      if (action.date === bonus)
        expect(allocation.sellable(allocationSymbol, row.date)).toBe(400n);
    }
    for (const fill of result.fills.filter(({ date }) => date === row.date)) {
      const ledger = ledgers.get(fill.sleeve)!;
      const settledCashChange =
        Number(money(fill.cashAfter) - ledger.cash) / 100;
      postPortfolioFill(
        ledger,
        {
          ...fill,
          orderId: String(fill.orderId),
          ...fees(fill.quantity * fill.price, fill.side),
          settledCashChange,
        },
        1,
      );
      expect(ledger.cash).toBe(money(fill.cashAfter));
      const position = ledger
        .snapshot()
        .positions.find(({ symbol }) => symbol === fill.symbol);
      expect(position?.quantity ?? 0n).toBe(BigInt(fill.holdingAfter));
    }
    for (const sleeve of row.sleeves)
      expect(ledgers.get(sleeve.id)!.cash).toBe(money(sleeve.cash));
  }
  for (const [sleeve, ledger] of ledgers) {
    expect(
      ledger
        .snapshot()
        .positions.map(({ symbol, quantity }) => ({ symbol, quantity })),
    ).toEqual(
      result.positions
        .filter((position) => position.sleeve === sleeve)
        .map(({ symbol, quantity }) => ({
          symbol,
          quantity: BigInt(quantity),
        })),
    );
  }
});
