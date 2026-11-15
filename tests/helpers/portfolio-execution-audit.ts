import type {
  PortfolioRequest,
  PortfolioExecution,
  runPortfolio,
} from "quant-backtest";
import { marketRules } from "trading-strategy-core/market-rules";
import Big from "big.js";

/** Independent arithmetic audit: no account, quote, protection or factor
 * implementation is imported. Retain the operands so every sample is reviewable. */
export function auditPortfolio(
  request: PortfolioRequest,
  result: ReturnType<typeof runPortfolio>,
  atrRule?: { period: number; multiple: number },
) {
  const costs = request.costs ?? marketRules[request.market].costs;
  if (!costs) throw new Error("Audit requires explicit market costs");
  const positions = new Map<
    string,
    {
      quantity: number;
      cost: number;
      mark: number;
      stop: number | null;
      high: number;
      lots: { date: string; quantity: number }[];
    }
  >();
  const instruments = new Map(request.instruments.map((i) => [i.symbol, i]));
  const bars = new Map(
    request.instruments.map((i) => [
      i.symbol,
      new Map(i.bars.map((b, index) => [b.date, { b, index }])),
    ]),
  );
  const orders = new Map(result.orders.map((o) => [o.id, o]));
  let cash = request.initial;
  const differences: {
    orderId: number;
    field: string;
    expected: number;
    actual: number;
  }[] = [];
  const samples: Record<string, unknown>[] = [];
  const near = (
    id: number,
    field: string,
    actual: number,
    expected: number,
  ) => {
    if (
      Math.abs(actual - expected) > Math.max(1e-7, Math.abs(expected) * 1e-10)
    )
      differences.push({ orderId: id, field, actual, expected });
  };
  const fee = (q: number, p: number, side: string) =>
    Math.max(costs.minimumCommission, (q * p * costs.commissionBps) / 10000) +
    (side === "sell" ? (q * p * costs.sellTaxBps) / 10000 : 0);
  const apply = (fill: (typeof result.fills)[number]) => {
    const source = instruments.get(fill.symbol)!,
      { b: bar, index } = bars.get(fill.symbol)!.get(fill.date)!;
    const order = orders.get(fill.orderId)!;
    const strategy = request.strategies.find((s) => s.id === fill.strategyId)!;
    const key = JSON.stringify([fill.strategyId, fill.symbol]);
    const held = positions.get(key);
    const execution: PortfolioExecution | undefined =
      "evidence" in source.execution
        ? (source.execution as PortfolioExecution)
        : source.execution[fill.date];
    let reference = bar.open;
    if (fill.side === "sell" && order.signalAt === fill.date) {
      const trail = strategy.exit.trailing
        ? held!.high * (1 - strategy.exit.trailing)
        : 0;
      const stop = Math.max(held!.stop ?? 0, trail);
      if (order.trigger === "target")
        reference = Math.max(
          bar.open,
          held!.cost * (1 + strategy.exit.takeProfit!),
        );
      else {
        reference = Math.min(bar.open, stop);
        if (bar.low > stop)
          differences.push({
            orderId: order.id,
            field: "stop-not-touched",
            actual: bar.low,
            expected: stop,
          });
      }
    }
    const price =
      reference *
      (1 + ((fill.side === "buy" ? 1 : -1) * costs.slippageBps) / 10000);
    near(order.id, "price", fill.price, price);
    near(order.id, "fee", fill.fee, fee(fill.quantity, price, fill.side));
    if (price < bar.low - 1e-8 || price > bar.high + 1e-8)
      differences.push({
        orderId: order.id,
        field: "outside-OHLC",
        actual: price,
        expected: bar.low,
      });
    if (
      !execution ||
      !execution.tradable ||
      (fill.side === "buy" &&
        execution.limitUp !== null &&
        reference >= execution.limitUp - 1e-7) ||
      (fill.side === "sell" &&
        execution.limitDown !== null &&
        reference <= execution.limitDown + 1e-7)
    )
      differences.push({
        orderId: order.id,
        field: "untradable",
        actual: 1,
        expected: 0,
      });
    const before = cash;
    let stop = held?.stop ?? null,
      expectedQuantity = fill.quantity,
      atr: number | null = null;
    if (fill.side === "buy") {
      const signalIndex = bars.get(fill.symbol)!.get(fill.signalAt)!.index;
      const raw = source.bars[signalIndex]!,
        signal = source.signalBars[signalIndex]!;
      const originalStop = strategy.exit.stop;
      if (!held) {
        if (originalStop?.kind === "fixed")
          stop = price * (1 - originalStop.fraction);
        else if (originalStop?.kind === "structure") {
          const level = source.external?.levels?.find(
            (l) => l.date === fill.signalAt && l.field === originalStop.field,
          );
          stop = level ? level.value * (raw.close / signal.close) : null;
          // All R2a ATR projections use the declared simple 14-TR mean.
          const parts = source.signalBars
            .slice(signalIndex - 13, signalIndex + 1)
            .map((b, j) => {
              const prev = source.signalBars[signalIndex - 14 + j]!.close;
              return Math.max(
                b.high - b.low,
                Math.abs(b.high - prev),
                Math.abs(b.low - prev),
              );
            });
          atr = parts.reduce((a, b) => a + b, 0) / 14;
          if (atrRule && level)
            near(
              order.id,
              "independent-ATR-stop",
              level.value,
              signal.close - atr * atrRule.multiple,
            );
        }
        // A percentage stop is defined from the actual (already ex-dividend)
        // entry price. Only signal-basis structural levels need this adjustment.
        if (originalStop?.kind !== "fixed")
          for (const action of source.actions?.filter(
            (a) => a.date > fill.signalAt && a.date <= fill.date,
          ) ?? [])
            if (stop !== null)
              stop = (stop - action.dividend) / (1 + action.bonus);
      }
      const capital = Number(
        [...positions.values()]
          .reduce(
            (sum, p) => sum.plus(new Big(p.quantity).times(p.mark)),
            new Big(cash),
          )
          .toString(),
      );
      const weight =
        strategy.sizing.kind === "equal"
          ? 1 / strategy.sizing.positions
          : strategy.sizing.kind === "weight"
            ? strategy.sizing.weight
            : 1;
      const budget = Math.min(
        cash,
        (capital * weight) / (strategy.sizing.tranches ?? 1),
      );
      const step =
        execution?.step ?? marketRules[request.market].quantity.step!;
      const floor = (n: number | Big) =>
        Number(
          new Big(n).div(step).round(0, Big.roundDown).times(step).toString(),
        );
      const affordable = [
        new Big(budget).minus(costs.minimumCommission).div(price),
        new Big(budget).div(
          new Big(price).times(
            new Big(1).plus(new Big(costs.commissionBps).div(10000)),
          ),
        ),
        new Big(execution?.maximum ?? 1e12),
      ].reduce((a, b) => (a.lt(b) ? a : b));
      expectedQuantity = floor(affordable);
      if (stop !== null) {
        const sleeve = request.sleeves.find((s) => s.id === fill.sleeve)!;
        const oldRisk = held
          ? held.quantity * Math.max(0, held.cost - stop) +
            fee(held.quantity, stop, "sell")
          : 0;
        const fraction = Math.min(
          sleeve.riskPerTrade,
          strategy.sizing.kind === "risk"
            ? strategy.sizing.fraction
            : sleeve.riskPerTrade,
        );
        expectedQuantity = Math.min(
          expectedQuantity,
          floor(
            Math.max(
              0,
              capital * fraction - oldRisk - costs.minimumCommission * 2,
            ) /
              (price -
                stop +
                (price * costs.commissionBps) / 10000 +
                (stop * (costs.commissionBps + costs.sellTaxBps)) / 10000),
          ),
        );
      }
      near(order.id, "quantity", fill.quantity, expectedQuantity);
      const amount = Number(new Big(fill.quantity).times(price).toString());
      cash = Number(
        new Big(cash).minus(new Big(amount).plus(fill.fee)).toString(),
      );
      const q = (held?.quantity ?? 0) + fill.quantity;
      positions.set(key, {
        quantity: q,
        cost:
          ((held?.cost ?? 0) * (held?.quantity ?? 0) +
            fill.quantity * price +
            fill.fee) /
          q,
        mark: price,
        stop,
        high: held?.high ?? price,
        lots: [
          ...(held?.lots ?? []),
          { date: fill.date.slice(0, 10), quantity: fill.quantity },
        ],
      });
    } else {
      const sellable = held!.lots
        .filter(
          (l) => request.market === "crypto" || l.date < fill.date.slice(0, 10),
        )
        .reduce((n, l) => n + l.quantity, 0);
      if (fill.quantity > sellable + 1e-7)
        differences.push({
          orderId: order.id,
          field: "T+1",
          actual: fill.quantity,
          expected: sellable,
        });
      const amount = Number(new Big(fill.quantity).times(price).toString());
      cash = Number(
        new Big(cash).plus(new Big(amount).minus(fill.fee)).toString(),
      );
      let left = fill.quantity;
      for (const lot of held!.lots) {
        if (request.market !== "crypto" && lot.date >= fill.date.slice(0, 10))
          continue;
        const q = Math.min(left, lot.quantity);
        lot.quantity -= q;
        left -= q;
      }
      held!.quantity -= fill.quantity;
      held!.mark = price;
      if (held!.quantity < 1e-9) positions.delete(key);
    }
    near(order.id, "cash", fill.cashAfter, cash);
    if (
      samples.filter((s) => s.side === fill.side).length < 10 ||
      (fill.side === "buy" &&
        fill.holdingAfter > fill.quantity &&
        samples.filter((s) => s.additionalTranche === true).length < 5)
    )
      samples.push({
        orderId: order.id,
        symbol: fill.symbol,
        side: fill.side,
        additionalTranche:
          fill.side === "buy" && fill.holdingAfter > fill.quantity,
        signalAt: fill.signalAt,
        date: fill.date,
        trigger: order.trigger,
        rawOpen: bar.open,
        rawLow: bar.low,
        rawHigh: bar.high,
        reference,
        slippageBps: costs.slippageBps,
        price,
        actualPrice: fill.price,
        quantity: fill.quantity,
        expectedQuantity,
        fee: fill.fee,
        expectedFee: fee(fill.quantity, price, fill.side),
        cashBefore: before,
        cashAfter: fill.cashAfter,
        expectedCash: cash,
        stop,
        atr,
        adjustmentRatio:
          source.bars[index]!.close / source.signalBars[index]!.close,
      });
  };
  const fillsByDate = new Map<string, typeof result.fills>();
  for (const f of result.fills) {
    const a = fillsByDate.get(f.date) ?? [];
    a.push(f);
    fillsByDate.set(f.date, a);
  }
  for (const date of request.calendar.filter(
    (d) => d.slice(0, 10) >= request.start && d.slice(0, 10) <= request.end,
  )) {
    for (const [key, p] of positions) {
      const symbol = JSON.parse(key)[1] as string;
      const source = instruments.get(symbol)!;
      for (const a of source.actions?.filter((a) => a.date === date) ?? []) {
        cash = Number(new Big(cash).plus(p.quantity * a.dividend).toString());
        p.cost = (p.cost - a.dividend) / (1 + a.bonus);
        p.mark = (p.mark - a.dividend) / (1 + a.bonus);
        p.high = (p.high - a.dividend) / (1 + a.bonus);
        if (p.stop !== null) p.stop = (p.stop - a.dividend) / (1 + a.bonus);
        if (a.bonus)
          throw new Error(
            "Audit requires the declared cash-dividend-only execution pool",
          );
      }
      const row = bars.get(symbol)!.get(date);
      if (row) p.mark = row.b.open;
    }
    const fills = fillsByDate.get(date) ?? [];
    for (const f of fills.filter((f) => f.signalAt !== date)) apply(f);
    for (const strategy of request.strategies)
      for (const source of request.instruments) {
        const key = JSON.stringify([strategy.id, source.symbol]);
        for (const f of fills.filter(
          (f) =>
            f.signalAt === date &&
            f.symbol === source.symbol &&
            f.strategyId === strategy.id,
        ))
          apply(f);
        const held = positions.get(key),
          row = bars.get(source.symbol)!.get(date);
        if (held && row) {
          held.mark = row.b.close;
          held.high = Math.max(held.high, row.b.high);
        }
        if (held && row && source.terminal?.date === date) {
          cash +=
            held.quantity *
            (source.terminal.valuation === "last-close" ? row.b.close : 0);
          positions.delete(key);
        }
      }
  }
  return {
    fills: result.fills.length,
    buys: result.fills.filter((f) => f.side === "buy").length,
    sells: result.fills.filter((f) => f.side === "sell").length,
    samples,
    differences,
    rejections: Object.fromEntries(
      [...new Set(result.rejections.map((r) => r.reason))].map((reason) => [
        reason,
        result.rejections.filter((r) => r.reason === reason).length,
      ]),
    ),
    note: "Cash, quantities, price and fees recomputed independently from raw bars and fixed rules. Samples are first ten buys and first ten sells, selected without PnL.",
  };
}
