import {
  prepareStrategy,
  strategyProtection,
  strategyTimeExit,
  strategyObjectSchema,
  type StrategyObjectInput,
  type StrategyExternalInputs,
  type StrategyDecision,
  evaluateStrategyBook,
  usesStrategyBook,
  nextStrategyProtection,
  strategyReentryAllowed,
  transferStrategyBook,
  type StrategyBookFacts,
  type StrategyBookState,
  type StrategyBookDecision,
  type BookCandidate,
  type StrategyReentryState,
} from "trading-strategies";
import type { Bar, Period } from "trading-strategy-core/bars";
import { marketRules } from "trading-strategy-core/market-rules";
import {
  executionCostsSchema,
  executionCostsForDate,
  type ExecutionCosts,
} from "trading-strategy-core/costs";
import { big, toNumber, type Numeric } from "trading-strategy-core/money";
import {
  PortfolioAccount,
  actionPrice,
  type PortfolioAction,
  replayPortfolioEvents,
} from "./portfolio-account.js";
import { fillMarketOrder } from "./execution.js";
import {
  sizePortfolioEntry,
  sizePortfolioTargetEntry,
  portfolioExecutionFee as feeFor,
} from "./portfolio-sizing.js";
import { plannedStopRisk } from "trading-strategies/research/risk/research-risk";
import { portfolioObservationDay } from "./portfolio-clock.js";

type Market = "cn-equity" | "crypto";
export type PortfolioExecution = {
  evidence: string;
  minimum?: number;
  step?: number;
  maximum?: number;
  limitUp: number | null;
  limitDown: number | null;
  tradable: boolean;
};
export type PortfolioInstrument = {
  symbol: string;
  market: Market;
  bars: readonly Bar[];
  /** Already adjusted at a fixed historical denominator; never used for fills. */
  signalBars: readonly Bar[];
  /** A local pure facts adapter may quote from frozen bars on demand. It is
   * reconstructed by the research loader, never serialized as executable code. */
  execution:
    | PortfolioExecution
    | Readonly<Record<string, PortfolioExecution>>
    | ((
        bar: Readonly<Bar> | undefined,
        previous: Readonly<Bar> | undefined,
      ) => PortfolioExecution | undefined);
  external?: StrategyExternalInputs;
  /** Explicit survivorship sensitivity only; never claimed as a historical fill. */
  terminal?: {
    date: string;
    valuation: "last-close" | "total-loss";
    evidence: string;
  };
  actions?: readonly PortfolioAction[];
};
export type PortfolioSleeve = {
  id: string;
  share: number;
  riskPerTrade: number;
  maxPositions: number;
};
export type PortfolioRequest = {
  /** Scoring runs retain exact counters instead of millions of no-op rows. */
  observationDetail?: "full" | "counts";
  market: Market;
  initial: number;
  start: string;
  end: string;
  calendar: readonly string[];
  instruments: readonly PortfolioInstrument[];
  strategies: readonly StrategyObjectInput[];
  sleeves: readonly PortfolioSleeve[];
  costs?: ExecutionCosts;
  bookFacts?: Readonly<Record<string, StrategyBookFacts>>;
  /** A completed pre-start weekly signal seeds only next-session orders; no warmup equity is scored. */
  bookSeeds?: readonly {
    strategyId: string;
    date: string;
    availableAt: string;
    selectionFrom?: string;
  }[];
  rebalance?: { everyBars?: number; drift?: number };
  /** Completed-bar targets; only idle cash is transferred, never forced sales. */
  sleeveTargets?: readonly {
    date: string;
    availableAt: string;
    shares: Readonly<Record<string, number>>;
  }[];
  /** Stress discretionary entry/exit signals; standing protection remains active. */
  signalDelayBars?: 0 | 1;
  /** PIT memberships for rule universes. Missing is unknown, never all-market. */
  memberships?: readonly {
    strategyId: string;
    date: string;
    availableAt: string;
    symbols: readonly string[];
  }[];
  /** Explicit causal research weight ceilings; absent row forbids entry. */
  positionWeights?: readonly {
    strategyId: string;
    symbol: string;
    date: string;
    availableAt: string;
    weight: number;
  }[];
};
export type PortfolioOrder = {
  id: number;
  strategyId: string;
  sleeve: string;
  symbol: string;
  side: "buy" | "sell";
  signalAt: string;
  due: string | null;
  status: "pending" | "filled" | "rejected";
  reason: string | null;
  attempts: number;
  trigger: "signal" | "stop" | "target" | "trailing" | "time";
  rankScore?: number;
  weightCeiling?: number;
  targetWeight?: number;
  industries?: Record<string, string[]>;
  riskGroups?: string[][];
  marketTargetShare?: number;
};
export type PortfolioFill = {
  orderId: number;
  strategyId: string;
  sleeve: string;
  symbol: string;
  side: "buy" | "sell";
  signalAt: string;
  date: string;
  price: number;
  quantity: number;
  fee: number;
  cashAfter: number;
  holdingAfter: number;
  executionEvidence?: {
    intendedPrice: number;
    slippageBps: number;
    source: "portfolio-OHLC-model";
  };
};
type PositionControl = {
  stop: number | null;
  entry: number;
  high: number;
  target: number | null;
  bars: number;
  tranches: number;
};
const keyFor = (strategy: string, symbol: string) =>
  JSON.stringify([strategy, symbol]);
type PreparedInstrument = {
  instrument: PortfolioInstrument;
  indices: Map<string, number>;
  evaluators: Map<string, ReturnType<typeof prepareStrategy>>;
};
/** Owned by one immutable validation prefix; never shared across mutable calls. */
export function createPortfolioPreparation() {
  return new WeakMap<
    PortfolioInstrument,
    { signature: string; prepared: PreparedInstrument }
  >();
}
const dayOf = (date: string, market: Market) =>
  date.length === 10
    ? date
    : new Date(Date.parse(date) + (market === "cn-equity" ? 8 * 3600000 : 0))
        .toISOString()
        .slice(0, 10);
