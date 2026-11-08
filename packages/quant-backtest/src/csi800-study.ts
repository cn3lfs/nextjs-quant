import { csi800SignalBars } from "./csi800-signal.js";
import { big, toNumber } from "trading-strategy-core/money";
import { ema } from "trading-strategy-core/indicators";
import {
  createPositionRisk,
  positionRiskBuy,
  positionRiskSell,
  positionRiskAction,
  positionRiskPlannedLoss,
  evaluatePositionClose,
  type PositionRiskState,
  type PositionRiskStage,
} from "./csi800-position-risk.js";
import type { Bar } from "./model.js";

export type Csi800Stock = {
  symbol: string;
  bars: Bar[];
  actions: {
    date: string;
    dividend: number;
    bonus: number;
    rights?: number;
    rightsPrice?: number;
    unsupported: boolean;
  }[];
};
export type Csi800Options = {
  start: string;
  end: string;
  initial?: number;
  count?: number;
  slippageBps?: number;
  delay?: number;
  mode: "equal-pool" | "momentum" | "risk-weighted" | "regime" | "scheduled";
  positionRisk?: {
    execution: "assumed-close-auction";
    stage: PositionRiskStage;
  };
};
export type Csi800Allocation = {
  date: string;
  weights: Record<string, number>;
};
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const mean = (xs: number[]) => sum(xs) / xs.length;
const cashAdd = (a: number, b: number) => toNumber(big(a).plus(b));

/** Iterative capped allocation. Unallocatable capital stays in cash. */
export function csi800Weights(scores: number[], exposure: number) {
  if (
    !Number.isFinite(exposure) ||
    exposure < 0 ||
    exposure > 1 ||
    scores.some((v) => !Number.isFinite(v) || v <= 0)
  )
    throw new Error("权重输入非法");
  const weights = scores.map(() => 0);
  let remaining = exposure;
  let active = scores.map((_, i) => i);
  while (active.length && remaining > 1e-12) {
    const total = sum(active.map((i) => scores[i]!));
    const capped = active.filter(
      (i) => (remaining * scores[i]!) / total >= 0.15,
    );
    if (!capped.length) {
      for (const i of active) weights[i] = (remaining * scores[i]!) / total;
      break;
    }
    for (const i of capped) {
      weights[i] = 0.15;
      remaining -= 0.15;
    }
    active = active.filter((i) => !capped.includes(i));
  }
  return weights;
}

