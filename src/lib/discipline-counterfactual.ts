import { z } from "zod";
import type { ParsedFill } from "./delivery-import";
import type { Bar } from "./domain";
import { backtestCostsSchema } from "./backtest-costs";
import { researchDateSchema } from "./research-usage";
import { researchTradeStatistics } from "./strategy-research";
import { reviewTrades, type TradeReviewInput } from "./trade-review";
import { reviewTradeNav, type TradeReviewNavInput } from "./trade-review-nav";

export const disciplineNotice = "参数在已知结果后选定，本对照不构成可交易结论";
export const disciplineScope =
  "本对照针对加仓次数与止损，不涉及开仓决策；首笔买入在盈亏回合间无显著差异。已证实的是亏损回合加仓更多，未证实加仓时点处于浮亏。";
export const disciplineRulesSchema = z.object({
  maxAddOns: z.number().int().min(0).max(2).nullable(),
  stopLossPct: z.number().finite().positive().lt(1).nullable(),
});
export type DisciplineRules = z.infer<typeof disciplineRulesSchema>;
export const disciplineGrid: DisciplineRules[] = [0, 1, 2, null].flatMap(
  (maxAddOns) =>
    [0.03, 0.05, 0.08, 0.1, null].map((stopLossPct) => ({
      maxAddOns,
      stopLossPct,
    })),
);
export type DisciplineInput = Omit<TradeReviewNavInput, "bars"> & {
  bars: Readonly<Record<string, readonly Bar[]>>;
  exRightsEvents: TradeReviewInput["exRightsEvents"];
  coverageEnd: string | null;
  /** Fixed experimental fees for NEW stop sales only. No future fill fee is read. */
  stopCosts: Pick<
    z.infer<typeof backtestCostsSchema>,
    "commissionBps" | "minimumCommission" | "sellTaxBps"
  >;
};
const stopCostsSchema = backtestCostsSchema.pick({
  commissionBps: true,
  minimumCommission: true,
  sellTaxBps: true,
});
const delta = (f: ParsedFill) => {
  if (f.netAmount !== null && Number.isFinite(f.netAmount)) return f.netAmount;
  if (f.fees.total === null || !Number.isFinite(f.fees.total))
    throw new Error("资金发生额与费用均不可得");
  const out =
    f.instrument === "reverseRepo" ? f.kind === "sell" : f.kind === "buy";
  return (out ? -f.amount : f.amount) - f.fees.total;
};
function prepare(input: DisciplineInput) {
  const lastFill = input.fills
    .map((f) => f.tradeDate)
    .sort()
    .at(-1);
  if (!lastFill) throw new Error("无成交，整批不可用");
  if (
    !researchDateSchema.safeParse(input.coverageEnd).success ||
    input.coverageEnd! < lastFill
  )
    throw new Error(
      `GBBQ 覆盖截止日 ${input.coverageEnd ?? "未知"} 早于末笔成交日 ${lastFill} 或无效，整批不可用`,
    );
  if (!input.exRightsEvents) throw new Error("GBBQ 事件证据缺失，整批不可用");
  for (const e of input.exRightsEvents) researchDateSchema.parse(e.date);
  stopCostsSchema.parse(input.stopCosts);
  const review = reviewTrades(input).movingAverage;
  const valid = review.closedRounds.filter((r) => r.netProfit.value !== null);
  const eligible = valid.filter((r) => r.crossesExRights === false);
  const summary = (rounds: typeof valid) => ({
    count: rounds.length,
    netProfit: rounds.reduce((s, r) => s + r.netProfit.value!, 0),
  });
  const actualNav = reviewTradeNav(input);
  return {
    review,
    valid,
    eligible,
    actualNav,
    baselineA: summary(valid),
    baselineB: summary(eligible),
    excludedCrossed: valid.filter((r) => r.crossesExRights === true).length,
    excludedUnknown: valid.filter((r) => r.crossesExRights === null).length,
  };
}
type Prepared = ReturnType<typeof prepare>;
type Execution = {
  originalIndex: number | null;
  roundIndex: number | null;
  fill: ParsedFill;
  triggerDate: string | null;
};