const floorStep = (quantity: Numeric, step: number) =>
  toNumber(big(quantity).div(step).round(0, 0).times(step));
const periodMinutes: Partial<Record<Period, number>> = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "60m": 60,
  "1h": 60,
  "4h": 240,
};
function nextBar(date: string, period: Period) {
  if (date.length === 10)
    return new Date(Date.parse(date) + (period === "week" ? 7 : 1) * 86400000)
      .toISOString()
      .slice(0, 10);
  return new Date(
    Date.parse(date) + (periodMinutes[period] ?? 1440) * 60000,
  ).toISOString();
}
function quantityRules(
  instrument: PortfolioInstrument,
  date: string,
  bar: Bar | undefined,
  previous: Bar | undefined,
) {
  const execution =
    typeof instrument.execution === "function"
      ? instrument.execution(bar, previous)
      : "evidence" in instrument.execution
        ? (instrument.execution as PortfolioExecution)
        : instrument.execution[date];
  const template = marketRules[instrument.market];
  const minimum = execution?.minimum ?? template.quantity.minimum;
  const step = execution?.step ?? template.quantity.step;
  const maximum = execution?.maximum ?? 1e12;
  if (
    typeof execution?.evidence !== "string" ||
    !execution.evidence.trim() ||
    ![execution.limitUp, execution.limitDown].every(
      (v) =>
        v === null || (typeof v === "number" && Number.isFinite(v) && v > 0),
    ) ||
    minimum == null ||
    step == null ||
    ![minimum, step, maximum].every((v) => Number.isFinite(v) && v > 0) ||
    maximum < minimum
  )
    return { execution: null, minimum: 0, step: 0, maximum: 0 };
  return { execution, minimum, step, maximum };
}
function quote(
  bar: Bar | undefined,
  execution: PortfolioExecution | null,
  side: "buy" | "sell",
  costs: ExecutionCosts,
  reference?: number,
) {
  return fillMarketOrder(
    bar && reference !== undefined ? { ...bar, open: reference } : bar,
    side,
    execution
      ? {
          ...execution,
          quoteProfile: "conservative",
          minimumBuy: 1,
          buyStep: 1,
          maximumOrder: 1e12,
        }
      : null,
    costs,
  );
}

/** Long-only, one market account, independent sleeve ledgers with cash transfers.
 * Calendar is explicit so suspension and absent bars do not become delayed buys.
 * A stop already known before this bar wins if stop and target both touch.
 */
