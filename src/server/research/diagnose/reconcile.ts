import {
  portfolioObservationDay,
  type PortfolioRequest,
  type runPortfolio,
} from "quant-backtest";
import {
  actionPrice,
  ExecutionLedger,
  formatDecimal,
  parseDecimal,
} from "quant-execution";
import { marketRules } from "trading-strategy-core/market-rules";
import { big } from "trading-strategy-core/money";

type Result = ReturnType<typeof runPortfolio>;
type Value = number | string | null;
export type ReconciliationMismatch = {
  date: string;
  field: string;
  expected: Value;
  actual: Value;
};

// The research receipt accepts 1e-8 of settlement drift. At large balances
// allow one number ULP too, since exported balances are no longer atoms.
const tolerance = 1e-8;
const decimal = (atoms: bigint, digits: number) =>
  Number(formatDecimal(atoms, digits));
const cash = (ledger: ExecutionLedger) =>
  decimal(ledger.cash, ledger.cashDecimals);
const positionKey = (strategy: string, symbol: string) =>
  JSON.stringify([strategy, symbol]);

function byDate<T extends { date: string }>(rows: readonly T[]) {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const group = grouped.get(row.date);
    if (group) group.push(row);
    else grouped.set(row.date, [row]);
  }
  return grouped;
}

function transfer(ledger: ExecutionLedger, amount: number) {
  const digits = ledger.cashDecimals;
  ledger.transferCash(parseDecimal(big(amount).toFixed(digits), digits));
}

/** Replay receipts (price, quantity and fee) and request entitlements into
 * fresh bigint ledgers. Engine balances, positions and marks are comparison
 * targets. Cash transfers are replayed as recorded, with zero-net validation.
 */