/** Simplified daily OHLC scenario; never labelled certified execution history. */
export function runCsi800Study(
  stocks: Csi800Stock[],
  benchmark: Bar[],
  options: Csi800Options,
  allocationSchedule?: readonly Csi800Allocation[],
) {
  const initial = options.initial ?? 1_000_000;
  const count = options.count ?? 20;
  const slip = (options.slippageBps ?? 10) / 10000;
  const delay = options.delay ?? 1;
  const riskEnabled = options.positionRisk !== undefined;
  if (
    riskEnabled &&
    (options.positionRisk!.execution !== "assumed-close-auction" ||
      !["initial", "breakeven", "partial", "full"].includes(
        options.positionRisk!.stage,
      ))
  )
    throw new Error("持仓风控模式非法");
  if (
    !(initial > 0) ||
    !Number.isInteger(count) ||
    count < 1 ||
    !(slip >= 0 && slip < 0.1) ||
    !Number.isInteger(delay) ||
    delay < 1
  )
    throw new Error("非法资金、持股数、滑点或成交延迟");
  const validate = (bars: Bar[]) => {
    let previous = "";
    for (const b of bars) {
      if (
        b.date <= previous ||
        ![b.open, b.close, b.high, b.low].every(
          (v) => Number.isFinite(v) && v > 0,
        ) ||
        b.low > Math.min(b.open, b.close) ||
        b.high < Math.max(b.open, b.close) ||
        !Number.isFinite(b.amount) ||
        b.amount < 0
      )
        throw new Error("行情日期或OHLC/成交额非法");
      previous = b.date;
    }
  };
  validate(benchmark);
  if ((options.mode === "scheduled") !== (allocationSchedule !== undefined))
    throw new Error("外部目标与scheduled模式必须同时提供");
  const schedule = new Map<string, Csi800Allocation>();
  const symbols = new Set(stocks.map((s) => s.symbol));
  for (const row of allocationSchedule ?? []) {
    if (
      schedule.has(row.date) ||
      !benchmark.some((b) => b.date === row.date) ||
      Object.entries(row.weights).some(
        ([symbol, w]) =>
          !symbols.has(symbol) ||
          !Number.isFinite(w) ||
          w < 0 ||
          w > 0.15 + 1e-12,
      ) ||
      Object.values(row.weights).reduce((a, b) => a + b, 0) > 1 + 1e-12
    )
      throw new Error("外部调仓目标日期/证券/权重非法");
    schedule.set(row.date, row);
  }
  if (new Set(stocks.map((s) => s.symbol)).size !== stocks.length)
    throw new Error("证券重复");
  const prepared = stocks.map((s) => {
    validate(s.bars);
    const actions = new Map(s.actions.map((a) => [a.date, a]));
    if (
      actions.size !== s.actions.length ||
      s.actions.some(
        (a) =>
          !Number.isFinite(a.dividend) ||
          a.dividend < 0 ||
          !Number.isFinite(a.bonus) ||
          a.bonus < 0,
      )
    )
      throw new Error("公司行动非法或重复");
    const adjusted = csi800SignalBars(s);
    const signal = adjusted.map((b) => b.close);
    return {
      ...s,
      actions,
      signal,
      ema50: riskEnabled
        ? ema(adjusted, 50).map((v, i) => (i >= 49 ? v : null))
        : undefined,
      indices: new Map(s.bars.map((b, i) => [b.date, i])),
    };
  });
  const dates = benchmark.map((b) => b.date);
  const first = dates.findIndex((d) => d >= options.start);
  if (first < 270) throw new Error("指数预热不足270日");
  const reverseLast = [...dates].reverse().findIndex((d) => d <= options.end);
  const last = reverseLast < 0 ? -1 : dates.length - 1 - reverseLast;
  if (last < first) throw new Error("研究区间为空");
  const holdings = new Map<
    string,
    { quantity: number; bought: string; mark: number }
  >();
  const targets: {
    signalDate: string;
    execute: number;
    weights: Map<string, number>;
  }[] = [];
  // The common window starts at the opening after its qualifying Friday.
  // Carry that already-observed target into day one instead of losing a week.
  for (const row of allocationSchedule ?? []) {
    const index = dates.indexOf(row.date);
    if (index < first && index + delay >= first)
      targets.push({
        signalDate: row.date,
        execute: index + delay,
        weights: new Map(Object.entries(row.weights)),
      });
  }
  let current: (typeof targets)[number] | undefined;
  let targetQuantities = new Map<string, number>();
  let pendingSells = new Set<string>();
  let cash = initial;
  const riskBooks = new Map<string, PositionRiskState>(),
    lastExit = new Map<string, string>();
  const riskEvents: {
    date: string;
    symbol: string;
    openedAt: string;
    entryEquity: number;
    budget: number;
    cost: number;
    capitalPerShare: number;
    gain: number;
    pnl: number;
    protection: number;
    ema50: number | null;
    breakEvenStop: number | null;
    requested: number;
    executed: number;
    remaining: number;
    action: string;
    reasons: string[];
    t1Blocked: boolean;
    trimArmed: boolean;
    trimRemaining: number;
    insufficientLot: boolean;
    triggeredAt: string | null;
    triggerReasons: string[];
  }[] = [];
  const riskTrades: {
    symbol: string;
    openedAt: string;
    closedAt: string;
    entryEquity: number;
    budget: number;
    realizedPnl: number;
    budgetBreached: boolean;
    exitTriggeredAt: string | null;
    exitTriggerReasons: string[];
    reason: string;
  }[] = [];
  const entryChecks: {
    date: string;
    signalDate: string;
    symbol: string;
    signalClose: number | null;
    signalEma50: number | null;
    previousClose: number;
    previousEma50: number | null;
    open: number;
    openingEma50: number | null;
    eligible: boolean;
    reason: string;
  }[] = [];
  const finishRisk = (symbol: string, date: string, reason: string) => {
    const state = riskBooks.get(symbol);
    if (!state) return;
    riskTrades.push({
      symbol,
      openedAt: state.openedAt,
      closedAt: date,
      entryEquity: state.entryEquity,
      budget: state.budget,
      realizedPnl: state.realized,
      budgetBreached: state.realized < -state.budget - 1e-8,
      exitTriggeredAt: state.exitTriggeredAt,
      exitTriggerReasons: [...state.exitTriggerReasons],
      reason,
    });
    riskBooks.delete(symbol);
    lastExit.set(symbol, date);
  };
  const fills: {
    date: string;
    signalDate: string;
    symbol: string;
    side: string;
    quantity: number;
    price: number;
    fee: number;
    reason?: string;
  }[] = [];
  const rejected: {
    date: string;
    symbol: string;
    side: string;
    reason: string;
  }[] = [];
  const curve: {
    date: string;
    equity: number;
    cash: number;
    exposure: number;
    holdings: number;
  }[] = [];
  const snapshots: {
    date: string;
    symbol: string;
    quantity: number;
    weight: number;
  }[] = [];
  const rebalances: {
    date: string;
    exposure: number;
    weights: Record<string, number>;
  }[] = [];
  const nav = () =>
    cash + sum([...holdings.values()].map((h) => h.quantity * h.mark));
  for (let day = first; day <= last; day++) {
    const date = dates[day]!;
    for (const s of prepared) {
      const a = s.actions.get(date),
        h = holdings.get(s.symbol);
      if (a?.unsupported && h)
        throw new Error(`${s.symbol} ${date} 持仓遇未支持配股/缩股，停止实验`);
      if (a && h) {
        const risk = riskBooks.get(s.symbol);
        if (risk) positionRiskAction(risk, a);
        const rightsCost = h.quantity * (a.rights ?? 0) * (a.rightsPrice ?? 0);
        cash = cashAdd(cash, h.quantity * a.dividend - rightsCost);
        if (cash < 0) throw new Error(`${s.symbol} ${date} 配股现金不足`);
        h.quantity *= 1 + a.bonus + (a.rights ?? 0);
        if (targetQuantities.has(s.symbol))
          targetQuantities.set(
            s.symbol,
            targetQuantities.get(s.symbol)! * (1 + a.bonus + (a.rights ?? 0)),
          );
        h.mark =
          (h.mark - a.dividend + (a.rights ?? 0) * (a.rightsPrice ?? 0)) /
          (1 + a.bonus + (a.rights ?? 0));
      }
    }
    const sellableAtClose = new Map(
      riskEnabled
        ? [...holdings].map(([symbol, h]) => [symbol, h.quantity] as const)
        : [],
    );
    const due = targets.filter((t) => t.execute === day).at(-1);
    if (due) current = due;
    // Opening valuation only uses today's open; never today's close or amount.
    for (const s of prepared) {
      const h = holdings.get(s.symbol),
        i = s.indices.get(date);
      if (h && i !== undefined) h.mark = s.bars[i]!.open;
    }
    const opening = nav();
    if (due)
      targetQuantities = new Map(
        prepared.map((s) => {
          const i = s.indices.get(date),
            b = i === undefined ? undefined : s.bars[i];
          const step = s.symbol.startsWith("sh688") ? 1 : 100;
          return [
            s.symbol,
            b
              ? Math.floor(
                  (opening * (due.weights.get(s.symbol) ?? 0)) / b.open / step,
                ) * step
              : due.weights.get(s.symbol)
                ? (holdings.get(s.symbol)?.quantity ?? 0)
                : 0,
          ];
        }),
      );
    if (due)
      pendingSells = new Set(
        [...holdings]
          .filter(
            ([symbol, h]) => h.quantity > (targetQuantities.get(symbol) ?? 0),
          )
          .map(([symbol]) => symbol),
      );
    const buys: {
      s: (typeof prepared)[number];
      quantity: number;
      price: number;
      capacity: number;
    }[] = [];
    const feeFor = (amount: number, sell: boolean) => {
      const tax = date >= "2023-08-28" ? 0.0005 : 0.001;
      return (
        Math.max(5, amount * 0.0003) +
        amount * (date >= "2022-04-29" ? 0.00001 : 0.00002) +
        (sell ? amount * tax : 0)
      );
    };
    if (current)
      for (const s of prepared) {
        const h = holdings.get(s.symbol),
          weight = current.weights.get(s.symbol) ?? 0;
        const risk = riskBooks.get(s.symbol);
        if (risk?.exitPending) continue;
        if (!due && !pendingSells.has(s.symbol)) continue;
        const i = s.indices.get(date),
          b = i === undefined ? undefined : s.bars[i];
        // Only the execution day can create a buy; blocked exits persist.
        if (!h && (!weight || !due)) continue;
        if (i === undefined || !b || i < 20) {
          if (h)
            rejected.push({
              date,
              symbol: s.symbol,
              side: "sell",
              reason: "缺失行情/停牌",
            });
          continue;
        }
        const step = s.symbol.startsWith("sh688") ? 1 : 100;
        const minimum = s.symbol.startsWith("sh688") ? 200 : 100;
        const target = targetQuantities.get(s.symbol) ?? 0;
        const diff = target - (h?.quantity ?? 0);
        const side = diff < 0 ? "sell" : "buy";
        if (
          riskEnabled &&
          side === "buy" &&
          (risk?.trimArmed ||
            (lastExit.has(s.symbol) &&
              current.signalDate <= lastExit.get(s.symbol)!))
        ) {
          rejected.push({
            date,
            symbol: s.symbol,
            side,
            reason: risk?.trimArmed
              ? "部分止盈后只减不加"
              : "退出后需后续独立信号",
          });
          continue;
        }
        if (diff === 0 || (side === "buy" && !due)) continue;
        const prev = s.bars[i - 1]!,
          a = s.actions.get(date);
        if (side === "buy" && options.positionRisk?.stage === "full") {
          const si = s.indices.get(current.signalDate),
            signalBar = si === undefined ? undefined : s.bars[si];
          const signalEma = si === undefined ? undefined : s.ema50?.[si],
            previousEma = s.ema50?.[i - 1];
          const signalEma50 =
            signalBar && signalEma !== null && signalEma !== undefined
              ? signalEma / (s.signal[si!]! / signalBar.close)
              : null;
          const previousEma50 =
            previousEma !== null && previousEma !== undefined
              ? previousEma / (s.signal[i - 1]! / prev.close)
              : null;
          let openingEma50 = previousEma50;
          // Only already-effective actions and the prior completed EMA are known at open.
          if (openingEma50 !== null)
            for (const action of [...s.actions.values()]
              .filter((x) => x.date > prev.date && x.date <= date)
              .sort((x, y) => x.date.localeCompare(y.date)))
              openingEma50 =
                (openingEma50 -
                  action.dividend +
                  (action.rights ?? 0) * (action.rightsPrice ?? 0)) /
                (1 + action.bonus + (action.rights ?? 0));
          const reason =
            signalEma50 === null ||
            previousEma50 === null ||
            openingEma50 === null
              ? "EMA50入场：均线缺失或预热不足"
              : signalBar!.close < signalEma50 - 1e-12
                ? "EMA50入场：信号收盘低于均线"
                : prev.close < previousEma50 - 1e-12
                  ? "EMA50入场：最新收盘低于均线"
                  : b.open < openingEma50 - 1e-12
                    ? "EMA50入场：开盘低于已知均线"
                    : "eligible";
          const eligible = reason === "eligible";
          entryChecks.push({
            date,
            signalDate: current.signalDate,
            symbol: s.symbol,
            signalClose: signalBar?.close ?? null,
            signalEma50,
            previousClose: prev.close,
            previousEma50,
            open: b.open,
            openingEma50,
            eligible,
            reason,
          });
          if (!eligible) {
            rejected.push({ date, symbol: s.symbol, side, reason });
            continue;
          }
        }
        const ref =
          (prev.close -
            (a?.dividend ?? 0) +
            (a?.rights ?? 0) * (a?.rightsPrice ?? 0)) /
          (1 + (a?.bonus ?? 0) + (a?.rights ?? 0));
        const limit =
          s.symbol.startsWith("sh688") ||
          (s.symbol.startsWith("sz30") && date >= "2020-08-24")
            ? 0.2
            : 0.1;
        const upper = Math.round(ref * (1 + limit) * 100) / 100,
          lower = Math.round(ref * (1 - limit) * 100) / 100;
        // Scenario rejects open at a limit, without claiming a historical queue fill.
        if (
          (side === "buy" && b.open >= upper - 0.001) ||
          (side === "sell" && b.open <= lower + 0.001) ||
          b.volume <= 0
        ) {
          rejected.push({
            date,
            symbol: s.symbol,
            side,
            reason: "涨跌停/零量",
          });
          continue;
        }
        const price = b.open * (1 + (side === "buy" ? slip : -slip));
        if (
          price > b.high ||
          price < b.low ||
          price >= upper ||
          price <= lower
        ) {
          rejected.push({
            date,
            symbol: s.symbol,
            side,
            reason: "滑点超出可成交区间",
          });
          continue;
        }
        const capacity =
          Math.floor(
            (mean(s.bars.slice(i - 20, i).map((x) => x.amount)) * 0.01) /
              price /
              step,
          ) * step;
        if (side === "buy") {
          const quantity = Math.min(
            capacity,
            Math.floor((opening * weight) / price / step) * step -
              (h?.quantity ?? 0),
          );
          if (quantity >= minimum) buys.push({ s, quantity, price, capacity });
        } else if (h && h.bought < date) {
          let quantity = Math.min(-diff, capacity);
          if (quantity < h.quantity)
            quantity = Math.floor(quantity / step) * step;
          if (quantity <= 0) continue;
          const fee = feeFor(quantity * price, true);
          cash = cashAdd(cash, quantity * price - fee);
          if (risk) positionRiskSell(risk, quantity, price, fee);
          if (riskEnabled)
            sellableAtClose.set(
              s.symbol,
              Math.max(0, (sellableAtClose.get(s.symbol) ?? 0) - quantity),
            );
          h.quantity -= quantity;
          fills.push({
            date,
            signalDate: current.signalDate,
            symbol: s.symbol,
            side,
            quantity,
            price,
            fee,
          });
          if (h.quantity < 1e-8) {
            holdings.delete(s.symbol);
            if (riskEnabled) finishRisk(s.symbol, date, "ordinary-rebalance");
          }
        }
      }
    const needed = sum(
      buys.map(
        (b) => b.quantity * b.price + feeFor(b.quantity * b.price, false),
      ),
    );
    const scale = Math.min(1, cash / Math.max(needed, 1));
    for (const buy of buys) {
      const { s, price } = buy;
      const step = s.symbol.startsWith("sh688") ? 1 : 100;
      const minimum = s.symbol.startsWith("sh688") ? 200 : 100;
      let quantity = Math.floor((buy.quantity * scale) / step) * step;
      const before = holdings.get(s.symbol)?.quantity ?? 0;
      const existingRisk = riskBooks.get(s.symbol),
        entryEquity = nav(),
        budget = existingRisk?.budget ?? entryEquity * 0.02;
      while (
        quantity >= minimum &&
        (quantity * price + feeFor(quantity * price, false) > cash ||
          (riskEnabled &&
            positionRiskPlannedLoss(
              existingRisk,
              before,
              quantity,
              price,
              feeFor(quantity * price, false),
              feeFor((before + quantity) * price, true),
            ) >
              budget + 1e-8))
      )
        quantity -= step;
      if (quantity < minimum) continue;
      const fee = feeFor(quantity * price, false);
      if (riskEnabled) {
        const state = existingRisk ?? createPositionRisk(date, entryEquity);
        positionRiskBuy(state, before, quantity, price, fee);
        riskBooks.set(s.symbol, state);
      }
      cash = cashAdd(cash, -quantity * price - fee);
      const h = holdings.get(s.symbol);
      holdings.set(s.symbol, {
        quantity: quantity + (h?.quantity ?? 0),
        bought: date,
        mark: price,
      });
      fills.push({
        date,
        signalDate: current!.signalDate,
        symbol: s.symbol,
        side: "buy",
        quantity,
        price,
        fee,
      });
    }
    for (const s of prepared) {
      const h = holdings.get(s.symbol),
        i = s.indices.get(date);
      if (h && i !== undefined) h.mark = s.bars[i]!.close;
    }
    if (riskEnabled)
      for (const s of prepared) {
        const h = holdings.get(s.symbol),
          state = riskBooks.get(s.symbol),
          i = s.indices.get(date);
        if (!h || !state || i === undefined) continue;
        const bar = s.bars[i]!,
          ratio = s.signal[i]! / bar.close;
        const emaValue = s.ema50?.[i];
        const ema50 =
          emaValue !== null && emaValue !== undefined ? emaValue / ratio : null;
        const step = s.symbol.startsWith("sh688") ? 1 : 100,
          minimumPartial = s.symbol.startsWith("sh688") ? 200 : 100;
        const decision = evaluatePositionClose(state, {
          date,
          close: bar.close,
          quantity: h.quantity,
          exitFee: feeFor(h.quantity * bar.close, true),
          ema50,
          stage: options.positionRisk!.stage,
          sellStep: step,
          minimumPartial,
        });
        const requested = decision.requested,
          available = sellableAtClose.get(s.symbol) ?? 0;
        let quantity = Math.min(requested, available);
        if (quantity < h.quantity - 1e-8)
          quantity = Math.floor(quantity / step) * step;
        if (decision.action === "trim" && quantity < minimumPartial)
          quantity = 0;
        quantity = Math.max(0, quantity);
        if (quantity > 0) {
          const fee = feeFor(quantity * bar.close, true);
          cash = cashAdd(cash, quantity * bar.close - fee);
          positionRiskSell(state, quantity, bar.close, fee);
          h.quantity -= quantity;
          sellableAtClose.set(s.symbol, Math.max(0, available - quantity));
          fills.push({
            date,
            signalDate:
              (decision.action === "exit"
                ? state.exitTriggeredAt
                : state.trimTriggeredAt) ?? date,
            symbol: s.symbol,
            side: "sell",
            quantity,
            price: bar.close,
            fee,
            reason:
              decision.action === "exit"
                ? "position-risk-exit"
                : "profit-30pct-trim",
          });
        }
        const blocked =
          requested > quantity + 1e-8 && available < requested - 1e-8;
        if (blocked)
          rejected.push({
            date,
            symbol: s.symbol,
            side: "sell",
            reason: "收盘风控：T+1可卖库存不足",
          });
        riskEvents.push({
          date,
          symbol: s.symbol,
          openedAt: state.openedAt,
          entryEquity: state.entryEquity,
          budget: state.budget,
          cost: state.cost,
          capitalPerShare: state.capitalPerShare,
          gain: decision.gain,
          pnl: decision.pnl,
          protection: decision.protection,
          ema50,
          breakEvenStop: state.breakEvenStop,
          requested,
          executed: quantity,
          remaining: h.quantity,
          action: decision.action,
          reasons: decision.reasons,
          t1Blocked: blocked,
          trimArmed: state.trimArmed,
          trimRemaining: state.trimRemaining,
          insufficientLot: decision.insufficientLot,
          triggeredAt:
            decision.action === "exit"
              ? state.exitTriggeredAt
              : state.trimTriggeredAt,
          triggerReasons: [...state.exitTriggerReasons],
        });
        if (h.quantity < 1e-8) {
          holdings.delete(s.symbol);
          finishRisk(
            s.symbol,
            date,
            decision.reasons.join(",") || "profit-trim",
          );
        }
      }
    const equity = nav();
    if (!Number.isFinite(equity) || equity <= 0 || cash < -1e-7)
      throw new Error("账户守恒/净值异常");
    curve.push({
      date,
      equity,
      cash,
      exposure: 1 - cash / equity,
      holdings: holdings.size,
    });
    for (const [symbol, h] of holdings)
      snapshots.push({
        date,
        symbol,
        quantity: h.quantity,
        weight: (h.quantity * h.mark) / equity,
      });
    if (options.mode === "scheduled") {
      const row = schedule.get(date);
      if (row) {
        const weights = new Map(Object.entries(row.weights));
        targets.push({ signalDate: date, execute: day + delay, weights });
        rebalances.push({
          date,
          exposure: sum([...weights.values()]),
          weights: row.weights,
        });
      }
      continue;
    }
    // ISO week boundary, including exchange holidays. Extra calendar bars are
    // required by the caller so the end of the requested interval isn't a fake Friday.
    const week = (d: string) => {
      const n = new Date(d);
      n.setUTCDate(n.getUTCDate() - ((n.getUTCDay() + 6) % 7));
      return n.toISOString().slice(0, 10);
    };
    if (!dates[day + 1] || week(date) === week(dates[day + 1]!)) continue;
    const candidates = prepared.flatMap((s) => {
      const i = s.indices.get(date);
      if (
        i === undefined ||
        i < 250 ||
        mean(s.bars.slice(i - 19, i + 1).map((b) => b.amount)) < 50_000_000
      )
        return [];
      const p = s.signal;
      const avg = mean(p.slice(i - 119, i + 1)),
        old = mean(p.slice(i - 139, i - 19));
      const trend = p[i]! > avg && avg > old;
      const returns = p
        .slice(i - 59, i + 1)
        .map((v, j) => v / p[i - 60 + j]! - 1);
      const m = mean(returns),
        vol = Math.sqrt(sum(returns.map((r) => (r - m) ** 2)) / 59);
      if (!(vol > 0) || (options.mode !== "equal-pool" && !trend)) return [];
      return [
        {
          symbol: s.symbol,
          vol,
          a: p[i - 20]! / p[i - 120]! - 1,
          b: p[i - 20]! / p[i - 250]! - 1,
        },
      ];
    });
    const rank = (key: "a" | "b") =>
      new Map(
        [...candidates]
          .sort((a, b) => a[key] - b[key] || a.symbol.localeCompare(b.symbol))
          .map((s, i) => [s.symbol, i]),
      );
    const ra = rank("a"),
      rb = rank("b");
    candidates.sort(
      (a, b) =>
        ra.get(b.symbol)! +
          rb.get(b.symbol)! -
          (ra.get(a.symbol)! + rb.get(a.symbol)!) ||
        a.symbol.localeCompare(b.symbol),
    );
    let chosen =
      options.mode === "equal-pool"
        ? candidates
        : candidates
            .filter((c, i) => i < 30 && holdings.has(c.symbol))
            .slice(0, count);
    if (options.mode !== "equal-pool")
      for (const c of candidates)
        if (chosen.length < count && !chosen.includes(c)) chosen.push(c);
    let exposure = 1;
    if (options.mode === "regime") {
      const closes = benchmark.map((b) => b.close);
      exposure =
        (Number(closes[day]! > mean(closes.slice(day - 249, day + 1))) +
          Number(
            mean(closes.slice(day - 119, day + 1)) >
              mean(closes.slice(day - 139, day - 19)),
          )) /
        2;
    }
    // Fewer than count candidates leave their unfilled slots as cash.
    if (options.mode !== "equal-pool")
      exposure *= Math.min(1, chosen.length / count);
    const weights = csi800Weights(
      chosen.map((s) =>
        options.mode === "momentum" || options.mode === "equal-pool"
          ? 1
          : 1 / s.vol,
      ),
      exposure,
    );
    const map = new Map(chosen.map((s, i) => [s.symbol, weights[i]!]));
    targets.push({ signalDate: date, execute: day + delay, weights: map });
    rebalances.push({ date, exposure, weights: Object.fromEntries(map) });
  }
  return {
    version: riskEnabled ? "csi800-study-position-risk-3" : "csi800-study-1",
    options,
    initial,
    curve,
    fills,
    rejected,
    snapshots,
    rebalances,
    ...(riskEnabled
      ? {
          riskEvents,
          riskTrades,
          entryChecks,
          openRiskPositions: [...riskBooks].map(([symbol, state]) => ({
            symbol,
            ...state,
            quantity: holdings.get(symbol)!.quantity,
            mark: holdings.get(symbol)!.mark,
          })),
          executionAssumption:
            "risk-confirmed-and-filled-at-same-close; no-slippage-or-capacity-limit; fees-and-T+1-retained",
        }
      : {}),
  };
}
