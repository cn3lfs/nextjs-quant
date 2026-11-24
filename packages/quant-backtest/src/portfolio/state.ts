import {
  type StrategyDecision,
  usesStrategyBook,
  type StrategyBookState,
  type StrategyBookDecision,
  type StrategyReentryState,
} from "trading-strategies";
import { type PortfolioAction } from "../portfolio-account.js";
import { wilderAtr14Series } from "quant-execution";
import { portfolioObservationDay } from "../portfolio-clock.js";
import { AtomsPortfolioAccount } from "./atoms-account.js";
import {
  type PortfolioInstrument,
  type PortfolioRequest,
  type PortfolioRiskAudit,
  type PortfolioOrder,
  type PortfolioFill,
  type PositionControl,
} from "./types.js";
import { dayOf } from "./clock.js";
import {
  keyFor,
  type PreparedInstrument,
  createPortfolioPreparation,
  preparePortfolioRequest,
} from "./preparation.js";

export function createPortfolioState(
  request: PortfolioRequest,
  preparation?: ReturnType<typeof createPortfolioPreparation>,
) {
  const { market, initial, sleeves } = request;
  const { accountMaxUniqueSymbols, accountMaxSymbolWeight } = request;
  if (
    accountMaxUniqueSymbols !== undefined &&
    (!Number.isSafeInteger(accountMaxUniqueSymbols) ||
      accountMaxUniqueSymbols < 1)
  )
    throw new Error("Invalid accountMaxUniqueSymbols");
  if (
    accountMaxSymbolWeight !== undefined &&
    !(accountMaxSymbolWeight > 0 && accountMaxSymbolWeight <= 1)
  )
    throw new Error("Invalid accountMaxSymbolWeight");
  const {
    costs,
    strategies,
    instruments,
    symbolUniverses,
    weightRows,
    scheduledAt,
  } = preparePortfolioRequest(request, preparation);
  const accounts = new Map(
    sleeves.map((s) => {
      const account = new AtomsPortfolioAccount(initial);
      account.transfer(initial * s.share - initial);
      return [s.id, account] as const;
    }),
  );
  const controls = new Map<string, PositionControl>();
  const lastExitIndices = new Map<string, number>();
  const bookStates = new Map<string, StrategyBookState>();
  const bookDecisions: {
    strategyId: string;
    decision: StrategyBookDecision;
  }[] = [];
  const reentries = new Map<string, StrategyReentryState>();
  const lifecycle = strategies.some(
    (s) => usesStrategyBook(s) || s.exit.chandelier || s.exit.timeReentry,
  );
  const samePeriod = strategies.every(
    (s) => s.period === strategies[0]!.period,
  );
  const suspensionDates = new Map<string, Set<string>>();
  let sessions: Set<string> | undefined;
  for (const [symbol, { instrument, indices }] of instruments) {
    if (market !== "cn-equity" || !instrument.certifiedSuspensions) continue;
    sessions ??= new Set(request.calendar);
    const first = instrument.bars[0]?.date;
    const dates = new Set<string>();
    for (const day of instrument.certifiedSuspensions) {
      const resume = indices.get(day.resumptionDate);
      if (
        day.symbol === symbol &&
        first &&
        first < day.date &&
        day.date < day.resumptionDate &&
        day.resumptionDate <= request.end &&
        sessions.has(day.resumptionDate) &&
        resume !== undefined &&
        instrument.bars[resume]!.volume > 0
      )
        dates.add(day.date);
    }
    suspensionDates.set(symbol, dates);
  }
  const collectDailyDecisionCounts =
    lifecycle ||
    Boolean(request.collectDailyDecisionCounts) ||
    suspensionDates.size > 0;
  const dailyCapacityUsed = new Map<string, number>();
  const observationDay = (date: string) =>
    lifecycle || samePeriod
      ? portfolioObservationDay(market, strategies[0]!.period, date)
      : dayOf(date, market);
  if (lifecycle && !samePeriod)
    throw new Error(
      "A lifecycle portfolio requires one native period per request",
    );
  const dailyDecisionCounts: {
    strategyId: string;
    date: string;
    entries: number;
    unknown: number;
    suspended?: number;
    suspendedSymbols?: string[];
    expected: number;
  }[] = [];
  const openingEquities = new Map<string, number>();
  for (const sleeve of sleeves) {
    const policies = strategies
      .filter((s) => s.sleeve === sleeve.id && usesStrategyBook(s))
      .map((s) => JSON.stringify([s.overlay, s.rebalance]));
    if (new Set(policies).size > 1)
      throw new Error("Conflicting overlay / rebalance policies in one sleeve");
  }
  const identities = new Map(
    strategies.flatMap((strategy) =>
      [...instruments.keys()].map(
        (symbol) =>
          [
            keyFor(strategy.id, symbol),
            { strategyId: strategy.id, symbol },
          ] as const,
      ),
    ),
  );
  const orders: PortfolioOrder[] = [],
    fills: PortfolioFill[] = [];
  // Completed orders remain in the audit log, never in the active-order index.
  const pendingOrders = new Map<string, Set<PortfolioOrder>>();
  const removePending = (order: PortfolioOrder) => {
    const key = keyFor(order.strategyId, order.symbol);
    const active = pendingOrders.get(key);
    active?.delete(order);
    if (!active?.size) pendingOrders.delete(key);
  };
  const rejections: {
    orderId: number;
    date: string;
    reason: string;
    parentOrderId?: number;
    sliceEnd?: string;
  }[] = [];
  const transfers: { date: string; sleeve: string; amount: number }[] = [];
  const corporateActions: ({
    date: string;
    symbol: string;
    strategyId: string;
    evidence: string;
  } & NonNullable<ReturnType<AtomsPortfolioAccount["corporateAction"]>>)[] = [];
  const terminalValuations: {
    date: string;
    symbol: string;
    strategyId: string;
    sleeve: string;
    quantity: number;
    price: number;
    amount: number;
    evidence: string;
  }[] = [];
  const observations: {
    date: string;
    strategyId: string;
    symbol: string;
    decision: StrategyDecision;
  }[] = [];
  const observationCounts = Object.fromEntries(
    strategies.map((s) => [s.id, { entries: 0, exits: 0 }]),
  );
  const curve: {
    date: string;
    cash: number;
    equity: number;
    sleeves: { id: string; cash: number; equity: number }[];
  }[] = [];
  const positionSnapshots: {
    date: string;
    symbol: string;
    quantity: number;
    weight: number;
    strategyId: string;
    sleeve: string;
  }[] = [];
  const daily = new Map<string, (typeof curve)[number]>();
  const calendar = request.calendar.filter(
    (d) =>
      (request.start.length === 10
        ? observationDay(d) >= request.start
        : Date.parse(d) >= Date.parse(request.start)) &&
      (request.end.length === 10
        ? observationDay(d) <= request.end
        : Date.parse(d) <= Date.parse(request.end)),
  );
  if (!calendar.length) throw new Error("Empty event calendar");
  const flowsAt = new Map<string, Map<string, number>>();
  for (const { date, sleeve, amount } of request.externalCashFlows ?? []) {
    if (
      !accounts.has(sleeve) ||
      !Number.isFinite(amount) ||
      !calendar.includes(date)
    )
      throw new Error("Invalid external cash flow date, sleeve or amount");
    const flows = flowsAt.get(date) ?? new Map<string, number>();
    flows.set(sleeve, (flows.get(sleeve) ?? 0) + amount);
    flowsAt.set(date, flows);
  }
  const riskAudit: PortfolioRiskAudit | undefined = request.riskPolicy
    ? {
        daily: [],
        missingCloses: [],
        blocked: 0,
        reduced: 0,
        entries: [],
        reductions: [],
      }
    : undefined;
  const atrBySymbol = new Map<string, ReturnType<typeof wilderAtr14Series>>();
  const previousRiskSession = new Map<string, string>();
  if (riskAudit) {
    let lastDay: string | undefined;
    for (const time of calendar) {
      const day = observationDay(time);
      if (day !== lastDay && lastDay) previousRiskSession.set(day, lastDay);
      lastDay = day;
    }
  }
  const riskAtrAt = (
    source: PreparedInstrument,
    signalIndex: number | undefined,
  ) => {
    if (signalIndex === undefined) return null;
    const { symbol, signalBars } = source.instrument;
    let values = atrBySymbol.get(symbol);
    if (!values) {
      values = wilderAtr14Series(signalBars);
      atrBySymbol.set(symbol, values);
    }
    return values[signalIndex] ?? null;
  };
  const actionsAt = new Map<
    string,
    { instrument: PortfolioInstrument; action: PortfolioAction }[]
  >();
  for (const { instrument } of instruments.values())
    for (const action of instrument.actions ?? []) {
      if (action.date < request.start || action.date > request.end) continue;
      let low = 0,
        high = calendar.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (calendar[middle]! < action.date) low = middle + 1;
        else high = middle;
      }
      const date = calendar[low];
      if (!date) continue;
      const rows = actionsAt.get(date) ?? [];
      rows.push({ instrument, action });
      actionsAt.set(date, rows);
    }
  const pushOrder = (
    strategy: (typeof strategies)[number],
    symbol: string,
    signalAt: string,
    due: string | null,
    side: "buy" | "sell",
    trigger: PortfolioOrder["trigger"],
  ) => {
    const order: PortfolioOrder = {
      id: orders.length + 1,
      strategyId: strategy.id,
      sleeve: strategy.sleeve,
      symbol,
      side,
      signalAt,
      due,
      status: "pending",
      reason: null,
      attempts: 0,
      trigger,
    };
    orders.push(order);
    const key = keyFor(strategy.id, symbol);
    const active = pendingOrders.get(key) ?? new Set<PortfolioOrder>();
    active.add(order);
    pendingOrders.set(key, active);
    return order;
  };
  const reject = (order: PortfolioOrder, date: string, reason: string) => {
    order.reason = reason;
    rejections.push({
      orderId: order.id,
      date,
      reason,
      ...(order.sliceEnd && {
        sliceEnd: order.sliceEnd,
        parentOrderId: order.parentOrderId,
      }),
    });
    if (order.side === "buy") {
      order.status = "rejected";
      removePending(order);
    }
  };
  const rpsBySymbol = new Map(
    [...instruments].map(([symbol, { instrument }]) => {
      const points = instrument.external?.rps ?? [];
      const byDate = new Map<string, (typeof points)[number]>();
      for (const point of points) {
        if (!byDate.has(point.date)) byDate.set(point.date, point);
      }
      return [symbol, byDate] as const;
    }),
  );
  const membershipByStrategy = new Map<string, Map<string, Set<string>>>();
  for (const row of request.memberships ?? []) {
    let byDate = membershipByStrategy.get(row.strategyId);
    if (!byDate) {
      byDate = new Map();
      membershipByStrategy.set(row.strategyId, byDate);
    }
    if (!byDate.has(row.date)) byDate.set(row.date, new Set(row.symbols));
  }
  const eligibleAt = (
    strategy: (typeof strategies)[number],
    symbol: string,
    source: PreparedInstrument,
    date: string,
  ) => {
    if (
      lifecycle &&
      (!source.instrument.bars.length || source.instrument.bars[0]!.date > date)
    )
      return false;
    if (strategy.universe.kind === "symbols")
      return (
        symbolUniverses.get(strategy.id)!.has(symbol) &&
        (membershipByStrategy.get(strategy.id)?.get(date)?.has(symbol) ?? true)
      );
    if (strategy.universe.kind === "rps") {
      const point = rpsBySymbol.get(source.instrument.symbol)?.get(date),
        value =
          point?.values[point.periods.indexOf(strategy.universe.period)]?.rps;
      return value != null && value >= strategy.universe.minimum;
    }
    const membership = membershipByStrategy.get(strategy.id)?.get(date);
    if (!membership) throw new Error("Missing PIT universe membership");
    return membership.has(symbol);
  };
  return {
    request,
    riskAudit,
    previousRiskSession,
    riskAtrAt,
    flowsAt,
    units: initial,
    market,
    initial,
    sleeves,
    costs,
    strategies,
    instruments,
    weightRows,
    scheduledAt,
    accounts,
    controls,
    lastExitIndices,
    bookStates,
    bookDecisions,
    reentries,
    // portfolioResult exposes counts in its lifecycle diagnostics envelope.
    // Opt-in reporting must not activate lifecycle eligibility or clock rules.
    lifecycle: collectDailyDecisionCounts,
    lifecycleExecutionEvidence: lifecycle,
    collectDailyDecisionCounts,
    dailyCapacityUsed,
    observationDay,
    dailyDecisionCounts,
    suspensionDates,
    openingEquities,
    identities,
    orders,
    fills,
    pendingOrders,
    removePending,
    rejections,
    transfers,
    corporateActions,
    terminalValuations,
    observations,
    observationCounts,
    curve,
    positionSnapshots,
    daily,
    calendar,
    actionsAt,
    eligibleAt,
    pushOrder,
    reject,
  };
}
export type PortfolioState = ReturnType<typeof createPortfolioState>;
