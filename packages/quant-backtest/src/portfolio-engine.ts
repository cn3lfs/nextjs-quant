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
  execution: PortfolioExecution | Readonly<Record<string, PortfolioExecution>>;
  external?: StrategyExternalInputs;
  actions?: readonly {
    date: string;
    dividend: number;
    bonus: number;
    evidence: string;
    availableAt: string;
    sharesSellableAt?: string;
  }[];
};
export type PortfolioSleeve = {
  id: string;
  share: number;
  riskPerTrade: number;
  maxPositions: number;
};
export type PortfolioRequest = {
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
function quantityRules(instrument: PortfolioInstrument, date: string) {
  const execution =
    "evidence" in instrument.execution
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
  const instruments = new Map(
    request.instruments.map((instrument) => {
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
        new Set(actions.map((a) => a.date)).size !== actions.length ||
        actions.some(
          (a) =>
            !a.evidence ||
            a.availableAt > a.date ||
            !Number.isFinite(a.dividend) ||
            a.dividend < 0 ||
            !Number.isFinite(a.bonus) ||
            a.bonus < 0 ||
            (a.bonus > 0 && !a.sharesSellableAt),
        )
      )
        throw new Error("Unsupported / unproven corporate action");
      return [
        instrument.symbol,
        {
          instrument,
          indices: new Map(instrument.bars.map((b, i) => [b.date, i])),
          evaluators: new Map(
            strategies.map((s) => [
              s.id,
              prepareStrategy(s, instrument.signalBars, instrument.external),
            ]),
          ),
        },
      ] as const;
    }),
  );
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
  const observations: {
    date: string;
    strategyId: string;
    symbol: string;
    decision: StrategyDecision;
  }[] = [];
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
    const rules = quantityRules(source.instrument, date),
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
          stop = (stop - action.dividend) / (1 + action.bonus);
      }
      if (control) stop = control.stop;
      if (strategy.exit.stop && (stop === null || stop <= 0 || stop >= price)) {
        reject(order, date, "缺失或无效初始止损");
        return;
      }
      const weight =
        strategy.sizing.kind === "equal"
          ? 1 / strategy.sizing.positions
          : strategy.sizing.kind === "weight"
            ? strategy.sizing.weight
            : 1;
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
      for (const { instrument } of instruments.values())
        for (const action of instrument.actions?.filter(
          (a) => a.date === date,
        ) ?? []) {
          for (const strategy of strategies) {
            const account = accounts.get(strategy.sleeve)!,
              key = keyFor(strategy.id, instrument.symbol),
              p = account.positions.get(key);
            if (!p) continue;
            const before = p.quantity;
            account.transfer(before * action.dividend);
            if (action.bonus) {
              const newQuantity = before * action.bonus;
              p.quantity += newQuantity;
              // Bonus shares must carry an independently supplied sellable date.
              p.lots.push({
                quantity: newQuantity,
                bought: date,
                availableOn: action.sharesSellableAt!,
              });
            }
            p.cost = (p.cost - action.dividend) / (1 + action.bonus);
            p.mark = (p.mark - action.dividend) / (1 + action.bonus);
            const c = controls.get(key)!;
            for (const field of ["entry", "high", "stop", "target"] as const)
              if (c[field] !== null)
                c[field] = (c[field]! - action.dividend) / (1 + action.bonus);
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
          const decision = source.evaluators.get(strategy.id)!.evaluate(i);
          observations.push({
            date,
            strategyId: strategy.id,
            symbol,
            decision,
          });
          if (pendingOrders.has(key)) continue;
          let eligible: boolean;
          if (strategy.universe.kind === "symbols")
            eligible = strategy.universe.symbols.includes(symbol);
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
    transfers,
  };
}
