import {
  type StrategyDecision,
  usesStrategyBook,
  plannedStopRisk,
} from "trading-strategies";
import { type Bar } from "trading-strategy-core/bars";
import { marketRules } from "trading-strategy-core/market-rules";
import {
  executionCostsForDate,
  type ExecutionCosts,
} from "trading-strategy-core/costs";
import { big, toNumber, type Numeric } from "trading-strategy-core/money";
import { actionPrice } from "../portfolio-account.js";
import { fillMarketOrder } from "../execution.js";
import {
  sizePortfolioEntry,
  sizePortfolioTargetEntry,
  portfolioExecutionFee as feeFor,
} from "../portfolio-sizing.js";
import {
  type PortfolioExecution,
  type PortfolioInstrument,
  type PortfolioOrder,
} from "./types.js";
import { accountDate } from "./clock.js";
import { keyFor } from "./preparation.js";
import { type PortfolioState } from "./state.js";

const floorStep = (quantity: Numeric, step: number) =>
  toNumber(big(quantity).div(step).round(0, 0).times(step));
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
    (execution.slippagePolicy !== undefined &&
      !["reject", "clamp", "none"].includes(execution.slippagePolicy)) ||
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

export function createOrderExecutor(state: PortfolioState) {
  const {
    request,
    market,
    sleeves,
    costs,
    strategies,
    instruments,
    weightRows,
    accounts,
    controls,
    lastExitIndices,
    reentries,
    lifecycleExecutionEvidence,
    openingEquities,
    identities,
    fills,
    removePending,
    calendar,
    reject,
  } = state;
  const execute = (
    order: PortfolioOrder,
    date: string,
    reference?: number,
    decision?: StrategyDecision,
  ) => {
    const source = instruments.get(order.symbol)!;
    const index = source.indices.get(date);
    const strategy = strategies.find((s) => s.id === order.strategyId)!;
    // Missing opens use the normal quote/rejection path: buys expire, sells retry.
    order.attempts++;
    const bar = index === undefined ? undefined : source.instrument.bars[index];
    const rules = quantityRules(
      source.instrument,
      date,
      bar,
      index === undefined ? undefined : source.instrument.bars[index - 1],
    );
    const account = accounts.get(order.sleeve)!,
      key = keyFor(order.strategyId, order.symbol),
      holding = account.positions.get(key);
    const control = controls.get(key);
    if (
      order.side === "sell" &&
      order.exitFraction !== undefined &&
      order.targetRemainingQuantity === undefined &&
      holding &&
      rules.execution
    ) {
      const sell = floorStep(holding.quantity * order.exitFraction, rules.step);
      if (sell < rules.minimum) {
        reject(order, date, "按比例减仓不足最小交易数量，维持原仓");
        order.status = "rejected";
        removePending(order);
        return;
      }
      order.targetRemainingQuantity = Math.max(0, holding.quantity - sell);
    }
    const reachedQuantityTarget = (remaining: number) => {
      const target = order.targetRemainingQuantity;
      if (target === undefined) return false;
      const delta = Math.max(0, remaining - target);
      return (
        delta <= 1e-8 ||
        (market === "cn-equity" &&
          target > 0 &&
          rules.execution !== null &&
          floorStep(delta, rules.step) < rules.minimum)
      );
    };
    if (
      order.side === "sell" &&
      reachedQuantityTarget(holding?.quantity ?? 0)
    ) {
      order.status = "filled";
      order.reason = null;
      removePending(order);
      return;
    }
    if (
      order.side === "sell" &&
      account.sellable(
        key,
        accountDate(date, market),
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
    let stop: number | null = null;
    if (order.side === "buy") {
      let accountRoom = Infinity;
      if (
        request.accountMaxUniqueSymbols !== undefined ||
        request.accountMaxSymbolWeight !== undefined
      ) {
        const symbols = new Set<string>();
        let equity = 0,
          heldValue = 0;
        for (const ledger of accounts.values()) {
          equity += ledger.equity;
          for (const [id, position] of ledger.positions) {
            if (position.quantity <= 0) continue;
            const symbol = identities.get(id)!.symbol;
            symbols.add(symbol);
            if (symbol === order.symbol)
              heldValue += position.quantity * position.mark;
          }
        }
        if (
          request.accountMaxUniqueSymbols !== undefined &&
          !symbols.has(order.symbol) &&
          symbols.size >= request.accountMaxUniqueSymbols
        ) {
          reject(order, date, "账户跨分仓持仓品种上限");
          return;
        }
        if (request.accountMaxSymbolWeight !== undefined) {
          const weight = request.accountMaxSymbolWeight;
          const room = equity * weight - heldValue;
          // A fill re-marks this holding and debits fees from account equity.
          // Reserve fees on the maximum possible buy to keep the post-fill
          // weight within the cap even when notional lands exactly on a lot.
          const markChange = holding
            ? holding.quantity * (price - holding.mark)
            : 0;
          const markAdjustedRoom = room - (1 - weight) * markChange;
          const maxBuy = Math.min(
            rules.maximum,
            Math.max(0, Math.min(room, markAdjustedRoom)) / price,
          );
          const feeReserve = feeFor(maxBuy, price, "buy", dateCosts);
          const netRoom = Math.min(
            room,
            markAdjustedRoom - weight * feeReserve,
          );
          accountRoom = floorStep(Math.max(0, netRoom) / price, rules.step);
          if (accountRoom < rules.minimum) {
            reject(order, date, "账户跨分仓单票权重上限");
            return;
          }
        }
      }
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
      stop =
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
        equity:
          usesStrategyBook(strategy) || order.targetWeight !== undefined
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
      quantity = Math.min(sized.quantity, accountRoom);
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
    } else {
      quantity = Math.min(
        quantity,
        order.targetRemainingQuantity === undefined
          ? Infinity
          : Math.max(0, quantity - order.targetRemainingQuantity),
        account.sellable(
          key,
          accountDate(date, market),
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
    const capKey = `${date}\0${order.symbol}`;
    const usedCap = state.dailyCapacityUsed.get(capKey) ?? 0;
    const capacityAmount =
      request.maxParticipation !== undefined && bar && bar.amount > 0
        ? Math.max(0, bar.amount * request.maxParticipation - usedCap)
        : Infinity;
    const capacityClipped =
      Number.isFinite(capacityAmount) && quantity * price > capacityAmount;
    if (capacityClipped) {
      const reason = "超过参与率上限（容量情景）";
      if (request.capacityPolicy !== "clip") {
        reject(order, date, reason);
        return;
      }
      quantity = floorStep(capacityAmount / price, rules.step);
      if (quantity < rules.minimum || (order.side === "sell" && quantity < 1)) {
        reject(order, date, reason);
        return;
      }
      order.capacityClipped = true;
    }
    if (order.side === "buy") {
      controls.set(
        key,
        control
          ? { ...control, tranches: control.tranches + 1 }
          : {
              stop,
              entry: price,
              studyEntry: {
                entry:
                  (price *
                    source.instrument.signalBars[source.indices.get(date)!]!
                      .close) /
                  source.instrument.bars[source.indices.get(date)!]!.close,
                entryIndex: source.indices.get(date)!,
                signalIndex: source.indices.get(order.signalAt)!,
                lastExitIndex: lastExitIndices.get(key),
              },
              high: price,
              target: strategy.exit.takeProfit
                ? price * (1 + strategy.exit.takeProfit)
                : null,
              bars: 0,
              tranches: 1,
            },
      );
    }
    const fee = feeFor(quantity, price, order.side, dateCosts);
    account.fill(
      key,
      accountDate(date, market),
      order.side,
      quantity,
      price,
      fee,
      marketRules[market].settlementDays,
    );
    const remaining = account.positions.get(key)?.quantity ?? 0;
    if (Number.isFinite(capacityAmount))
      state.dailyCapacityUsed.set(capKey, usedCap + quantity * price);
    const targetRemaining =
      order.targetWeight === undefined
        ? 0
        : floorStep(
            ((openingEquities.get(order.sleeve) ?? account.equity) *
              order.targetWeight) /
              price,
            rules.step,
          );
    const targetPending =
      order.targetRemainingQuantity !== undefined
        ? !reachedQuantityTarget(remaining)
        : order.targetWeight !== undefined
          ? Math.abs(remaining - targetRemaining) > 1e-8
          : order.side === "sell" && remaining > 1e-8;
    order.status = targetPending ? "pending" : "filled";
    if (order.status !== "pending") removePending(order);
    order.reason = null;
    if (!remaining) {
      lastExitIndices.set(key, source.indices.get(date)!);
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
      ...(capacityClipped ? { capacityClipped: true as const } : {}),
      ...(lifecycleExecutionEvidence
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
  return execute;
}
export type OrderExecutor = ReturnType<typeof createOrderExecutor>;