function replay(input: DisciplineInput, rules: DisciplineRules, p: Prepared) {
  const unchanged = rules.maxAddOns === null && rules.stopLossPct === null;
  const rounds = [...p.review.closedRounds, ...p.review.openPositions];
  const states = rounds.map((round, index) => ({
    round,
    index,
    eligible: p.eligible.includes(round),
    original: 0,
    held: 0,
    cost: 0,
    buys: 0,
    skipped: false,
    stopped: false,
    pending: null as string | null,
    netProfit: 0,
    spent: 0,
    executions: [] as Execution[],
  }));
  const byFill = new Map(
    states.flatMap((s) => s.round.fillIndices.map((i) => [i, s] as const)),
  );
  const execution: Execution[] = [];
  const cashFlows = input.cashFlows.map((f) => ({ ...f }));
  let cash = p.actualNav.openingCash;
  let eventOrder = 0;
  const diagnostics: string[] = [];
  const bars = new Map(
    Object.entries(input.bars).map(([security, bs]) => {
      const map = new Map<string, Bar>();
      for (const b of bs) {
        if (map.has(b.date)) throw new Error(`${security} ${b.date} 日线重复`);
        map.set(b.date, b);
      }
      return [security, map] as const;
    }),
  );
  const emit = (
    fill: ParsedFill,
    originalIndex: number | null,
    s: (typeof states)[number] | undefined,
    triggerDate: string | null = null,
  ) => {
    const amount = delta(fill);
    cash += amount;
    const entry = {
      fill: unchanged
        ? fill
        : { ...fill, rowIndex: eventOrder++, balanceCash: cash },
      originalIndex,
      roundIndex: s?.index ?? null,
      triggerDate,
    };
    execution.push(entry);
    s?.executions.push(entry);
    if (s?.eligible) {
      s.netProfit += amount;
      if (fill.kind === "buy") s.spent -= amount;
    }
    // Fixed repo/excluded legs cannot be silently resized or financed by invented cash.
    if (!unchanged && cash < -0.005)
      throw new Error(
        `${fill.tradeDate} ${fill.code} 原样保留成交后现金 ${cash.toFixed(2)} 为负，网格不可用`,
      );
  };
  const scaled = (f: ParsedFill, q: number) => {
    const ratio = q / f.quantity;
    return {
      ...f,
      quantity: q,
      amount: f.amount * ratio,
      netAmount: delta(f) * ratio,
      fees: Object.fromEntries(
        Object.entries(f.fees).map(([k, v]) => [
          k,
          v === null ? null : v * ratio,
        ]),
      ) as ParsedFill["fees"],
      balanceCash: null,
      balanceShares: null,
    };
  };
  const byDate = new Map<string, typeof p.actualNav.replay>();
  for (const e of p.actualNav.replay) {
    const es = byDate.get(e.date) ?? [];
    es.push(e);
    byDate.set(e.date, es);
  }
  for (const date of [...new Set(input.tradingDays)].sort()) {
    // Open precedes every original intraday event; no close of this day is read here.
    for (const s of states)
      if (s.pending && !s.stopped && s.held > 0) {
        const b = bars.get(s.round.security)?.get(date);
        if (!b || !Number.isFinite(b.open) || b.open <= 0 || b.volume <= 0)
          continue;
        const first = input.fills[s.round.fillIndices[0]!]!;
        const amount = b.open * s.held;
        const commission = Math.max(
          input.stopCosts.minimumCommission,
          (amount * input.stopCosts.commissionBps) / 10000,
        );
        const tax =
          first.instrument === "stock"
            ? (amount * input.stopCosts.sellTaxBps) / 10000
            : 0;
        emit(
          {
            ...first,
            kind: "sell",
            tradeDate: date,
            tradeTime: "09:30:00",
            rowIndex: 0,
            price: b.open,
            quantity: s.held,
            amount,
            netAmount: amount - commission - tax,
            fees: {
              commission,
              stampTax: tax,
              transferFee: 0,
              otherFee: 0,
              total: commission + tax,
            },
            balanceCash: null,
            balanceShares: null,
            orderId: null,
            dealId: null,
            summary: "纪律反事实止损",
            fingerprintSource: "discipline-stop",
          },
          null,
          s,
          s.pending,
        );
        s.held = 0;
        s.cost = 0;
        s.stopped = true;
      }
    for (const e of byDate.get(date) ?? []) {
      const f = input.fills[e.originalOrder];
      if (!f) {
        const flow = cashFlows[e.originalOrder - input.fills.length]!;
        flow.rowIndex = eventOrder++;
        cash += flow.amount;
        if (!unchanged && cash < -0.005)
          throw new Error(`${date} 原样保留现金流后资金不足，网格不可用`);
        continue;
      }
      const s = byFill.get(e.originalOrder);
      if (unchanged || !s?.eligible) {
        emit({ ...f }, e.originalOrder, s);
        continue;
      }
      if (s.stopped || s.skipped) continue;
      if (f.kind === "buy") {
        s.original += f.quantity;
        const buyNumber = s.buys++;
        if (rules.maxAddOns !== null && buyNumber > rules.maxAddOns) continue;
        let quantity = f.quantity;
        const debit = -delta(f);
        if (!(debit > 0)) throw new Error(`${date} 买入资金发生额无效`);
        if (debit > cash + 0.005) {
          // Units follow statement quantities (Shanghai convertible: hands).
          const lot =
            f.instrument === "convertible"
              ? f.symbol?.startsWith("sh")
                ? 1
                : 10
              : 100;
          quantity = Math.min(
            quantity,
            Math.floor(Math.max(0, cash) / (debit / f.quantity) / lot) * lot,
          );
          diagnostics.push(
            `${date} ${f.code} 资金不足，买入 ${quantity}/${f.quantity}`,
          );
        }
        if (!quantity) {
          if (buyNumber === 0) s.skipped = true;
          continue;
        }
        s.held += quantity;
        s.cost += (debit * quantity) / f.quantity;
        emit(scaled(f, quantity), e.originalOrder, s);
      } else {
        // Proportional partial exits use remaining original shares, not total lifetime buys.
        const quantity =
          s.original > 0 ? s.held * Math.min(1, f.quantity / s.original) : 0;
        s.original = Math.max(0, s.original - f.quantity);
        if (!quantity) continue;
        s.cost *= 1 - quantity / s.held;
        s.held = Math.max(0, s.held - quantity);
        emit(scaled(f, quantity), e.originalOrder, s);
      }
    }
    if (!unchanged && rules.stopLossPct !== null)
      for (const s of states) {
        if (
          !s.eligible ||
          s.stopped ||
          s.skipped ||
          s.pending ||
          s.held <= 0 ||
          date <= s.round.openingDate!
        )
          continue;
        const b = bars.get(s.round.security)?.get(date);
        if (!b || !Number.isFinite(b.close) || b.close <= 0 || b.volume <= 0)
          continue;
        // Compare amounts: 9.5/10-1 falls slightly below -0.05 in binary.
        // Ignore only a few arithmetic ulps, not any meaningful price movement.
        const threshold = s.cost * (1 - rules.stopLossPct);
        if (
          threshold - s.held * b.close >
          Number.EPSILON * 8 * Math.max(1, Math.abs(threshold))
        )
          s.pending = date;
      }
  }
  // Original statement anchors must not erase changed cash/holdings. Preserve
  // their residuals separately: unknown reconciliation cannot become new money.
  if (!unchanged && input.fills.some((f) => f.balanceCash !== null)) {
    let projected = p.actualNav.openingCash;
    for (const e of p.actualNav.replay) {
      const f = input.fills[e.originalOrder];
      projected += f
        ? delta(f)
        : input.cashFlows[e.originalOrder - input.fills.length]!.amount;
      if (
        f?.balanceCash !== null &&
        f?.balanceCash !== undefined &&
        Math.abs(projected - f.balanceCash) > 0.005
      )
        throw new Error("柜台现金余额存在未解释残差，资金约束重放不可用");
    }
  }
  // Give synthetic opens and original flows a single explicit event order.
  const replayFills = execution.map((e) => e.fill);
  const finalNav = unchanged
    ? p.actualNav
    : reviewTradeNav({
        ...input,
        fills: replayFills,
        cashFlows,
        openingCash: p.actualNav.openingCash,
        flowValuations: undefined,
      });
  const comparison = states
    .filter((s) => s.eligible)
    .map((s) => ({
      roundIndex: s.index,
      security: s.round.security,
      openingDate: s.round.openingDate,
      actualNetProfit: s.round.netProfit.value!,
      netProfit: s.skipped ? null : s.netProfit,
      netReturn: s.skipped
        ? null
        : unchanged
          ? s.round.netReturn.value
          : s.spent > 0
            ? s.netProfit / s.spent
            : null,
      skipped: s.skipped,
      stopped: s.stopped,
      triggerDate: s.pending,
      executions: s.executions,
    }));
  const profits = comparison.flatMap((r) =>
    r.netProfit === null ? [] : [r.netProfit],
  );
  const returns = comparison.flatMap((r) =>
    r.netReturn === null ? [] : [r.netReturn],
  );
  const stats = researchTradeStatistics(returns);
  const wins = profits.filter((n) => n > 0).reduce((s, n) => s + n, 0),
    losses = -profits.filter((n) => n < 0).reduce((s, n) => s + n, 0);
  return {
    rules,
    netProfit: profits.reduce((s, n) => s + n, 0),
    roundCount: profits.length,
    winRate: profits.length
      ? profits.filter((n) => n > 0).length / profits.length
      : null,
    payoffRatio: stats.payoffRatio,
    profitFactor: losses > 0 ? wins / losses : null,
    maxDrawdown:
      finalNav.twr.value === null
        ? { value: null, reason: finalNav.twr.reason }
        : {
            value: Math.max(
              0,
              ...finalNav.segments.map((s) => s.maxDrawdown.value ?? 0),
            ),
            reason: null,
          },
    stoppedRounds: comparison.filter((r) => r.stopped).length,
    skippedRounds: comparison.filter((r) => r.skipped).length,
    excludedCrossed: p.excludedCrossed,
    excludedUnknown: p.excludedUnknown,
    comparison,
    execution,
    nav: finalNav,
    diagnostics,
  };
}

