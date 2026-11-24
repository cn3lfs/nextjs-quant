import {
  type StrategyDecision,
  usesStrategyBook,
  plannedStopRisk,
  standingProtectionLevels,
} from "trading-strategies";
import { type Bar } from "trading-strategy-core/bars";
import {
  defaultPortfolioRiskPolicy,
  isCnEtfSymbol,
  resolveInstrumentRule,
  sizeEntryWithRisk,
  type InstrumentRule,
} from "quant-execution";
import { marketRules } from "trading-strategy-core/market-rules";
import {
  executionCostsForDate,
  executionCostsForInstrument,
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
  type PortfolioWindowQuote,
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
  instrumentRule?: InstrumentRule,
) {
  const execution =
    typeof instrument.execution === "function"
      ? instrument.execution(bar, previous)
      : "evidence" in instrument.execution
        ? (instrument.execution as PortfolioExecution)
        : instrument.execution[date];
  const template = marketRules[instrument.market];
  const minimum =
    instrumentRule?.minimumBuyQuantity ??
    execution?.minimum ??
    template.quantity.minimum;
  const step =
    instrumentRule?.buyQuantityStep ??
    execution?.step ??
    template.quantity.step;
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
  instrumentRule?: InstrumentRule,
) {
  const result = fillMarketOrder(
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
  if (!instrumentRule || result.price === null) return result;
  const tick = instrumentRule.priceTick;
  // Remove only binary roundoff at the tick boundary before adverse rounding.
  const ticks = big(result.price).div(tick).round(10, 1);
  const price = toNumber(ticks.round(0, side === "buy" ? 3 : 0).times(tick));
  if (
    price > bar!.high ||
    price < bar!.low ||
    (execution!.limitUp !== null &&
      (side === "buy"
        ? price >= execution!.limitUp
        : price > execution!.limitUp)) ||
    (execution!.limitDown !== null &&
      (side === "sell"
        ? price <= execution!.limitDown
        : price < execution!.limitDown))
  )
    return { price: null, reason: "价格档位取整后超出可成交范围" } as const;
  return { price, reason: null } as const;
}

type RiskEntry = NonNullable<PortfolioState["riskAudit"]>["entries"][number];
type OrderPlan = {
  price: number;
  quantity: number;
  dateCosts: ExecutionCosts;
  stop: number | null;
  capacityAmount: number;
  capacityClipped: boolean;
  riskEntry?: RiskEntry;
};
type OrderFailure = { reason: string | null; riskEntry?: RiskEntry };

function observedWindowPrice(
  window: PortfolioWindowQuote,
  raw: number,
  rules: PortfolioExecution | null,
  side: "buy" | "sell",
  hasBar: boolean,
  tick?: number,
): { price: number; reason: null } | { price: null; reason: string } {
  if (!hasBar || !rules?.tradable)
    return { price: null, reason: "停牌或缺少当日交易限制依据" };
  if (!Number.isFinite(raw) || raw <= 0)
    return { price: null, reason: "窗口执行报价无效" };
  const price = tick
    ? toNumber(
        big(raw)
          .div(tick)
          .round(10, 1)
          .round(0, side === "buy" ? 3 : 0)
          .times(tick),
      )
    : raw;
  // Use only the completed window and the announced limits. The full day's
  // high, low and volume are not known when the morning order executes.
  if (
    (window.low !== undefined &&
      (!Number.isFinite(window.low) || price < window.low - 1e-6)) ||
    (window.high !== undefined &&
      (!Number.isFinite(window.high) || price > window.high + 1e-6)) ||
    (rules.limitUp !== null &&
      (side === "buy" ? price >= rules.limitUp : price > rules.limitUp)) ||
    (rules.limitDown !== null &&
      (side === "sell" ? price <= rules.limitDown : price < rules.limitDown))
  )
    return { price: null, reason: "执行价超出窗口或当日价格限制" };
  return { price, reason: null };
}

export function createOrderExecutor(state: PortfolioState) {
  if (state.request.executionSlices !== undefined) {
    const slices = state.request.executionSlices;
    if (
      !state.request.executionQuote ||
      state.market !== "cn-equity" ||
      !slices.length ||
      slices.some(
        (time, i) =>
          !/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ||
          (i > 0 && time <= slices[i - 1]!),
      )
    )
      throw new Error(
        "Execution slices require an ordered set of exchange-local window end times and an equity quote provider",
      );
  }
  const parentExecutions = new Map<
    number,
    { quantity: number; riskUsed: number; riskBudget: number }
  >();
  // At the auction the sell plan is known but its proceeds are still contingent.
  // Use this projection only to split intentions; every child checks the live cash and inventory.
  const plannedSales = new Map<string, number>();
  const windowUsage = new Map<string, number>();
  let usageDate: string | undefined;
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
  const strategyById = new Map(
    strategies.map((strategy) => [strategy.id, strategy]),
  );
  const standingStop = (key: string, strategyId: string) => {
    const control = controls.get(key);
    if (!control) return null;
    const { stop } = standingProtectionLevels(
      strategyById.get(strategyId)!.exit,
      control,
    );
    return stop > 0 ? stop : null;
  };
  const execute = (
    order: PortfolioOrder,
    date: string,
    reference?: number,
    decision?: StrategyDecision,
    planning = false,
  ) => {
    const source = instruments.get(order.symbol)!;
    const index = source.indices.get(date);
    const strategy = strategyById.get(order.strategyId)!;
    // Missing opens use the normal quote/rejection path: buys expire, sells retry.
    order.attempts++;
    const bar = index === undefined ? undefined : source.instrument.bars[index];
    const instrument = source.instrument;
    const instrumentRule =
      market === "cn-equity" &&
      (isCnEtfSymbol(order.symbol) ||
        request.executionQuote !== undefined ||
        request.riskPolicy !== undefined ||
        instrument.instrumentKind !== undefined ||
        instrument.settlementCycle !== undefined ||
        instrument.stampDutyExempt !== undefined ||
        instrument.historicalTransfer !== undefined)
        ? resolveInstrumentRule(order.symbol, date, instrument)
        : undefined;
    const settlementDays =
      instrumentRule?.settlementDays ?? marketRules[market].settlementDays;
    const rules = quantityRules(
      source.instrument,
      date,
      bar,
      index === undefined ? undefined : source.instrument.bars[index - 1],
      instrumentRule,
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
      if (
        order.drawdownReduction &&
        (holding?.quantity ?? 0) > order.targetRemainingQuantity!
      ) {
        reject(order, date, "按比例减仓不足最小交易数量，维持原仓");
        order.status = "rejected";
      } else {
        order.status = "filled";
        order.reason = null;
      }
      removePending(order);
      return;
    }
    const window = planning
      ? undefined
      : request.executionQuote?.({
          order,
          date,
          reference,
          bar,
          previous:
            index === undefined ? undefined : instrument.bars[index - 1],
          phase: reference === undefined ? "opening" : "protection",
          ...(order.sliceEnd && { sliceEnd: order.sliceEnd }),
          ...(reference === undefined &&
          control &&
          holding &&
          account.sellable(key, accountDate(date, market), settlementDays) > 0
            ? {
                standingProtection: standingProtectionLevels(
                  strategy.exit,
                  control,
                ),
              }
            : {}),
        });
    if (window && "reason" in window) {
      reject(order, date, window.reason);
      if (window.discard) {
        order.status = "rejected";
        removePending(order);
      }
      return;
    }
    if (order.sliceEnd && !window) {
      reject(order, date, "缺少分笔执行窗口的报价");
      return;
    }
    if (
      order.side === "sell" &&
      account.sellable(key, accountDate(date, market), settlementDays) <= 0
    ) {
      reject(order, date, "T+1：当日买入不可卖出");
      return;
    }
    const quoteCosts = executionCostsForDate(costs, date);
    const result = planning
      ? bar && rules.execution
        ? { price: bar.open, reason: null }
        : { price: null, reason: "无法按开盘价冻结分笔数量" }
      : window
        ? observedWindowPrice(
            window,
            window.referencePrice,
            rules.execution,
            order.side,
            !!bar,
          )
        : quote(
            bar,
            rules.execution,
            order.side,
            quoteCosts,
            reference,
            instrumentRule,
          );
    if (result.price === null) {
      reject(order, date, result.reason!);
      return;
    }
    const capKey = `${date}\0${order.symbol}`;
    const usedCap = state.dailyCapacityUsed.get(capKey) ?? 0;
    const sleeve = sleeves.find((s) => s.id === order.sleeve)!;
    const available = window?.availableQuantity;
    if (order.sliceEnd && available === undefined) {
      reject(order, date, "缺少分笔窗口实际成交量");
      return;
    }
    if (window && usageDate !== date) {
      windowUsage.clear();
      usageDate = date;
    }
    if (
      available !== undefined &&
      (!Number.isSafeInteger(available) || available < 0)
    )
      throw new Error("Invalid execution window volume");
    const windowKey = order.sliceEnd
      ? order.symbol + "\0" + order.sliceEnd
      : order.symbol;
    const usedShares = windowUsage.get(windowKey) ?? 0;
    const parent =
      order.parentOrderId === undefined
        ? undefined
        : parentExecutions.get(order.parentOrderId);
    // Opening direction and intended holdings use the same observable mark.
    // The later fill still observes the actual cash, risk and fee budgets.
    const frozenTargetQuantity =
      (window || planning) && order.targetWeight !== undefined && bar
        ? floorStep(
            big(openingEquities.get(order.sleeve) ?? account.equity)
              .times(order.targetWeight)
              .div(bar.open),
            rules.step,
          )
        : undefined;
    const planAtPrice = (price: number): OrderPlan | OrderFailure => {
      const dateCosts = instrumentRule
        ? executionCostsForInstrument(costs, order.symbol, date, {
            ...instrument,
            price,
          })
        : quoteCosts;
      let quantity = holding?.quantity ?? 0;
      let stop: number | null = null;
      let riskEntry:
        NonNullable<typeof state.riskAudit>["entries"][number] | undefined;
      if (order.side === "buy") {
        let accountRoom = Infinity;
        if (
          !planning &&
          (request.accountMaxUniqueSymbols !== undefined ||
            request.accountMaxSymbolWeight !== undefined)
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
            return { reason: "账户跨分仓持仓品种上限" };
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
              return { reason: "账户跨分仓单票权重上限" };
            }
          }
        }
        const heldNames = new Set(
          [...account.positions.keys()].map((k) => identities.get(k)!.symbol),
        );
        if (
          !planning &&
          !holding &&
          (usesStrategyBook(strategy)
            ? !heldNames.has(order.symbol) &&
              heldNames.size >= sleeve.maxPositions
            : account.positions.size >= sleeve.maxPositions)
        ) {
          return { reason: "sleeve持仓上限" };
        }
        if (
          order.targetWeight === undefined &&
          !parent?.quantity &&
          (control?.tranches ?? 0) >= strategy.sizing.tranches
        ) {
          return { reason: "分批建仓次数上限" };
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
        if (control)
          stop = request.riskPolicy
            ? standingStop(key, strategy.id)
            : control.stop;
        // An opening gap can put an existing stop on the wrong side of the
        // entry price. Leave it to the account risk decision and let the
        // existing position's protection execute independently.
        const crossedStandingStop =
          !!request.riskPolicy && !!control && stop !== null && stop >= price;
        if (
          strategy.exit.stop &&
          (stop === null ||
            stop <= 0 ||
            (stop >= price && !crossedStandingStop))
        ) {
          return { reason: "缺失或无效初始止损" };
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
                  weight:
                    planning || parent
                      ? 1
                      : Math.max(order.targetWeight, 1e-12),
                  tranches: 1,
                }
              : strategy.sizing,
          equity:
            usesStrategyBook(strategy) || order.targetWeight !== undefined
              ? (openingEquities.get(order.sleeve) ?? account.equity)
              : account.equity,
          cash: planning ? account.equity : account.cash,
          price,
          stop: crossedStandingStop ? null : stop,
          riskPerTrade: sleeve.riskPerTrade,
          weightCeiling:
            (planning || parent) && order.targetWeight !== undefined
              ? legacyCeiling
              : ceiling,
          existing: holding
            ? {
                quantity: holding.quantity,
                cost: holding.cost,
                stop: control?.stop ?? stop,
              }
            : undefined,
          quantityRules: rules,
          costs: dateCosts,
          reserveTransferFee: !!instrumentRule,
        };
        const targetWeight = order.targetWeight ?? order.weightCeiling;
        const sized =
          targetWeight === undefined
            ? sizePortfolioEntry(sizingInput)
            : sizePortfolioTargetEntry({
                ...sizingInput,
                targetWeight,
                frozenTargetQuantity,
              });
        quantity = Math.min(sized.quantity, accountRoom);
        if (sized.reason) {
          return { reason: sized.reason };
        }
        if (strategy.overlay && !planning && !crossedStandingStop) {
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
              return { reason: "缺已冻结行业依据，不能核对组合行业上限" };
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
              return { reason: "既有持仓止损风险未知" };
            }
            remainingRisk = Math.min(
              remainingRisk,
              Math.max(0, equity * overlay.heat - used),
            );
          }
          if (overlay.correlationGroupRisk !== undefined) {
            const group = order.riskGroups?.find((g) =>
                g.includes(order.symbol),
              ),
              known = new Set(order.riskGroups?.flat());
            if (!group || held.some((h) => !known.has(h.symbol))) {
              return { reason: "缺同日相关组依据，不能核对连通组风险" };
            }
            const used = holdingRisk(
              held.filter((h) => group.includes(h.symbol)),
            );
            if (used === null) {
              return { reason: "相关组持仓止损风险未知" };
            }
            remainingRisk = Math.min(
              remainingRisk,
              Math.max(0, equity * overlay.correlationGroupRisk - used),
            );
          }
          if (Number.isFinite(remainingRisk)) {
            if (stop === null) {
              return { reason: "缺少组合风险所需止损" };
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
            return { reason: "组合单票、行业、总风险或相关组风险上限" };
          }
        }
        if (request.riskPolicy && state.riskAudit) {
          const industryOf = (symbol: string) =>
            order.industries?.[symbol]?.[0] ??
            instruments.get(symbol)?.instrument.industry;
          let remark = 0;
          const positions = [...accounts.values()].flatMap((ledger) =>
            [...ledger.positions].map(([id, position]) => {
              const { symbol, strategyId } = identities.get(id)!;
              const mark = symbol === order.symbol ? price : position.mark;
              remark += position.quantity * (mark - position.mark);
              return {
                symbol,
                quantity:
                  position.quantity -
                  (planning ? (plannedSales.get(id) ?? 0) : 0),
                mark,
                stopPrice: standingStop(id, strategyId),
                industry: industryOf(symbol),
              };
            }),
          );
          const equity =
            [...accounts.values()].reduce(
              (sum, ledger) => sum + ledger.equity,
              0,
            ) + remark;
          const atr = state.riskAtrAt(source, si);
          let rawAtr = atr === null ? null : atr * ratio;
          if (rawAtr !== null) {
            for (const action of instrument.actions ?? []) {
              if (action.date > order.signalAt && action.date <= date)
                rawAtr /=
                  (1 + action.bonus + (action.rightsRatio ?? 0)) *
                  (action.shareFactor ?? 1);
            }
          }
          const riskRequested = parent
            ? Math.min(quantity, order.plannedQuantity!)
            : quantity;
          const decision = sizeEntryWithRisk({
            date: state.observationDay(date),
            symbol: order.symbol,
            price,
            equity,
            cash: planning ? account.equity : account.cash,
            requestedQuantity: riskRequested,
            positions,
            stopPrice: stop,
            industry: industryOf(order.symbol),
            atr: rawAtr,
            policy: request.riskPolicy,
            // The full parent already applied the last close's drawdown multiplier.
            state: parent ? undefined : state.riskAudit.daily.at(-1),
            cashCost: (q) => q * price + feeFor(q, price, "buy", dateCosts),
            rule: instrumentRule ?? {
              kind: "crypto",
              minimumBuyQuantity: rules.minimum,
              buyQuantityStep: rules.step,
            },
          });
          riskEntry = {
            orderId: order.id,
            date,
            symbol: order.symbol,
            requestedQuantity: riskRequested,
            decision,
          };
          quantity = decision.quantity;
          stop = decision.stopPrice;
          if (parent && stop !== null && price > stop) {
            const left = Math.max(0, parent.riskBudget - parent.riskUsed);
            const allowed = floorStep(
              big(left).div(big(price).minus(stop)),
              rules.step,
            );
            if (allowed < quantity) {
              quantity = allowed >= rules.minimum ? allowed : 0;
              decision.quantity = quantity;
              if (!decision.reasons.includes("trade_risk_cap"))
                decision.reasons.push("trade_risk_cap");
              decision.stopRiskAfter =
                (decision.existingStopRisk ?? 0) + quantity * (price - stop);
            }
          }
          if (quantity === 0) {
            return { reason: decision.reasons.join(" / "), riskEntry };
          }
        }
      } else {
        quantity = Math.min(
          quantity,
          order.targetRemainingQuantity === undefined
            ? Infinity
            : Math.max(0, quantity - order.targetRemainingQuantity),
          account.sellable(key, accountDate(date, market), settlementDays),
          rules.maximum,
        );
        if (order.targetWeight !== undefined) {
          const target =
            frozenTargetQuantity ??
            floorStep(
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
            return { reason: null };
          }
        }
      }
      if (
        order.plannedQuantity !== undefined &&
        order.parentOrderId !== undefined
      )
        quantity = Math.min(quantity, order.plannedQuantity);
      if (
        order.side === "sell" &&
        market === "cn-equity" &&
        quantity < (holding?.quantity ?? 0)
      ) {
        quantity = floorStep(quantity, rules.step);
        if (instrumentRule && quantity < rules.minimum) quantity = 0;
      }
      if (quantity <= 0) {
        return { reason: "无可成交数量" };
      }
      const capacityAmount =
        !planning &&
        !order.sliceEnd &&
        request.maxParticipation !== undefined &&
        bar &&
        bar.amount > 0
          ? Math.max(0, bar.amount * request.maxParticipation - usedCap)
          : Infinity;
      let capacityClipped =
        Number.isFinite(capacityAmount) && quantity * price > capacityAmount;
      if (capacityClipped) {
        const reason = "超过参与率上限（容量情景）";
        if (request.capacityPolicy !== "clip") {
          return { reason };
        }
        quantity = floorStep(capacityAmount / price, rules.step);
        if (
          quantity < rules.minimum ||
          (order.side === "sell" && quantity < 1)
        ) {
          return { reason };
        }
      }

      const windowCapacity =
        available === undefined
          ? Infinity
          : Math.floor(
              available *
                (order.sliceEnd ? (request.maxParticipation ?? 1) : 1),
            );
      if (quantity > windowCapacity - usedShares) {
        if (
          order.sliceEnd &&
          request.maxParticipation !== undefined &&
          request.capacityPolicy !== "clip"
        )
          return { reason: "超过分笔窗口参与率上限" };
        quantity = floorStep(
          Math.max(0, windowCapacity - usedShares),
          rules.step,
        );
        if (quantity < rules.minimum)
          return { reason: "窗口剩余成交量不足最小申报数量" };
        capacityClipped = true;
      }
      return {
        price,
        dateCosts,
        stop,
        quantity,
        capacityAmount,
        capacityClipped,
        riskEntry,
      };
    };
    const initial = planAtPrice(result.price);
    if (planning && !("reason" in initial)) {
      const equity = [...accounts.values()].reduce(
        (sum, ledger) => sum + ledger.equity,
        0,
      );
      // Fix a single risk budget for the entire parent, across all impacted prices.
      const fraction =
        request.riskPolicy?.riskPerTrade ??
        defaultPortfolioRiskPolicy.riskPerTrade;
      const scale = state.riskAudit?.daily.at(-1)?.scale ?? 1;
      parentExecutions.set(order.id, {
        quantity: 0,
        riskUsed: 0,
        riskBudget: equity * fraction * scale,
      });
      if (
        initial.riskEntry &&
        state.riskAudit &&
        initial.riskEntry.decision.quantity <
          initial.riskEntry.requestedQuantity
      ) {
        state.riskAudit.entries.push(initial.riskEntry);
        state.riskAudit.reduced++;
      }
      return {
        quantity: initial.quantity,
        minimum: rules.minimum,
        step: rules.step,
        allOut: order.side === "sell" && initial.quantity === holding?.quantity,
      };
    }
    let plan = initial;
    if (window && !("reason" in initial)) {
      plan = solveImpactedOrder(
        initial,
        rules.minimum,
        rules.step,
        (quantity) => {
          const quote = observedWindowPrice(
            window,
            window.priceForQuantity(quantity),
            rules.execution,
            order.side,
            !!bar,
            instrumentRule?.priceTick,
          );
          return quote.price === null
            ? { reason: quote.reason }
            : planAtPrice(quote.price);
        },
      );
    }
    if ("reason" in plan) {
      if (plan.riskEntry && state.riskAudit) {
        plan.riskEntry.executedQuantity = 0;
        plan.riskEntry.executedStopRiskAfter =
          plan.riskEntry.decision.existingStopRisk;
        state.riskAudit.entries.push(plan.riskEntry);
        state.riskAudit.blocked++;
      }
      if (plan.reason === null) {
        order.status = "filled";
        removePending(order);
      } else reject(order, date, plan.reason);
      return;
    }
    const {
      price,
      dateCosts,
      stop,
      quantity,
      capacityAmount,
      capacityClipped,
      riskEntry,
    } = plan;
    const ceiling = window?.buyPriceCeiling;
    if (order.side === "buy" && ceiling) {
      if (
        !Number.isFinite(ceiling.price) ||
        ceiling.price <= 0 ||
        !ceiling.reason
      )
        throw new Error("Invalid execution window buy ceiling");
      if (price > ceiling.price + 1e-10) {
        ceiling.onRejected?.(price, quantity);
        reject(order, date, ceiling.reason);
        return;
      }
    }
    if (capacityClipped) order.capacityClipped = true;
    if (order.side === "buy") {
      if (riskEntry && state.riskAudit) {
        riskEntry.executedQuantity = quantity;
        riskEntry.executedStopRiskAfter =
          riskEntry.decision.existingStopRisk === null || stop === null
            ? null
            : riskEntry.decision.existingStopRisk +
              quantity * Math.max(0, price - stop);
        state.riskAudit.entries.push(riskEntry);
        if (riskEntry.decision.quantity < riskEntry.requestedQuantity)
          state.riskAudit.reduced++;
      }
      controls.set(
        key,
        control
          ? {
              ...control,
              tranches: control.tranches + (parent?.quantity ? 0 : 1),
            }
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
      settlementDays,
    );
    const remaining = account.positions.get(key)?.quantity ?? 0;
    if (Number.isFinite(capacityAmount))
      state.dailyCapacityUsed.set(capKey, usedCap + quantity * price);
    if (available !== undefined)
      windowUsage.set(windowKey, usedShares + quantity);
    if (parent) {
      parent.quantity += quantity;
      if (stop !== null)
        parent.riskUsed += quantity * Math.max(0, price - stop);
      order.executedQuantity = quantity;
    }
    const targetRemaining =
      order.targetWeight === undefined
        ? 0
        : (frozenTargetQuantity ??
          floorStep(
            ((openingEquities.get(order.sleeve) ?? account.equity) *
              order.targetWeight) /
              price,
            rules.step,
          ));
    const targetPending =
      !(
        riskEntry && riskEntry.decision.quantity < riskEntry.requestedQuantity
      ) &&
      (order.targetRemainingQuantity !== undefined
        ? !reachedQuantityTarget(remaining)
        : order.targetWeight !== undefined
          ? Math.abs(remaining - targetRemaining) > 1e-8
          : order.side === "sell" && remaining > 1e-8);
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
      ...(order.sliceEnd && {
        sliceEnd: order.sliceEnd,
        parentOrderId: order.parentOrderId,
      }),
      ...(window && {
        windowPhase:
          reference === undefined
            ? ("opening" as const)
            : ("protection" as const),
      }),
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
      ...(lifecycleExecutionEvidence && !window
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
  const executeSlices = (
    orders: readonly PortfolioOrder[],
    date: string,
    windows: readonly string[],
  ) => {
    plannedSales.clear();
    const batches = windows.map(() => [] as PortfolioOrder[]);
    const parents = new Map<number, PortfolioOrder>();
    for (const order of orders) {
      const plan = execute(order, date, undefined, undefined, true);
      removePending(order);
      if (!plan) {
        if (order.status === "pending") order.status = "rejected";
        continue;
      }
      parents.set(order.id, order);
      if (order.side === "sell")
        plannedSales.set(keyFor(order.strategyId, order.symbol), plan.quantity);
      order.plannedQuantity = plan.quantity;
      order.executedQuantity = 0;
      const counts = splitWindowQuantity(
        plan.quantity,
        plan.minimum,
        plan.step,
        windows.length,
        plan.allOut,
      );
      counts.forEach((plannedQuantity, i) => {
        const child: PortfolioOrder = {
          ...order,
          id: state.orders.length + 1,
          parentOrderId: order.id,
          sliceEnd: windows[i]!,
          plannedQuantity,
          executedQuantity: 0,
          attempts: 0,
          status: "pending",
          reason: null,
        };
        state.orders.push(child);
        batches[i]!.push(child);
      });
    }
    // Each batch retains the parent ordering (exits first, then entry priority).
    for (const batch of batches) {
      for (const child of batch) {
        execute(child, date);
        const actual = child.executedQuantity ?? 0;
        const parent = parents.get(child.parentOrderId!)!;
        parent.executedQuantity! += actual;
        if (actual < child.plannedQuantity!) {
          if (!child.reason)
            reject(child, date, "分笔委托窗口结束，剩余数量未成交");
          child.status = "rejected";
          parent.reason ??= child.reason;
        } else {
          child.status = "filled";
        }
      }
    }
    for (const parent of parents.values()) {
      parent.status =
        parent.executedQuantity === parent.plannedQuantity
          ? "filled"
          : "rejected";
      parentExecutions.delete(parent.id);
    }
    plannedSales.clear();
  };
  return Object.assign(execute, { executeSlices });
}
export type OrderExecutor = ReturnType<typeof createOrderExecutor>;

function splitWindowQuantity(
  total: number,
  minimum: number,
  step: number,
  windows: number,
  allOut: boolean,
) {
  const regular = floorStep(total, step);
  const odd = total - regular;
  const count = Math.min(windows, Math.floor(regular / minimum));
  if (!count) return allOut && total > 0 ? [total] : [];
  const steps = Math.floor(regular / step);
  const base = Math.floor(steps / count);
  const extra = steps % count;
  return Array.from(
    { length: count },
    (_, i) =>
      (base + (i < extra ? 1 : 0)) * step +
      (allOut && i === count - 1 ? odd : 0),
  );
}

/** A larger order incurs at least as much adverse impact. At each candidate
 * price the normal sizing path recomputes affordable quantity, fees and caps.
 * Probe without posting to the ledger, then book exactly the selected pair. */
function solveImpactedOrder(
  initial: OrderPlan,
  minimum: number,
  step: number,
  planAtQuantity: (quantity: number) => OrderPlan | OrderFailure,
): OrderPlan | OrderFailure {
  const trial = (quantity: number) => {
    const plan = planAtQuantity(quantity);
    return "reason" in plan || plan.quantity < quantity
      ? null
      : { ...plan, quantity };
  };
  // Also preserves an all-out odd-lot sale when the entire lot can fill.
  const full = trial(initial.quantity);
  if (full) return full;
  let lower = 0;
  let upper = Math.ceil(initial.quantity / step) - 1;
  let best: OrderPlan | null = null;
  while (lower < upper) {
    const middle = lower + Math.ceil((upper - lower) / 2);
    const candidate = trial(middle * step);
    if (candidate) {
      lower = middle;
      best = candidate;
    } else {
      upper = middle - 1;
    }
  }
  if (best && best.quantity >= minimum) return best;
  const smallest = planAtQuantity(minimum);
  return "reason" in smallest
    ? smallest
    : { reason: "窗口冲击成交价下不足最小申报数量" };
}
