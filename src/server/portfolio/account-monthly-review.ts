import { reviewTrades } from "~/lib/portfolio/trade-review";
import { reviewAttribution } from "~/lib/portfolio/trade-review-attribution";
import { disciplineCounterfactual } from "~/lib/research/risk/discipline-counterfactual";
import { defaultBacktestCosts } from "~/lib/backtest/backtest-costs";
import type { AccountBook } from "./account-workspace-service";
import type { ParsedFill } from "~/lib/research/evidence/delivery-import";

export function monthlyAccountReview(book: AccountBook, month: string) {
  const result: {
    account: string;
    kind: string;
    count: number;
    actual: number | null;
    counterfactual: number | null;
    impact: number | null;
    reason: string | null;
    basis: string;
  }[] = [];
  const attribution = [];
  const unavailable: { account: string; security: string; reason: string }[] =
    [];
  const ledgers = [...new Set(book.facts.fills.map((f) => f.account))].map(
    (account) => ({
      account,
      source: "delivery",
      fills: book.facts.fills.filter(
        (f) => f.account === account,
      ) as (ParsedFill & { id: string })[],
      cashFlows: book.facts.cashFlows.filter((f) => f.account === account),
    }),
  );
  if (book.facts.local.length)
    ledgers.push({
      account: "手工账本",
      source: "local",
      cashFlows: [],
      fills: book.facts.local.map((t, index) => ({
        id: t.id,
        kind: t.side,
        rowIndex: index,
        tradeDate: t.date,
        tradeTime: null,
        code: t.symbol.slice(2),
        symbol: t.symbol,
        instrument: "stock",
        name: null,
        price: t.price,
        quantity: t.quantity,
        amount: t.price * t.quantity,
        netAmount:
          (t.side === "buy" ? -1 : 1) * t.price * t.quantity - t.fees.total,
        fees: {
          commission: t.fees.commission,
          stampTax: t.fees.tax,
          transferFee: 0,
          otherFee: t.fees.slippage,
          total: t.fees.total,
        },
        balanceShares: null,
        balanceCash: null,
        orderId: null,
        dealId: null,
        businessFlag: null,
        summary: "手工记录；实验费用",
        fingerprintSource: t.id,
        anomalies: [],
      })),
    });
  for (const { account, source, fills, cashFlows } of ledgers) {
    const end = fills
      .map((f) => f.tradeDate)
      .sort()
      .at(-1);
    const actionCoverage = [
      ...new Set(fills.map((f) => f.symbol ?? f.code)),
    ].every((symbol) => {
      const through = book.context.evidence(symbol).coverageEnd;
      return through !== null && end !== undefined && through >= end;
    });
    const events = [...new Set(fills.map((f) => f.symbol ?? f.code))].flatMap(
      (symbol) =>
        book.context
          .evidence(symbol)
          .events.map((e) => ({ ...e, security: symbol })),
    );
    const review = reviewTrades({
      fills,
      cashFlows,
      bars: book.bars,
      tradingDays: book.calendar,
      exRightsEvents: actionCoverage ? events : undefined,
    });
    const rounds = [
      ...review.movingAverage.closedRounds,
      ...review.movingAverage.openPositions,
    ];
    attribution.push({
      account,
      ...reviewAttribution(
        review.movingAverage.closedRounds.filter((r) =>
          r.closingDate?.startsWith(month),
        ),
      ),
    });
    const stops: Record<string, number> = {},
      impacted = {
        stop: new Set<number>(),
        oversize: new Set<number>(),
        chase: new Set<number>(),
      };
    const scenarios = { oversize: [...fills], chase: [...fills] };
    for (const [index, round] of rounds.entries()) {
      if (round.instrument === "convertible") {
        unavailable.push({
          account,
          security: round.security,
          reason: "可转债数量/价格单位须在原复盘核对，不据此判断计划偏离",
        });
        continue;
      }
      const entries = round.fillIndices
        .map((i) => ({ fill: fills[i]!, index: i }))
        .filter((x) => x.fill.kind === "buy");
      const links = entries.map((x) =>
        book.trades.find((t) => t.id === `${source}:${x.fill.id}`),
      );
      const plans = links.map((t) =>
        book.facts.plans.find((p) => p.id === t?.planId),
      );
      const plan = plans[0];
      if (
        !plan ||
        plans.some((p) => p?.id !== plan.id) ||
        plan.createdAt === undefined
      )
        continue;
      if (plan.stop !== null && round.openingDate) {
        const breach = (book.bars[round.security] ?? []).find(
          (b) =>
            b.date > round.openingDate! &&
            (!round.closingDate || b.date < round.closingDate) &&
            b.close <= plan.stop!,
        );
        if (breach?.date.startsWith(month)) {
          impacted.stop.add(index);
          stops[JSON.stringify([round.security, round.openingDate])] =
            plan.stop;
        }
      }
      const allowed = plan.quantity;
      let held = 0,
        peak = 0,
        firstOversizeDate: string | null = null;
      for (const i of round.fillIndices) {
        const fill = fills[i]!;
        held += fill.kind === "buy" ? fill.quantity : -fill.quantity;
        peak = Math.max(peak, held);
        if (allowed !== null && held > allowed && firstOversizeDate === null)
          firstOversizeDate = fill.tradeDate;
      }
      const over = firstOversizeDate?.startsWith(month) === true;
      if (over) impacted.oversize.add(index);
      const ratio = over ? allowed! / peak : 1;
      for (const i of round.fillIndices) {
        const fill = fills[i]!;
        if (over)
          scenarios.oversize[i] = {
            ...fill,
            quantity: fill.quantity * ratio,
            amount: fill.amount * ratio,
            netAmount: fill.netAmount === null ? null : fill.netAmount * ratio,
            balanceCash: null,
            balanceShares: null,
            fees: Object.fromEntries(
              Object.entries(fill.fees).map(([k, v]) => [
                k,
                v === null ? null : v * ratio,
              ]),
            ) as typeof fill.fees,
          };
        if (
          fill.kind === "buy" &&
          fill.tradeDate.startsWith(month) &&
          fill.price >
            plan.entry * (1 + book.config.accountReview.chaseFraction)
        ) {
          impacted.chase.add(index);
          const improvement = (fill.price - plan.entry) * fill.quantity;
          scenarios.chase[i] = {
            ...fill,
            price: plan.entry,
            amount: fill.amount - improvement,
            netAmount:
              fill.netAmount === null ? null : fill.netAmount + improvement,
            balanceCash: null,
          };
        }
      }
    }
    const total = (values: readonly (number | null)[]) =>
      values.length && values.every((v) => v !== null)
        ? values.reduce<number>((n, v) => n + v!, 0)
        : null;
    for (const kind of ["stop", "oversize", "chase"] as const) {
      const indices = [...impacted[kind]],
        original = indices.map((i) => rounds[i]!);
      const actual = original.every(
        (r) => !r.openingUnknown && r.crossesExRights === false,
      )
        ? total(original.map((r) => r.netProfit.value))
        : null;
      let counterfactual: number | null = null,
        reason: string | null = null;
      const basis =
        kind === "stop"
          ? "已冻结计划止损；收盘触发，下一可得开盘；沿用纪律反事实引擎的资金、费用和证据限制"
          : "固定原回合的金额对照；超仓同比缩量/费用，追高替换为计划价；不认证当时可成交或组合重投资";
      if (!indices.length) {
        result.push({
          account,
          kind,
          count: 0,
          actual: null,
          counterfactual: null,
          impact: null,
          reason: "本月无可证实违纪；无计划/开仓未知不计为守纪",
          basis,
        });
        continue;
      }
      if (actual === null || original.some((r) => r.closingDate === null))
        reason = "含未平仓、除权/开仓证据不足或盈亏未知回合，金额影响暂不可得";
      else if (kind === "stop") {
        try {
          if (source === "local")
            throw new Error(
              "手工账本缺期初现金与完整出入金，止损资金重放不可用；不补造本金",
            );
          const coverage = [
            ...new Set(fills.map((f) => f.symbol ?? f.code)),
          ].map((s) => book.context.evidence(s).coverageEnd);
          const cf = disciplineCounterfactual(
            {
              fills,
              cashFlows,
              bars: book.bars,
              tradingDays: book.calendar,
              exRightsEvents: events,
              coverageEnd: coverage.every((v) => v !== null)
                ? coverage.sort()[0]!
                : null,
              stopCosts: defaultBacktestCosts,
              plannedStops: stops,
            },
            { maxAddOns: null, stopLossPct: null },
          );
          counterfactual = total(
            indices.map(
              (i) =>
                cf.comparison.find((c) => c.roundIndex === i)?.netProfit ??
                null,
            ),
          );
        } catch (e) {
          reason = e instanceof Error ? e.message : "纪律重放不可用";
        }
      } else {
        const cf = reviewTrades({
          fills: scenarios[kind],
          cashFlows,
          bars: book.bars,
          tradingDays: book.calendar,
          exRightsEvents: events,
        });
        counterfactual = total(
          original.map(
            (r) =>
              cf.movingAverage.closedRounds.find(
                (c) =>
                  c.security === r.security &&
                  c.openingDate === r.openingDate &&
                  c.closingDate === r.closingDate,
              )?.netProfit.value ?? null,
          ),
        );
      }
      result.push({
        account,
        kind,
        count: indices.length,
        actual,
        counterfactual,
        impact:
          actual !== null && counterfactual !== null
            ? counterfactual - actual
            : null,
        reason,
        basis,
      });
    }
  }
  return {
    month,
    items: result,
    attribution,
    unavailable,
    unlinked: book.trades.filter(
      (t) => t.kind === "real" && t.date.startsWith(month) && !t.planId,
    ).length,
    notice:
      "止损/超仓按首次触发月、追高按入场月统计回合；金额为该完整回合的差额，三类可能重叠，不可相加。导入账本用实际费用，手工账本沿用已记录实验费用；缺现金或计划不补造。",
  };
}