export function disciplineCounterfactual(
  input: DisciplineInput,
  rules: DisciplineRules,
) {
  return replay(input, disciplineRulesSchema.parse(rules), prepare(input));
}
export function runDisciplineGrid(input: DisciplineInput) {
  const p = prepare(input);
  const baseline = replay(input, { maxAddOns: null, stopLossPct: null }, p);
  // Reconstruct A from replayed cash legs, independently of cost accounting,
  // including the rounds that are excluded from B and the rule grid.
  const validFills = new Set(p.valid.flatMap((r) => r.fillIndices));
  const aProfit = baseline.execution.reduce(
    (sum, e) =>
      sum +
      (e.originalIndex !== null && validFills.has(e.originalIndex)
        ? delta(e.fill)
        : 0),
    0,
  );
  const aCount = reviewTrades({
    ...input,
    fills: baseline.execution.map((e) => e.fill),
  }).movingAverage.closedRounds.filter(
    (r) => r.netProfit.value !== null,
  ).length;
  const replayed = {
    a: { count: aCount, netProfit: aProfit },
    b: { count: baseline.roundCount, netProfit: baseline.netProfit },
  };
  const checks = {
    a: {
      ...p.baselineA,
      passed:
        aCount === p.baselineA.count &&
        Math.abs(aProfit - p.baselineA.netProfit) <= 1,
    },
    b: {
      ...p.baselineB,
      passed:
        Math.abs(baseline.netProfit - p.baselineB.netProfit) <= 1 &&
        baseline.roundCount === p.baselineB.count,
    },
  };
  if (!checks.a.passed || !checks.b.passed)
    throw new Error(
      `双自校验失败：${JSON.stringify({ replayed, review: { a: p.baselineA, b: p.baselineB }, checks })}，停止网格`,
    );
  const points = disciplineGrid.map((rules) =>
    rules.maxAddOns === null && rules.stopLossPct === null
      ? baseline
      : replay(input, rules, p),
  );
  return {
    version: "discipline-1" as const,
    notice: disciplineNotice,
    scope: disciplineScope,
    coverageEnd: input.coverageEnd,
    checks,
    excludedCrossed: p.excludedCrossed,
    excludedUnknown: p.excludedUnknown,
    openingCash: p.actualNav.openingCash,
    stopCosts: input.stopCosts,
    basis:
      "移动加权；原历史回合边界；跨除权仅退出规则与统计，现金原样保留；原成交量与费用同比缩放（部分卖出可含理论碎股）；新增止损按固定实验佣金与股票卖出税计算，不代表历史费率，无滑点，未建模涨跌停成交限制；缺日线顺延，不能区分停牌与数据缺口；整体 TWR 中断则最大回撤留空。",
    points,
  };
}
export type DisciplineResult = ReturnType<typeof runDisciplineGrid>;
