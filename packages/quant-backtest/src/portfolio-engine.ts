import {
  prepareStrategy,
  strategyProtection,
  strategyObjectSchema,
  type StrategyObjectInput,
  type StrategyExternalInputs,
  type StrategyDecision,
} from "trading-strategies";
import type { Bar, Period } from "trading-strategy-core/bars";
import { marketRules } from "trading-strategy-core/market-rules";
import {
  executionCostsSchema,
  type ExecutionCosts,
} from "trading-strategy-core/costs";
import {
  big,
  bigMin,
  bpsOf,
  moneyMul,
  toNumber,
  type Numeric,
} from "trading-strategy-core/money";
import {
  PortfolioAccount,
  actionPrice,
  type PortfolioAction,
  replayPortfolioEvents,
} from "./portfolio-account.js";
import { fillMarketOrder, commissionFor } from "./execution.js";

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
function feeFor(
  quantity: number,
  price: number,
  side: "buy" | "sell",
  costs: ExecutionCosts,
) {
  const amount = moneyMul(quantity, price);
  return toNumber(
    big(commissionFor(amount, costs)).plus(
      side === "sell" ? bpsOf(amount, costs.sellTaxBps) : 0,
    ),
  );
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
    (d) => dayOf(d, market) >= request.start && dayOf(d, market) <= request.end,
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
    const result = quote(bar, rules.execution, order.side, costs, reference);
    if (result.price === null) {
      reject(order, date, result.reason!);
      return;
    }
    const price = result.price;
    const sleeve = sleeves.find((s) => s.id === order.sleeve)!;
    let quantity = holding?.quantity ?? 0;
    if (order.side === "buy") {
      if (!holding && account.positions.size >= sleeve.maxPositions) {
        reject(order, date, "sleeve持仓上限");
        return;
      }
      if ((control?.tranches ?? 0) >= strategy.sizing.tranches) {
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
      const baseWeight =
        strategy.sizing.kind === "equal"
          ? 1 / strategy.sizing.positions
          : strategy.sizing.kind === "weight"
            ? strategy.sizing.weight
            : 1;
      const weights = weightRows.get(key) ?? [];
      let low = 0,
        high = weights.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (weights[middle]!.date <= order.signalAt) low = middle + 1;
        else high = middle;
      }
      const ceiling =
        request.positionWeights === undefined
          ? 1
          : (weights[low - 1]?.weight ?? 0);
      const weight = Math.min(baseWeight, ceiling);
      const capital = account.equity;
      const budget = Math.min(
        account.cash,
        (capital * weight) / strategy.sizing.tranches,
      );
      quantity = floorStep(
        bigMin(
          big(budget).minus(costs.minimumCommission).div(price),
          big(budget).div(
            big(price).times(big(1).plus(big(costs.commissionBps).div(10000))),
          ),
          rules.maximum,
        ),
        rules.step,
      );
      if (stop !== null) {
        const loss = price - stop;
        const oldRisk = holding
          ? holding.quantity *
              Math.max(0, holding.cost - (control?.stop ?? stop)) +
            feeFor(holding.quantity, control?.stop ?? stop, "sell", costs)
          : 0;
        const fraction = Math.min(
          sleeve.riskPerTrade,
          strategy.sizing.kind === "risk"
            ? strategy.sizing.fraction
            : sleeve.riskPerTrade,
        );
        const riskBudget = Math.max(0, capital * fraction - oldRisk);
        quantity = Math.min(
          quantity,
          floorStep(
            Math.max(0, riskBudget - costs.minimumCommission * 2) /
              (loss +
                (price * costs.commissionBps) / 10000 +
                (stop * (costs.commissionBps + costs.sellTaxBps)) / 10000),
            rules.step,
          ),
        );
      }
      if (
        quantity < rules.minimum ||
        quantity * price + feeFor(quantity, price, "buy", costs) >
          account.cash + 1e-8
      ) {
        reject(order, date, "资金不足以支付一手及费用");
        return;
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
    } else
      quantity = Math.min(
        quantity,
        account.sellable(
          key,
          dayOf(date, market),
          marketRules[market].settlementDays,
        ),
        rules.maximum,
      );
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
    const fee = feeFor(quantity, price, order.side, costs);
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
    order.status =
      remaining > 0 && order.side === "sell" ? "pending" : "filled";
    if (order.status !== "pending") removePending(order);
    order.reason = null;
    if (!remaining) controls.delete(key);
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
    });
  };
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
      const pending = [...pendingOrders.values()]
        .flatMap((active) => [...active])
        .filter(
          (o) =>
            o.status === "pending" &&
            o.due !== null &&
            Date.parse(o.due) <= Date.parse(date),
        )
        .sort(
          (a, b) =>
            (a.side === "sell" ? 0 : 1) - (b.side === "sell" ? 0 : 1) ||
            a.sleeve.localeCompare(b.sleeve) ||
            a.symbol.localeCompare(b.symbol) ||
            a.id - b.id,
        );
      pending.forEach((o) => execute(o, date));
    },
    close: (index, date) => {
      for (const strategy of strategies)
        for (const [symbol, source] of instruments) {
          const i = source.indices.get(date);
          if (i === undefined) continue;
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
          if (pendingOrders.has(key)) continue;
          let eligible: boolean;
          if (strategy.universe.kind === "symbols")
            eligible = symbolUniverses.get(strategy.id)!.has(symbol);
          else if (strategy.universe.kind === "rps") {
            const point = source.instrument.external?.rps?.find(
                (p) => p.date === date,
              ),
              value =
                point?.values[point.periods.indexOf(strategy.universe.period)]
                  ?.rps;
            eligible = value != null && value >= strategy.universe.minimum;
          } else {
            const membership = request.memberships?.find(
              (m) => m.strategyId === strategy.id && m.date === date,
            );
            if (!membership) throw new Error("Missing PIT universe membership");
            eligible = membership.symbols.includes(symbol);
          }
          const timed =
            !!current &&
            strategy.exit.maxBars !== undefined &&
            control!.bars >= strategy.exit.maxBars;
          const side =
            current && (decision.exit === true || timed)
              ? "sell"
              : eligible &&
                  decision.entry === true &&
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
      daily.set(dayOf(date, market), { ...row, date: dayOf(date, market) });
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
  };
}