export function reconcileFills(
  request: PortfolioRequest,
  result: Result,
): ReconciliationMismatch[] {
  const mismatches: ReconciliationMismatch[] = [];
  const compare = (
    date: string,
    field: string,
    expected: Value,
    actual: Value,
  ) => {
    if (typeof expected === "number" && typeof actual === "number") {
      const ulp =
        Number.EPSILON * Math.max(Math.abs(expected), Math.abs(actual));
      if (
        Number.isFinite(ulp) &&
        Math.abs(expected - actual) <= Math.max(tolerance, ulp)
      )
        return;
    } else if (expected === actual) return;
    mismatches.push({ date, field, expected, actual });
  };

  const accountBySleeve = new Map(
    request.sleeves.map((sleeve) => {
      const ledger = ExecutionLedger.forResearch(request.initial);
      transfer(ledger, request.initial * sleeve.share - request.initial);
      const marks = new Map<string, { symbol: string; price: number }>();
      return [sleeve.id, { ledger, marks }] as const;
    }),
  );
  const strategySleeves = new Map(
    request.strategies.map(({ id, sleeve }) => [id, sleeve]),
  );
  const periods = new Set(request.strategies.map(({ period }) => period));
  const period = periods.size === 1 ? request.strategies[0]!.period : "day";
  const calendar = request.calendar.filter((date) => {
    const day = portfolioObservationDay(request.market, period, date);
    return (
      (request.start.length === 10
        ? day >= request.start
        : Date.parse(date) >= Date.parse(request.start)) &&
      (request.end.length === 10
        ? day <= request.end
        : Date.parse(date) <= Date.parse(request.end))
    );
  });
  const sessions = new Set(calendar);
  const fillGroups = byDate(result.fills);
  const actionGroups = byDate(result.corporateActions);
  const valuationGroups = byDate(result.terminalValuations);
  const transferGroups = byDate(result.transfers);
  const curve = new Map(result.curve.map((row) => [row.date, row]));
  const snapshots = byDate(result.positionSnapshots);
  for (const [field, dates] of [
    ["fills", fillGroups.keys()],
    ["corporateActions", actionGroups.keys()],
    ["terminalValuations", valuationGroups.keys()],
    ["transfers", transferGroups.keys()],
    ["curve", curve.keys()],
    ["positionSnapshots", snapshots.keys()],
  ] as const) {
    for (const date of dates) {
      if (!sessions.has(date))
        compare(date, field, "replay session", "outside calendar");
    }
  }

  const bars = byDate(
    request.instruments.flatMap(({ symbol, bars }) =>
      bars
        .filter(({ date }) => sessions.has(date))
        .map(({ date, close }) => ({ symbol, date, close })),
    ),
  );
  const instruments = new Set(request.instruments.map(({ symbol }) => symbol));
  const terminal = byDate(
    request.instruments.flatMap(({ symbol, terminal }) =>
      terminal ? [{ symbol, ...terminal }] : [],
    ),
  );
  const actions = request.instruments
    .flatMap(({ symbol, actions }) =>
      (actions ?? [])
        .filter(({ date }) => date >= request.start && date <= request.end)
        .map((action) => ({ symbol, action })),
    )
    .sort((a, b) => a.action.date.localeCompare(b.action.date));
  const settlementDays = marketRules[request.market].settlementDays;
  const compareHoldings = (
    date: string,
    field: string,
    sleeve: string,
    observed: readonly {
      sleeve: string;
      strategyId: string;
      symbol: string;
      quantity: number;
    }[],
  ) => {
    const { ledger } = accountBySleeve.get(sleeve)!;
    const actual = new Map(
      observed
        .filter((row) => row.sleeve === sleeve)
        .map((row) => [positionKey(row.strategyId, row.symbol), row.quantity]),
    );
    for (const position of ledger.snapshot().positions) {
      compare(
        date,
        `${field}.${sleeve}.${position.symbol}.quantity`,
        decimal(position.quantity, ledger.quantityDecimals),
        actual.get(position.symbol) ?? null,
      );
      actual.delete(position.symbol);
    }
    for (const [key, quantity] of actual)
      compare(date, `${field}.${sleeve}.${key}.quantity`, null, quantity);
  };

  let nextAction = 0;
  for (const date of calendar) {
    for (const { ledger } of accountBySleeve.values())
      ledger.settlePendingCash(date);
    const observedActions = actionGroups.get(date) ?? [];
    const pendingActions = new Map<string, typeof observedActions>();
    for (const row of observedActions) {
      const key = positionKey(row.strategyId, row.symbol);
      const group = pendingActions.get(key) ?? [];
      group.push(row);
      pendingActions.set(key, group);
    }
    while (actions[nextAction] && actions[nextAction]!.action.date <= date) {
      const { symbol, action } = actions[nextAction++]!;
      for (const [strategy, sleeve] of strategySleeves) {
        const { ledger, marks } = accountBySleeve.get(sleeve)!;
        const key = positionKey(strategy, symbol);
        const mark = marks.get(key);
        if (!mark) continue;
        const receipt = ledger.applyResearchCorporateAction(
          key,
          action,
          request.market === "cn-equity",
          request.costs?.dividendTaxBps ?? 0,
        );
        if (!receipt) continue;
        const actual = pendingActions.get(key)?.shift();
        compare(
          date,
          `corporateActions.${key}.cash`,
          decimal(receipt.cash, ledger.cashDecimals),
          actual?.cash ?? null,
        );
        compare(
          date,
          `corporateActions.${key}.quantity`,
          decimal(receipt.quantity, ledger.quantityDecimals),
          actual?.quantity ?? null,
        );
        if (receipt.quantity === 0n) marks.delete(key);
        else mark.price = actionPrice(mark.price, action);
      }
    }
    for (const [key, rows] of pendingActions)
      if (rows.length)
        compare(date, `corporateActions.${key}.count`, 0, rows.length);

    // Same-day fills keep tape order, which matters for cash and sellable lots.
    for (const fill of fillGroups.get(date) ?? []) {
      const account = accountBySleeve.get(fill.sleeve);
      const field = `fills.${fill.orderId}`;
      if (
        !account ||
        strategySleeves.get(fill.strategyId) !== fill.sleeve ||
        !instruments.has(fill.symbol)
      ) {
        compare(
          date,
          `${field}.receipt`,
          "known strategy, sleeve and symbol",
          "invalid receipt identity",
        );
        continue;
      }
      const { ledger, marks } = account;
      const key = positionKey(fill.strategyId, fill.symbol);
      try {
        ledger.applyReplayFill(
          {
            orderId: String(fill.orderId),
            symbol: key,
            date,
            side: fill.side,
            quantity: fill.quantity,
            price: fill.price,
            fee: fill.fee,
          },
          settlementDays,
        );
      } catch (error) {
        compare(
          date,
          `${field}.receipt`,
          "posted",
          error instanceof Error ? error.message : String(error),
        );
        continue;
      }
      const quantity = ledger.position(key)?.quantity ?? 0n;
      if (quantity > 0n)
        marks.set(key, { symbol: fill.symbol, price: fill.price });
      else marks.delete(key);
      compare(date, `${field}.cashAfter`, cash(ledger), fill.cashAfter);
      compare(
        date,
        `${field}.holdingAfter`,
        decimal(quantity, ledger.quantityDecimals),
        fill.holdingAfter,
      );
    }

    const closes = new Map(
      (bars.get(date) ?? []).map(({ symbol, close }) => [symbol, close]),
    );
    const expectedValuations = new Set<string>();
    for (const { symbol, valuation } of terminal.get(date) ?? []) {
      const close = closes.get(symbol);
      if (close === undefined) continue;
      for (const [strategy, sleeve] of strategySleeves) {
        const { ledger, marks } = accountBySleeve.get(sleeve)!;
        const key = positionKey(strategy, symbol);
        if (!marks.has(key)) continue;
        const price = valuation === "last-close" ? close : 0;
        const quantity = ledger.position(key)!.quantity;
        const amount = ledger.settleTerminalValue(key, price);
        marks.delete(key);
        expectedValuations.add(key);
        const actual = valuationGroups
          .get(date)
          ?.find((row) => row.strategyId === strategy && row.symbol === symbol);
        compare(
          date,
          `terminalValuations.${key}.quantity`,
          decimal(quantity, ledger.quantityDecimals),
          actual?.quantity ?? null,
        );
        compare(
          date,
          `terminalValuations.${key}.price`,
          price,
          actual?.price ?? null,
        );
        compare(
          date,
          `terminalValuations.${key}.amount`,
          decimal(amount, ledger.cashDecimals),
          actual?.amount ?? null,
        );
      }
    }
    compare(
      date,
      "terminalValuations.count",
      expectedValuations.size,
      valuationGroups.get(date)?.length ?? 0,
    );

    const transfers = transferGroups.get(date) ?? [];
    let credited = 0;
    let debited = 0;
    for (const { amount } of transfers) {
      credited += Math.max(0, amount);
      debited += Math.max(0, -amount);
    }
    compare(date, "transfers.credit", debited, credited);
    for (const row of transfers) {
      const ledger = accountBySleeve.get(row.sleeve)?.ledger;
      if (!ledger) {
        compare(date, "transfers.sleeve", "known sleeve", row.sleeve);
        continue;
      }
      try {
        transfer(ledger, row.amount);
      } catch (error) {
        compare(
          date,
          `transfers.${row.sleeve}`,
          "posted",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    const observed = curve.get(date);
    let totalCash = 0,
      totalEquity = 0;
    for (const [sleeve, { ledger, marks }] of accountBySleeve) {
      let equity = big(formatDecimal(ledger.cash, ledger.cashDecimals));
      for (const position of ledger.snapshot().positions) {
        const mark = marks.get(position.symbol)!;
        mark.price = closes.get(mark.symbol) ?? mark.price;
        equity = equity.plus(
          big(formatDecimal(position.quantity, ledger.quantityDecimals)).times(
            mark.price,
          ),
        );
      }
      const sleeveCash = cash(ledger);
      const sleeveEquity = equity.toNumber();
      totalCash += sleeveCash;
      totalEquity += sleeveEquity;
      const actual = observed?.sleeves.find(({ id }) => id === sleeve);
      compare(date, `curve.${sleeve}.cash`, sleeveCash, actual?.cash ?? null);
      compare(
        date,
        `curve.${sleeve}.equity`,
        sleeveEquity,
        actual?.equity ?? null,
      );
      compareHoldings(
        date,
        "positionSnapshots",
        sleeve,
        snapshots.get(date) ?? [],
      );
    }
    compare(date, "curve.cash", totalCash, observed?.cash ?? null);
    compare(date, "curve.equity", totalEquity, observed?.equity ?? null);
  }

  for (const sleeve of accountBySleeve.keys()) {
    const date = calendar.at(-1) ?? request.end;
    compareHoldings(date, "positions", sleeve, result.positions);
    const { marks } = accountBySleeve.get(sleeve)!;
    for (const position of result.positions.filter(
      (row) => row.sleeve === sleeve,
    )) {
      const key = positionKey(position.strategyId, position.symbol);
      const expected = marks.get(key);
      if (expected)
        compare(
          date,
          `positions.${sleeve}.${key}.mark`,
          expected.price,
          position.mark,
        );
    }
  }
  return mismatches;
}