export function runPortfolio(
  request: PortfolioRequest,
  progress: (done: number, total: number) => void = () => {},
  preparation?: ReturnType<typeof createPortfolioPreparation>,
) {
  const { market, initial, sleeves } = request;
  if (
    !Number.isFinite(initial) ||
    initial <= 0 ||
    request.start > request.end ||
    !["cn-equity", "crypto"].includes(market)
  )
    throw new Error("Invalid portfolio request");
  if (
    !sleeves.length ||
    new Set(sleeves.map((s) => s.id)).size !== sleeves.length ||
    sleeves.some(
      (s) =>
        !s.id ||
        !Number.isFinite(s.share) ||
        s.share < 0 ||
        s.share > 1 ||
        !Number.isFinite(s.riskPerTrade) ||
        s.riskPerTrade <= 0 ||
        s.riskPerTrade > 1 ||
        !Number.isInteger(s.maxPositions) ||
        s.maxPositions < 1,
    ) ||
    Math.abs(sleeves.reduce((n, s) => n + s.share, 0) - 1) > 1e-10
  )
    throw new Error("Invalid sleeves");
  if (
    request.signalDelayBars !== undefined &&
    ![0, 1].includes(request.signalDelayBars)
  )
    throw new Error("Invalid signal delay");
  if (
    request.observationDetail !== undefined &&
    !["full", "counts"].includes(request.observationDetail)
  )
    throw new Error("Invalid observation detail");
  if (
    new Set(request.sleeveTargets?.map((t) => t.date)).size !==
      (request.sleeveTargets?.length ?? 0) ||
    request.sleeveTargets?.some(
      (t) =>
        t.availableAt > t.date ||
        !Number.isFinite(Date.parse(t.availableAt)) ||
        Object.keys(t.shares).length !== sleeves.length ||
        sleeves.some(
          (s) =>
            !Number.isFinite(t.shares[s.id]) ||
            t.shares[s.id]! < 0 ||
            t.shares[s.id]! > 1,
        ) ||
        Math.abs(sleeves.reduce((sum, s) => sum + t.shares[s.id]!, 0) - 1) >
          1e-10,
    )
  )
    throw new Error("Invalid / non-causal sleeve targets");
  if (
    request.rebalance &&
    ((request.rebalance.everyBars !== undefined &&
      (!Number.isInteger(request.rebalance.everyBars) ||
        request.rebalance.everyBars < 1)) ||
      (request.rebalance.drift !== undefined &&
        (!Number.isFinite(request.rebalance.drift) ||
          request.rebalance.drift <= 0 ||
          request.rebalance.drift > 1)))
  )
    throw new Error("Invalid rebalance policy");
  const costs = executionCostsSchema.parse(
    request.costs ?? marketRules[market].costs,
  );
  const strategies = request.strategies.map((s) =>
    strategyObjectSchema.parse(s),
  );
  const symbolUniverses = new Map(
    strategies.flatMap((s) =>
      s.universe.kind === "symbols"
        ? [[s.id, new Set(s.universe.symbols)] as const]
        : [],
    ),
  );
  if (
    !strategies.length ||
    new Set(strategies.map((s) => s.id)).size !== strategies.length ||
    strategies.some(
      (s) => s.market !== market || !sleeves.some((v) => v.id === s.sleeve),
    )
  )
    throw new Error("Invalid strategies / market / sleeve");
  if (
    !request.instruments.length ||
    new Set(request.instruments.map((i) => i.symbol)).size !==
      request.instruments.length ||
    request.instruments.some((i) => i.market !== market)
  )
    throw new Error("Invalid instruments");
  for (const row of request.memberships ?? [])
    if (
      !strategies.some((s) => s.id === row.strategyId) ||
      row.availableAt > row.date ||
      !Number.isFinite(Date.parse(row.availableAt)) ||
      new Set(row.symbols).size !== row.symbols.length
    )
      throw new Error("Invalid PIT universe membership");
  if (
    new Set((request.memberships ?? []).map((x) => `${x.strategyId}:${x.date}`))
      .size !== (request.memberships?.length ?? 0)
  )
    throw new Error("Duplicate PIT membership");
  const preparedSignature = JSON.stringify([strategies, request.end]);
  const instruments = new Map(
    request.instruments.map((instrument) => {
      const cached = preparation?.get(instrument);
      if (cached?.signature === preparedSignature)
        return [instrument.symbol, cached.prepared] as const;
      prepareStrategy(strategies[0]!, instrument.bars);
      if (
        instrument.bars.length !== instrument.signalBars.length ||
        instrument.bars.some(
          (b, i) => b.date !== instrument.signalBars[i]!.date,
        )
      )
        throw new Error("Raw / signal alignment mismatch");
      const actions = instrument.actions ?? [];
      if (
        instrument.terminal &&
        (!instrument.terminal.evidence.trim() ||
          !["last-close", "total-loss"].includes(
            instrument.terminal.valuation,
          ) ||
          !Number.isFinite(Date.parse(instrument.terminal.date)) ||
          (instrument.terminal.date <= request.end &&
            instrument.bars.at(-1)?.date !== instrument.terminal.date))
      )
        throw new Error("Invalid terminal sensitivity evidence/date");
      if (
        new Set(actions.map((a) => a.date)).size !== actions.length ||
        actions.some(
          (a) =>
            !a.evidence ||
            a.availableAt > a.date ||
            !Number.isFinite(a.dividend) ||
            a.dividend < 0 ||
            !Number.isFinite(a.bonus) ||
            a.bonus < 0 ||
            !Number.isFinite(Date.parse(a.date)) ||
            !Number.isFinite(Date.parse(a.availableAt)) ||
            (a.shareFactor !== undefined &&
              (!Number.isFinite(a.shareFactor) || a.shareFactor <= 0)) ||
            (a.rightsRatio !== undefined &&
              (!Number.isFinite(a.rightsRatio) || a.rightsRatio < 0)) ||
            ((a.rightsRatio ?? 0) > 0 &&
              (a.rightsPrice === undefined ||
                !Number.isFinite(a.rightsPrice) ||
                a.rightsPrice < 0)) ||
            (a.sharesSellableAt !== undefined &&
              (!Number.isFinite(Date.parse(a.sharesSellableAt)) ||
                a.sharesSellableAt < a.date)) ||
            (a.bonus > 0 && !a.sharesSellableAt),
        )
      )
        throw new Error("Unsupported / unproven corporate action");
      const prepared: PreparedInstrument = {
        instrument,
        indices: new Map(instrument.bars.map((b, i) => [b.date, i])),
        evaluators: new Map(
          strategies.map((s) => [
            s.id,
            prepareStrategy(s, instrument.signalBars, instrument.external),
          ]),
        ),
      };
      preparation?.set(instrument, { signature: preparedSignature, prepared });
      return [instrument.symbol, prepared] as const;
    }),
  );
  const weightRows = new Map<
    string,
    NonNullable<PortfolioRequest["positionWeights"]>[number][]
  >();
  for (const row of request.positionWeights ?? []) {
    if (
      !strategies.some((s) => s.id === row.strategyId) ||
      !instruments.has(row.symbol) ||
      !Number.isFinite(row.weight) ||
      row.weight < 0 ||
      row.weight > 1 ||
      !Number.isFinite(Date.parse(row.date)) ||
      !Number.isFinite(Date.parse(row.availableAt)) ||
      row.availableAt > row.date
    )
      throw new Error("Invalid causal position weight");
    const key = keyFor(row.strategyId, row.symbol);
    const rows = weightRows.get(key) ?? [];
    if (rows.some((r) => r.date === row.date))
      throw new Error("Duplicate position weight");
    rows.push(row);
    weightRows.set(key, rows);
  }
  for (const rows of weightRows.values())
    rows.sort((a, b) => a.date.localeCompare(b.date));
  const accounts = new Map(
    sleeves.map((s) => {
      const account = new PortfolioAccount(initial);
      account.transfer(initial * s.share - initial);
      return [s.id, account] as const;
    }),
  );
  const controls = new Map<string, PositionControl>();
  const bookStates = new Map<string, StrategyBookState>();
  const bookDecisions: {
    strategyId: string;
    decision: StrategyBookDecision;
  }[] = [];
  const reentries = new Map<string, StrategyReentryState>();
  const lifecycle = strategies.some(
    (s) => usesStrategyBook(s) || s.exit.chandelier || s.exit.timeReentry,
  );
  const observationDay = (date: string) =>
    lifecycle
      ? portfolioObservationDay(market, strategies[0]!.period, date)
      : dayOf(date, market);
  if (lifecycle && strategies.some((s) => s.period !== strategies[0]!.period))
    throw new Error(
      "A lifecycle portfolio requires one native period per request",
    );
  const dailyDecisionCounts: {
    strategyId: string;
    date: string;
    entries: number;
    unknown: number;
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
  const rejections: { orderId: number; date: string; reason: string }[] = [];
  const transfers: { date: string; sleeve: string; amount: number }[] = [];
  const corporateActions: ({
    date: string;
    symbol: string;
    strategyId: string;
    evidence: string;
  } & NonNullable<ReturnType<PortfolioAccount["corporateAction"]>>)[] = [];
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
    rejections.push({ orderId: order.id, date, reason });
    if (order.side === "buy") {
      order.status = "rejected";
      removePending(order);
    }
  };
  const execute = (
    order: PortfolioOrder,
    date: string,
    reference?: number,
    decision?: StrategyDecision,
  ) => {
    order.attempts++;
    const source = instruments.get(order.symbol)!;
    const index = source.indices.get(date),
      bar = index === undefined ? undefined : source.instrument.bars[index];
    const rules = quantityRules(
        source.instrument,
        date,
        bar,
        index === undefined ? undefined : source.instrument.bars[index - 1],
      ),
      strategy = strategies.find((s) => s.id === order.strategyId)!;
    const account = accounts.get(order.sleeve)!,
      key = keyFor(order.strategyId, order.symbol),
      holding = account.positions.get(key);
    const control = controls.get(key);
    if (
      order.side === "sell" &&
      account.sellable(
        key,
        dayOf(date, market),
        marketRules[market].settlementDays,
      ) <= 0
    ) {
      reject(order, date, "T+1：当日买入不可卖出");
      return;
    }
    const dateCosts = executionCostsForDate(costs, date);
    const result = quote(
      bar,
      rules.execution,
      order.side,
      dateCosts,
      reference,
    );
    if (result.price === null) {
      reject(order, date, result.reason!);
      return;
    }
    const price = result.price;
    const sleeve = sleeves.find((s) => s.id === order.sleeve)!;
    let quantity = holding?.quantity ?? 0;
    if (order.side === "buy") {
      const heldNames = new Set(
        [...account.positions.keys()].map((k) => identities.get(k)!.symbol),
      );
      if (
        !holding &&
        (usesStrategyBook(strategy)
          ? !heldNames.has(order.symbol) &&
            heldNames.size >= sleeve.maxPositions
          : account.positions.size >= sleeve.maxPositions)
      ) {
        reject(order, date, "sleeve持仓上限");
        return;
      }
      if (
        order.targetWeight === undefined &&
        (control?.tranches ?? 0) >= strategy.sizing.tranches
      ) {
        reject(order, date, "分批建仓次数上限");
        return;
      }
      const si = source.indices.get(order.signalAt);
      const known =
        decision ??
        (si === undefined
          ? undefined
          : source.evaluators.get(strategy.id)!.evaluate(si));
      const ratio =
        si === undefined
          ? 1
          : source.instrument.bars[si]!.close /
            source.instrument.signalBars[si]!.close;
      let stop =
        strategy.exit.stop?.kind === "fixed"
          ? price * (1 - strategy.exit.stop.fraction)
          : known?.stopLevel == null
            ? null
            : known.stopLevel * ratio;
      if (stop !== null && strategy.exit.stop?.kind !== "fixed") {
        for (const action of source.instrument.actions
          ?.filter((a) => a.date > order.signalAt && a.date <= date)
          .sort((a, b) => a.date.localeCompare(b.date)) ?? [])
          stop = actionPrice(stop, action);
      }
      if (control) stop = control.stop;
      if (strategy.exit.stop && (stop === null || stop <= 0 || stop >= price)) {
        reject(order, date, "缺失或无效初始止损");
        return;
      }
      const weights = weightRows.get(key) ?? [];
      let low = 0,
        high = weights.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (weights[middle]!.date <= order.signalAt) low = middle + 1;
        else high = middle;
      }
      const legacyCeiling =
        request.positionWeights === undefined
          ? 1
          : (weights[low - 1]?.weight ?? 0);
      const ceiling = Math.min(
        legacyCeiling,
        order.weightCeiling ?? order.targetWeight ?? 1,
      );
      const sizingInput: Parameters<typeof sizePortfolioEntry>[0] = {
        sizing:
          order.targetWeight !== undefined
            ? {
                kind: "weight",
                weight: Math.max(order.targetWeight, 1e-12),
                tranches: 1,
              }
            : strategy.sizing,
        equity: usesStrategyBook(strategy)
          ? (openingEquities.get(order.sleeve) ?? account.equity)
          : account.equity,
        cash: account.cash,
        price,
        stop,
        riskPerTrade: sleeve.riskPerTrade,
        weightCeiling: ceiling,
        existing: holding
          ? {
              quantity: holding.quantity,
              cost: holding.cost,
              stop: control?.stop ?? stop,
            }
          : undefined,
        quantityRules: rules,
        costs: dateCosts,
      };
      const targetWeight = order.targetWeight ?? order.weightCeiling;
      const sized =
        targetWeight === undefined
          ? sizePortfolioEntry(sizingInput)
          : sizePortfolioTargetEntry({ ...sizingInput, targetWeight });
      quantity = sized.quantity;
      if (sized.reason) {
        reject(order, date, sized.reason);
        return;
      }
      if (strategy.overlay) {
        const overlay = strategy.overlay,
          equity = account.equity;
        const held = [...account.positions].map(([k, p]) => ({
          symbol: identities.get(k)!.symbol,
          quantity: p.quantity,
          mark: p.mark,
          stop: controls.get(k)?.stop ?? null,
        }));
        let notionalRoom = Infinity;
        if (order.marketTargetShare !== undefined)
          notionalRoom = Math.min(
            notionalRoom,
            equity * order.marketTargetShare -
              held.reduce((n, h) => n + h.quantity * h.mark, 0),
          );
        if (overlay.symbolWeight !== undefined)
          notionalRoom = Math.min(
            notionalRoom,
            equity * overlay.symbolWeight -
              held
                .filter((h) => h.symbol === order.symbol)
                .reduce((n, h) => n + h.quantity * h.mark, 0),
          );
        if (overlay.industryWeight !== undefined && market === "cn-equity") {
          const groups = order.industries?.[order.symbol];
          if (
            !groups?.length ||
            held.some((h) => !order.industries?.[h.symbol]?.length)
          ) {
            reject(order, date, "缺已冻结行业依据，不能核对组合行业上限");
            return;
          }
          for (const group of groups)
            notionalRoom = Math.min(
              notionalRoom,
              equity * overlay.industryWeight -
                held
                  .filter((h) => order.industries![h.symbol]!.includes(group))
                  .reduce((n, h) => n + h.quantity * h.mark, 0),
            );
        }
        if (Number.isFinite(notionalRoom))
          quantity = Math.min(
            quantity,
            floorStep(Math.max(0, notionalRoom) / price, rules.step),
          );
        const execution = {
          costs: {
            slippageBps: dateCosts.slippageBps,
            sellTaxBps: dateCosts.sellTaxBps,
          },
          commission: (amount: number) => feeFor(1, amount, "buy", dateCosts),
        };
        const holdingRisk = (rows: typeof held) =>
          rows.some((h) => h.stop === null)
            ? null
            : rows.reduce(
                (n, h) =>
                  n +
                  Math.max(
                    0,
                    plannedStopRisk(h.quantity, h.mark, h.stop!, execution),
                  ),
                0,
              );
        let remainingRisk = Infinity;
        if (overlay.heat !== undefined) {
          const used = holdingRisk(held);
          if (used === null) {
            reject(order, date, "既有持仓止损风险未知");
            return;
          }
          remainingRisk = Math.min(
            remainingRisk,
            Math.max(0, equity * overlay.heat - used),
          );
        }
        if (overlay.correlationGroupRisk !== undefined) {
          const group = order.riskGroups?.find((g) => g.includes(order.symbol)),
            known = new Set(order.riskGroups?.flat());
          if (!group || held.some((h) => !known.has(h.symbol))) {
            reject(order, date, "缺同日相关组依据，不能核对连通组风险");
            return;
          }
          const used = holdingRisk(
            held.filter((h) => group.includes(h.symbol)),
          );
          if (used === null) {
            reject(order, date, "相关组持仓止损风险未知");
            return;
          }
          remainingRisk = Math.min(
            remainingRisk,
            Math.max(0, equity * overlay.correlationGroupRisk - used),
          );
        }
        if (Number.isFinite(remainingRisk)) {
          if (stop === null) {
            reject(order, date, "缺少组合风险所需止损");
            return;
          }
          let lo = 0,
            hi = Math.floor(quantity / rules.step);
          while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (
              plannedStopRisk(mid * rules.step, price, stop, execution) <=
              remainingRisk + 1e-8
            )
              lo = mid;
            else hi = mid - 1;
          }
          quantity = lo * rules.step;
        }
        if (quantity < rules.minimum) {
          reject(order, date, "组合单票、行业、总风险或相关组风险上限");
          return;
        }
      }
      controls.set(
        key,
        control
          ? { ...control, tranches: control.tranches + 1 }
          : {
              stop,
              entry: price,
              high: price,
              target: strategy.exit.takeProfit
                ? price * (1 + strategy.exit.takeProfit)
                : null,
              bars: 0,
              tranches: 1,
            },
      );
    } else {
      quantity = Math.min(
        quantity,
        account.sellable(
          key,
          dayOf(date, market),
          marketRules[market].settlementDays,
        ),
        rules.maximum,
      );
      if (order.targetWeight !== undefined) {
        const target = floorStep(
          ((openingEquities.get(order.sleeve) ?? account.equity) *
            order.targetWeight) /
            price,
          rules.step,
        );
        quantity = Math.min(
          quantity,
          Math.max(0, (holding?.quantity ?? 0) - target),
        );
        if (quantity <= 1e-8) {
          order.status = "filled";
          removePending(order);
          return;
        }
      }
    }
    if (
      order.side === "sell" &&
      market === "cn-equity" &&
      quantity < (holding?.quantity ?? 0)
    )
      quantity = floorStep(quantity, rules.step);
    if (quantity <= 0) {
      reject(order, date, "无可成交数量");
      return;
    }
    const fee = feeFor(quantity, price, order.side, dateCosts);
    account.fill(
      key,
      dayOf(date, market),
      order.side,
      quantity,
      price,
      fee,
      marketRules[market].settlementDays,
    );
    const remaining = account.positions.get(key)?.quantity ?? 0;
    const targetRemaining =
      order.targetWeight === undefined
        ? 0
        : floorStep(
            ((openingEquities.get(order.sleeve) ?? account.equity) *
              order.targetWeight) /
              price,
            rules.step,
          );
    order.status =
      remaining > targetRemaining + 1e-8 && order.side === "sell"
        ? "pending"
        : "filled";
    if (order.status !== "pending") removePending(order);
    order.reason = null;
    if (!remaining) {
      controls.delete(key);
      if (order.trigger === "time" && strategy.exit.timeReentry)
        reentries.set(key, {
          exitBar: calendar.indexOf(date),
          sawFalse: false,
        });
    }
    fills.push({
      orderId: order.id,
      strategyId: strategy.id,
      sleeve: order.sleeve,
      symbol: order.symbol,
      side: order.side,
      signalAt: order.signalAt,
      date,
      price,
      quantity,
      fee,
      cashAfter: account.cash,
      holdingAfter: remaining,
      ...(lifecycle
        ? {
            executionEvidence: {
              intendedPrice: reference ?? bar!.open,
              slippageBps:
                ((order.side === "buy"
                  ? price - (reference ?? bar!.open)
                  : (reference ?? bar!.open) - price) /
                  (reference ?? bar!.open)) *
                10000,
              source: "portfolio-OHLC-model" as const,
            },
          }
        : {}),
    });
  };
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
      return symbolUniverses.get(strategy.id)!.has(symbol);
    if (strategy.universe.kind === "rps") {
      const point = source.instrument.external?.rps?.find(
          (p) => p.date === date,
        ),
        value =
          point?.values[point.periods.indexOf(strategy.universe.period)]?.rps;
      return value != null && value >= strategy.universe.minimum;
    }
    const membership = request.memberships?.find(
      (m) => m.strategyId === strategy.id && m.date === date,
    );
    if (!membership) throw new Error("Missing PIT universe membership");
    return membership.symbols.includes(symbol);
  };
  for (const seed of request.bookSeeds ?? []) {
    const strategy = strategies.find((s) => s.id === seed.strategyId);
    if (
      !strategy?.rebalance ||
      seed.availableAt > seed.date ||
      seed.date >= calendar[0]! ||
      !request.calendar.includes(seed.date) ||
      bookStates.has(strategy.id)
    )
      throw new Error("Invalid causal pre-start book seed");
    const sleeve = sleeves.find((s) => s.id === strategy.sleeve)!;
    const week = (date: string) => {
      const d = new Date(date.slice(0, 10));
      d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
      return d.toISOString().slice(0, 10);
    };
    const selectionDates = seed.selectionFrom
      ? request.calendar.filter(
          (date, i) =>
            date >= seed.selectionFrom! &&
            date <= seed.date &&
            request.calendar[i + 1] &&
            week(date) !== week(request.calendar[i + 1]!),
        )
      : [seed.date];
    if (
      !selectionDates.length ||
      selectionDates.at(-1) !== seed.date ||
      (seed.selectionFrom && seed.selectionFrom > seed.date)
    )
      throw new Error("Invalid causal selection warmup seed");
    let decision: StrategyBookDecision | undefined;
    for (const date of selectionDates) {
      const candidates = [...instruments].map(([symbol, source]) => {
        const i = source.indices.get(date);
        return {
          symbol,
          bars: source.instrument.signalBars,
          external: source.instrument.external,
          eligible: eligibleAt(strategy, symbol, source, date),
          decision:
            i === undefined
              ? { entry: null, exit: null, stopLevel: null }
              : source.evaluators.get(strategy.id)!.evaluate(i),
        };
      });
      // Selection/buffer history is a causal feature. Warmup always has fresh
      // initial capital and no positions, fills, returns or inherited DD.
      decision = evaluateStrategyBook(strategy, {
        date,
        calendar: request.calendar,
        candidates,
        equity: initial * sleeve.share,
        initial: initial * sleeve.share,
        maxPositions: sleeve.maxPositions,
        facts: request.bookFacts?.[strategy.id],
        holdings: [],
        state: decision?.state,
      });
      if (!decision.available)
        throw new Error(
          `Pre-start selection evidence unavailable: ${decision.reason}`,
        );
    }
    if (!decision || !decision.available || decision.targets === null)
      throw new Error(
        `Pre-start book seed unavailable: ${decision?.reason ?? "not a completed weekly signal"}`,
      );
    bookStates.set(strategy.id, decision.state);
    bookDecisions.push({ strategyId: strategy.id, decision });
    for (const [symbol, weight] of Object.entries(decision.targets))
      if (weight > 0) {
        const due = calendar[request.signalDelayBars ?? 0] ?? null;
        const order = pushOrder(
          strategy,
          symbol,
          seed.date,
          due,
          "buy",
          "signal",
        );
        order.targetWeight = weight;
        order.industries = decision.industries;
        order.riskGroups = decision.riskGroups;
        order.marketTargetShare = decision.marketTargetShare;
      }
  }
  replayPortfolioEvents(calendar, {
    beforeOpen: (_index, date) => {
      for (const { instrument, action } of actionsAt.get(date) ?? []) {
        for (const strategy of strategies) {
          const account = accounts.get(strategy.sleeve)!,
            key = keyFor(strategy.id, instrument.symbol),
            p = account.positions.get(key);
          if (!p) continue;
          const applied = account.corporateAction(
            key,
            action,
            market === "cn-equity",
          )!;
          corporateActions.push({
            date,
            symbol: instrument.symbol,
            strategyId: strategy.id,
            evidence: action.evidence,
            ...applied,
          });
          const c = controls.get(key)!;
          for (const field of ["entry", "high", "stop", "target"] as const)
            if (c[field] !== null) c[field] = actionPrice(c[field]!, action);
          if (!applied.quantity) controls.delete(key);
        }
      }
    },
    open: (_index, date) => {
      for (const account of accounts.values())
        for (const [key, p] of account.positions) {
          const symbol = identities.get(key)!.symbol,
            source = instruments.get(symbol)!;
          const i = source.indices.get(date);
          if (i !== undefined) p.mark = source.instrument.bars[i]!.open;
        }
      for (const [sleeve, account] of accounts)
        openingEquities.set(sleeve, account.equity);
      const pending = [...pendingOrders.values()]
        .flatMap((active) => [...active])
        .filter(
          (o) =>
            o.status === "pending" &&
            o.due !== null &&
            Date.parse(o.due) <= Date.parse(date),
        )
        .map((order) => {
          if (order.targetWeight !== undefined) {
            const account = accounts.get(order.sleeve)!,
              p = account.positions.get(keyFor(order.strategyId, order.symbol));
            const actual = p
              ? (p.quantity * p.mark) / openingEquities.get(order.sleeve)!
              : 0;
            order.side = actual > order.targetWeight ? "sell" : "buy";
          }
          return order;
        })
        .sort(
          (a, b) =>
            (a.side === "sell" ? 0 : 1) - (b.side === "sell" ? 0 : 1) ||
            a.sleeve.localeCompare(b.sleeve) ||
            (b.rankScore ?? 0) - (a.rankScore ?? 0) ||
            a.symbol.localeCompare(b.symbol) ||
            a.id - b.id,
        );
      pending.forEach((o) => execute(o, date));
    },
    close: (index, date) => {
      const closeCandidates = new Map<string, BookCandidate[]>();
      for (const strategy of strategies) {
        const candidates: BookCandidate[] = [];
        const count = {
          strategyId: strategy.id,
          date,
          entries: 0,
          unknown: 0,
          expected: 0,
        };
        for (const [symbol, source] of instruments) {
          const eligible = eligibleAt(strategy, symbol, source, date);
          if (eligible) count.expected++;
          const i = source.indices.get(date);
          if (i === undefined) {
            if (eligible) count.unknown++;
            if (usesStrategyBook(strategy))
              candidates.push({
                symbol,
                bars: source.instrument.signalBars,
                external: source.instrument.external,
                decision: { entry: null, exit: null, stopLevel: null },
                eligible: eligibleAt(strategy, symbol, source, date),
              });
            continue;
          }
          const account = accounts.get(strategy.sleeve)!,
            key = keyFor(strategy.id, symbol),
            bar = source.instrument.bars[i]!;
          const p = account.positions.get(key),
            c = controls.get(key);
          if (p && c) {
            const protection = strategyProtection(strategy, bar, c);
            if (
              protection &&
              ![...(pendingOrders.get(key) ?? [])].some(
                (o) => o.side === "sell",
              )
            ) {
              const order = pushOrder(
                strategy,
                symbol,
                date,
                date,
                "sell",
                protection.trigger,
              );
              execute(order, date, protection.price);
            }
          }
          const current = account.positions.get(key),
            control = controls.get(key);
          if (current && control) {
            current.mark = bar.close;
            control.high = Math.max(control.high, bar.high);
            control.bars++;
          }
          const terminal = source.instrument.terminal;
          if (terminal?.date === date) {
            if (current) {
              const price = terminal.valuation === "last-close" ? bar.close : 0;
              const quantity = current.quantity;
              const amount = account.terminalValue(key, price);
              terminalValuations.push({
                date,
                symbol,
                strategyId: strategy.id,
                sleeve: strategy.sleeve,
                quantity,
                price,
                amount,
                evidence: terminal.evidence,
              });
              controls.delete(key);
            }
            for (const order of [...(pendingOrders.get(key) ?? [])]) {
              order.status = "rejected";
              order.reason = "终止覆盖敏感性估值，不是市场成交";
              removePending(order);
            }
            continue;
          }
          const decision = source.evaluators.get(strategy.id)!.evaluate(i);
          if (eligible && (decision.entry === null || decision.exit === null))
            count.unknown++;
          if (eligible && decision.entry === true && decision.exit !== true)
            count.entries++;
          if (current && control && strategy.exit.chandelier) {
            const ratio = bar.close / source.instrument.signalBars[i]!.close;
            Object.assign(
              control,
              nextStrategyProtection(
                strategy.exit,
                control,
                bar,
                decision.chandelierStop == null
                  ? null
                  : decision.chandelierStop * ratio,
              ),
            );
          }
          const reentry = reentries.get(key);
          if (reentry && decision.entry === false) reentry.sawFalse = true;
          if (decision.entry === true)
            observationCounts[strategy.id]!.entries++;
          if (decision.exit === true) observationCounts[strategy.id]!.exits++;
          if (request.observationDetail !== "counts")
            observations.push({
              date,
              strategyId: strategy.id,
              symbol,
              decision,
            });
          if (usesStrategyBook(strategy)) {
            candidates.push({
              symbol,
              bars: source.instrument.signalBars,
              external: source.instrument.external,
              decision: strategyReentryAllowed(
                strategy.exit,
                reentry,
                index,
                decision.entry,
              )
                ? decision
                : { ...decision, entry: false },
              eligible,
            });
            if (
              current &&
              (decision.exit === true ||
                strategyTimeExit(strategy.exit, control!.bars)) &&
              !pendingOrders.has(key)
            ) {
              const timed = strategyTimeExit(strategy.exit, control!.bars);
              pushOrder(
                strategy,
                symbol,
                date,
                calendar[index + 1 + (request.signalDelayBars ?? 0)] ?? null,
                "sell",
                timed ? "time" : "signal",
              );
            }
            continue;
          }
          if (pendingOrders.has(key)) continue;
          const timed =
            !!current && strategyTimeExit(strategy.exit, control!.bars);
          const side =
            current && (decision.exit === true || timed)
              ? "sell"
              : eligible &&
                  decision.entry === true &&
                  strategyReentryAllowed(
                    strategy.exit,
                    reentry,
                    index,
                    decision.entry,
                  ) &&
                  (!current || control!.tranches < strategy.sizing.tranches)
                ? "buy"
                : null;
          if (side) {
            const next =
              calendar[index + 1 + (request.signalDelayBars ?? 0)] ??
              (market === "crypto" && !request.signalDelayBars
                ? nextBar(date, strategy.period)
                : null);
            pushOrder(
              strategy,
              symbol,
              date,
              next,
              side,
              timed ? "time" : "signal",
            );
          }
        }
        if (lifecycle) dailyDecisionCounts.push(count);
        closeCandidates.set(strategy.id, candidates);
      }
      // Every sleeve position has its completed close and all standing
      // protection executions before any strategy reads portfolio equity.
      for (const strategy of strategies) {
        const candidates = closeCandidates.get(strategy.id)!;
        if (usesStrategyBook(strategy)) {
          const account = accounts.get(strategy.sleeve)!,
            sleeve = sleeves.find((s) => s.id === strategy.sleeve)!;
          const decision = evaluateStrategyBook(strategy, {
            date,
            calendar: request.calendar,
            candidates,
            equity: account.equity,
            initial: initial * sleeve.share,
            maxPositions: sleeve.maxPositions,
            state: bookStates.get(strategy.id),
            facts: request.bookFacts?.[strategy.id],
            holdings: [...account.positions].map(([key, p]) => ({
              symbol: identities.get(key)!.symbol,
              managed: identities.get(key)!.strategyId === strategy.id,
              weight: (p.quantity * p.mark) / account.equity,
              openRisk:
                controls.get(key)?.stop == null
                  ? null
                  : (p.quantity *
                      Math.max(0, p.mark - controls.get(key)!.stop!)) /
                    account.equity,
            })),
          });
          bookStates.set(strategy.id, decision.state);
          bookDecisions.push({ strategyId: strategy.id, decision });
          const next =
            calendar[index + 1 + (request.signalDelayBars ?? 0)] ??
            (market === "crypto" && !request.signalDelayBars
              ? nextBar(date, strategy.period)
              : null);
          if (decision.targets !== null) {
            for (const order of [...pendingOrders.values()].flatMap((s) => [
              ...s,
            ]))
              if (
                order.strategyId === strategy.id &&
                order.targetWeight !== undefined
              ) {
                order.status = "rejected";
                order.reason = "被新的完成bar调仓目标替代";
                removePending(order);
              }
            const symbols = new Set([
              ...Object.keys(decision.targets),
              ...[...account.positions.keys()]
                .filter((k) => identities.get(k)!.strategyId === strategy.id)
                .map((k) => identities.get(k)!.symbol),
            ]);
            for (const symbol of [...symbols].sort()) {
              const key = keyFor(strategy.id, symbol),
                p = account.positions.get(key),
                weight = decision.targets[symbol] ?? 0;
              if (pendingOrders.has(key)) continue;
              const currentWeight = p
                ? (p.quantity * p.mark) / account.equity
                : 0;
              if (Math.abs(currentWeight - weight) <= 1e-10) continue;
              const order = pushOrder(
                strategy,
                symbol,
                date,
                next,
                currentWeight > weight ? "sell" : "buy",
                "signal",
              );
              order.targetWeight = weight;
              order.rankScore = candidates.find((c) => c.symbol === symbol)
                ?.decision.entry
                ? 1
                : 0;
              order.industries = decision.industries;
              order.riskGroups = decision.riskGroups;
              order.marketTargetShare = decision.marketTargetShare;
            }
          }
          if (!strategy.rebalance && decision.available)
            for (const entry of decision.entries) {
              const key = keyFor(strategy.id, entry.symbol),
                control = controls.get(key);
              if (
                pendingOrders.has(key) ||
                entry.weight <= 0 ||
                (control?.tranches ?? 0) >= strategy.sizing.tranches ||
                !strategyReentryAllowed(
                  strategy.exit,
                  reentries.get(key),
                  index,
                  true,
                )
              )
                continue;
              const order = pushOrder(
                strategy,
                entry.symbol,
                date,
                next,
                "buy",
                "signal",
              );
              order.rankScore = entry.score;
              order.weightCeiling = entry.weight;
              order.industries = decision.industries;
              order.riskGroups = decision.riskGroups;
              order.marketTargetShare = decision.marketTargetShare;
            }
        }
      }
      if (request.rebalance) {
        const target = request.sleeveTargets
          ?.filter((t) => t.date <= date)
          .sort((a, b) => a.date.localeCompare(b.date))
          .at(-1);
        const targets = sleeves.map((s) => ({
          ...s,
          share: target?.shares[s.id] ?? s.share,
        }));
        const total = [...accounts.values()].reduce((n, a) => n + a.equity, 0);
        const due =
          request.rebalance.everyBars !== undefined &&
          (index + 1) % request.rebalance.everyBars === 0;
        const drift =
          request.rebalance.drift !== undefined &&
          targets.some(
            (s) =>
              Math.abs(accounts.get(s.id)!.equity / total - s.share) >=
              request.rebalance!.drift!,
          );
        if (due || drift || target?.date === date) {
          let pool = 0;
          for (const s of targets) {
            const a = accounts.get(s.id)!,
              amount = Math.min(
                a.cash,
                Math.max(0, a.equity - total * s.share),
              );
            if (amount > 0) {
              a.transfer(-amount);
              pool += amount;
              transfers.push({ date, sleeve: s.id, amount: -amount });
              for (const strategy of strategies.filter(
                (v) => v.sleeve === s.id,
              )) {
                const state = bookStates.get(strategy.id);
                if (state)
                  bookStates.set(
                    strategy.id,
                    transferStrategyBook(state, -amount),
                  );
              }
            }
          }
          const needs = targets.map((s) => ({
            s,
            need: Math.max(0, total * s.share - accounts.get(s.id)!.equity),
          }));
          const totalNeed = needs.reduce((n, x) => n + x.need, 0);
          let allocated = 0;
          needs
            .filter((x) => x.need > 0)
            .forEach((x, i, all) => {
              const amount =
                i === all.length - 1
                  ? pool - allocated
                  : (pool * x.need) / totalNeed;
              accounts.get(x.s.id)!.transfer(amount);
              allocated += amount;
              transfers.push({ date, sleeve: x.s.id, amount });
              for (const strategy of strategies.filter(
                (v) => v.sleeve === x.s.id,
              )) {
                const state = bookStates.get(strategy.id);
                if (state)
                  bookStates.set(
                    strategy.id,
                    transferStrategyBook(state, amount),
                  );
              }
            });
        }
      }
      const rows = sleeves.map((s) => ({
        id: s.id,
        cash: accounts.get(s.id)!.cash,
        equity: accounts.get(s.id)!.equity,
      }));
      const row = {
        date,
        cash: rows.reduce((n, s) => n + s.cash, 0),
        equity: rows.reduce((n, s) => n + s.equity, 0),
        sleeves: rows,
      };
      curve.push(row);
      for (const [sleeve, account] of accounts)
        for (const [key, position] of account.positions) {
          const identity = identities.get(key)!;
          positionSnapshots.push({
            date,
            symbol: identity.symbol,
            strategyId: identity.strategyId,
            sleeve,
            quantity: position.quantity,
            weight: (position.quantity * position.mark) / row.equity,
          });
        }
      daily.set(observationDay(date), { ...row, date: observationDay(date) });
      if (index % 4096 === 0) progress(index + 1, calendar.length);
    },
  });
  progress(calendar.length, calendar.length);
  return {
    version: "portfolio-event-1" as const,
    quality: "rule-check-only" as const,
    orders,
    fills,
    rejections,
    positions: [...accounts].flatMap(([sleeve, a]) =>
      [...a.positions].map(([key, p]) => ({
        sleeve,
        key,
        ...identities.get(key)!,
        ...p,
        lots: p.lots.map((l) => ({ ...l })),
      })),
    ),
    equity: [...daily.values()],
    curve,
    positionSnapshots,
    observations,
    ...(request.observationDetail === "counts" ? { observationCounts } : {}),
    transfers,
    corporateActions,
    terminalValuations,
    ...(lifecycle
      ? {
          bookDecisions,
          bookStates: Object.fromEntries(bookStates),
          dailyDecisionCounts,
        }
      : {}),
  };
}
