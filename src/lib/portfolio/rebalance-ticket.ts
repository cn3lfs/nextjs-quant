import { portfolioExecutionFee } from "quant-backtest";
import {
  isCnEtfSymbol,
  resolveInstrumentRule,
  sizeEntryWithRisk,
  type InstrumentRuleOptions,
  type PortfolioRiskPolicy,
  type PortfolioRiskState,
} from "quant-execution";
import { completedBarFilter } from "trading-strategy-core/completed-bars";
import {
  executionCostsForInstrument,
  researchExecutionCosts,
} from "trading-strategy-core/costs";
import { big } from "trading-strategy-core/money";
import { classifySecurityCode } from "trading-strategy-core/security";
import { computePriceLimits } from "tstdx/market-rules";
import { z } from "zod";
import { closeScanWindow } from "~/lib/market/close-scan-window";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import type {
  RebalanceOrder,
  RebalancePlanRecord,
  RebalanceRecheckResult,
  RebalanceRiskSummary,
} from "~/server/db/rebalance-plan-repository";

const price = z.number().finite().positive();
const nonnegative = z.number().finite().nonnegative();
const symbolSchema = z
  .string()
  .regex(/^(sh|sz|bj)\d{6}$/)
  .refine((s) => {
    const c = classifySecurityCode(s.slice(2));
    return (
      isCnEtfSymbol(s) ||
      (c.market === s.slice(0, 2) &&
        c.instrument === "stock" &&
        !/^(sh900|sz200)/.test(s))
    );
  }, "仅接受人民币 A 股或 ETF");
export const targetWeightsSchema = z
  .record(symbolSchema, nonnegative.max(1))
  .refine(
    (weights) =>
      Object.keys(weights).length <= 500 &&
      Object.values(weights).reduce((s, v) => s + v, 0) <= 1 + 1e-12,
    "目标权重合计超过 100% 或标的过多",
  );
export const frozenAllocationSchema = z
  .object({
    sourceKind: z.enum(["alpha", "etf_rotation", "studio", "manual"]),
    sourceRefId: z.string().min(1),
    asOfDate: z.string().date(),
    targets: targetWeightsSchema,
    scores: z.record(symbolSchema, z.number().finite()),
  })
  .strict()
  .refine(
    (v) => Object.keys(v.scores).every((s) => Object.hasOwn(v.targets, s)),
    "评分与冻结目标不一致",
  );
export type FrozenAllocation = z.infer<typeof frozenAllocationSchema>;
export const maxGapSchema = nonnegative.max(0.2);
export type TicketInstrument = {
  symbol: string;
  closeDate: string | null;
  close: number | null;
  atr14: number | null;
  quantity: number;
  sellable: number | null;
  stopPrice: number | null;
  groups: string[];
  ruleOptions?: InstrumentRuleOptions;
};
export type TicketAccountEvidence = {
  asOfDate: string | null;
  equityCny: number | null;
  cashCny: number | null;
  state: PortfolioRiskState | null;
  policy: PortfolioRiskPolicy;
  issues: string[];
  instruments: TicketInstrument[];
  maxPositions?: number;
};
export type TicketDraftInput = {
  allocation: FrozenAllocation;
  account: TicketAccountEvidence;
  executeDate: string;
  executeDateBasis?: ExecuteDateBasis;
  maxGap: number;
};
const estimateSchema = z
  .object({
    close: price,
    estimatePrice: price,
    estimatedNotionalCny: price,
    estimatedFeesCny: nonnegative,
    cashRequiredCny: nonnegative,
    netSaleProceedsCny: z.number().finite(),
    atr14: price.nullable(),
    settlementCycle: z.enum(["T+0", "T+1"]),
    sizingReasons: z.array(z.string()),
  })
  .strict();
export type TicketEstimate = z.infer<typeof estimateSchema>;
type Check = RebalanceRiskSummary["checks"][number];
const allocationCode = "ticket.allocation.v1";
const estimateCode = "ticket.estimate.v1";
const executeDateCode = "ticket.execute-date.v1";
const executeDateEvidenceSchema = z.object({
  executeDateBasis: z.enum(["market-calendar", "next-weekday-unconfirmed"]),
});
type ExecuteDateBasis = z.infer<
  typeof executeDateEvidenceSchema
>["executeDateBasis"];
const unconfirmedExecuteDateDetail =
  "无未来交易所日历，按下一工作日保守推导，盘前请复检";
function readDetail<T>(
  checks: Check[],
  code: string,
  schema: z.ZodType<T>,
): T | null {
  const entries = checks.filter((c) => c.code === code);
  if (
    entries.length !== 1 ||
    entries[0]?.status !== "passed" ||
    !entries[0].detail
  )
    return null;
  try {
    return schema.parse(JSON.parse(entries[0].detail));
  } catch {
    return null;
  }
}
export function nextTicketSession(
  calendar: readonly string[],
  asOfDate: string,
  now: number,
) {
  const days = [...new Set(calendar)]
    .filter((d) => {
      const weekday = new Date(d + "T00:00:00Z").getUTCDay();
      return (
        weekday > 0 && weekday < 6 && z.string().date().safeParse(d).success
      );
    })
    .sort();
  const completed = days.filter(completedBarFilter("day", now));
  if (completed.at(-1) !== asOfDate || !completed.includes(asOfDate))
    throw new Error("决策日必须为最近有依据的已完成交易日收盘");
  const window = closeScanWindow(asOfDate, days);
  const executeDate = chinaClock(window.deadline).date;
  if (executeDate < chinaClock(now).date) throw new Error("下一预期交易日已过");
  const executeDateBasis: ExecuteDateBasis = window.calendarConfirmed
    ? "market-calendar"
    : "next-weekday-unconfirmed";
  return { executeDate, executeDateBasis };
}
const validPrice = (n: number | null): n is number =>
  n !== null && Number.isFinite(n) && n > 0;
const validQuantity = (n: number | null): n is number =>
  n !== null && Number.isSafeInteger(n) && n >= 0;
const baseCosts = researchExecutionCosts("cn-equity", "base");
function amountAt(
  side: "buy" | "sell",
  quantity: number,
  p: number,
  s: Pick<TicketInstrument, "symbol" | "ruleOptions">,
  date: string,
) {
  const costs = executionCostsForInstrument(
    baseCosts,
    s.symbol,
    date,
    s.ruleOptions,
  );
  const fees = big(portfolioExecutionFee(quantity, p, side, costs)).round(2, 3);
  const amount = big(p).times(quantity);
  return {
    estimatedNotionalCny: amount.toNumber(),
    estimatedFeesCny: fees.toNumber(),
    cashRequiredCny: side === "buy" ? amount.plus(fees).toNumber() : 0,
    netSaleProceedsCny: side === "sell" ? amount.minus(fees).toNumber() : 0,
  };
}
export function buildRebalanceTicket(input: TicketDraftInput): {
  orders: RebalanceOrder[];
  riskSummary: RebalanceRiskSummary;
} {
  const { account, executeDate } = input;
  const allocation = frozenAllocationSchema.parse(input.allocation);
  const gap = maxGapSchema.parse(input.maxGap);
  const { equityCny, cashCny, state, policy } = account;
  const checks: Check[] = [
    {
      code: allocationCode,
      status: "passed",
      detail: JSON.stringify(allocation),
    },
  ];
  if (input.executeDateBasis)
    checks.push({
      code: executeDateCode,
      status: "passed",
      detail: JSON.stringify({ executeDateBasis: input.executeDateBasis }),
    });
  const orders: RebalanceOrder[] = [];
  const riskSummary: RebalanceRiskSummary = {
    status: state?.mode ?? "paused",
    checks,
    metrics: { maxGap: gap, equityCny, cashCny },
  };
  const block = (code: string, detail: string, symbol?: string) =>
    checks.push({ code, status: "blocked", detail, ...(symbol && { symbol }) });
  if (
    executeDate <= allocation.asOfDate ||
    account.asOfDate !== allocation.asOfDate ||
    state?.date !== allocation.asOfDate ||
    !validPrice(equityCny) ||
    cashCny === null ||
    !Number.isFinite(cashCny) ||
    cashCny < 0 ||
    !state
  ) {
    block("account", "账户资金、风险状态或估值日期不完整");
  }
  for (const detail of account.issues) block("ledger", detail);
  const rows = new Map(account.instruments.map((s) => [s.symbol, s]));
  if (rows.size !== account.instruments.length)
    block("duplicate", "标的持仓必须在账户内汇总一次");
  for (const symbol of new Set([
    ...Object.keys(allocation.targets),
    ...rows.keys(),
  ])) {
    const s = rows.get(symbol);
    if (
      !s ||
      !symbolSchema.safeParse(symbol).success ||
      !validQuantity(s.quantity) ||
      !validPrice(s.close) ||
      s.closeDate !== allocation.asOfDate
    ) {
      block("price", "缺少决策日原价收盘或股数", symbol);
      continue;
    }
    if (s.quantity && (!validQuantity(s.sellable) || s.sellable > s.quantity))
      block("sellable", "缺少可卖数量依据", symbol);
    if (
      equityCny !== null &&
      (allocation.targets[symbol] ?? 0) * equityCny > s.quantity * s.close &&
      !validPrice(s.atr14)
    )
      block("atr", "缺少连续 Wilder ATR(14)", symbol);
  }
  if (
    checks.some((c) => c.status === "blocked") ||
    cashCny === null ||
    !validPrice(equityCny) ||
    !state
  )
    return { orders, riskSummary };
  const marked = account.instruments.reduce(
    (v, s) => v.plus(big(s.close!).times(s.quantity)),
    big(cashCny),
  );
  if (marked.minus(equityCny).abs().gt(0.02)) {
    block("balance", "现金与同日持仓市值无法对齐账户权益");
    return { orders, riskSummary };
  }
  let cash = big(cashCny),
    independentCash = big(cashCny),
    equity = big(equityCny);
  const working = account.instruments
    .map((s) => ({ ...s }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  const estimateCheck = (e: TicketEstimate): Check => ({
    code: estimateCode,
    status: "passed",
    detail: JSON.stringify(estimateSchema.parse(e)),
  });
  for (const s of working) {
    const close = s.close!;
    const excess = big(s.quantity).minus(
      big(equityCny)
        .times(allocation.targets[s.symbol] ?? 0)
        .div(close),
    );
    const rule = resolveInstrumentRule(s.symbol, executeDate, s.ruleOptions);
    const available = Math.min(excess.toNumber(), s.sellable ?? 0);
    const quantity =
      Math.floor(available / rule.buyQuantityStep) * rule.buyQuantityStep;
    if (quantity < rule.minimumBuyQuantity) continue;
    const amount = amountAt("sell", quantity, close, s, executeDate);
    orders.push({
      side: "sell",
      symbol: s.symbol,
      quantity,
      conditional: false,
      riskChecks: [
        estimateCheck({
          close,
          estimatePrice: close,
          atr14: s.atr14,
          settlementCycle: rule.settlementCycle,
          sizingReasons: [],
          ...amount,
        }),
      ],
    });
    cash = cash.plus(amount.netSaleProceedsCny);
    equity = equity.minus(amount.estimatedFeesCny);
    s.quantity -= quantity;
  }
  const holdings = working
    .filter((s) => s.quantity > 0)
    .map((s) => ({ ...s, mark: s.close! }));
  for (const s of [...working].sort(
    (a, b) =>
      (allocation.scores[b.symbol] ?? 0) - (allocation.scores[a.symbol] ?? 0) ||
      a.symbol.localeCompare(b.symbol),
  )) {
    const close = s.close!,
      target = allocation.targets[s.symbol] ?? 0;
    const rule = resolveInstrumentRule(s.symbol, executeDate, s.ruleOptions);
    const floorTick = (p: ReturnType<typeof big>) =>
      p.div(rule.priceTick).round(0, 0).times(rule.priceTick).toNumber();
    const cap = floorTick(big(close).times(big(1).plus(gap)));
    const wanted = big(equityCny)
      .times(target)
      .minus(big(close).times(rows.get(s.symbol)!.quantity));
    if (wanted.lte(0)) continue;
    const heldSymbols = new Set(holdings.map((h) => h.symbol));
    if (
      !heldSymbols.has(s.symbol) &&
      heldSymbols.size >= (account.maxPositions ?? 10)
    ) {
      checks.push({
        code: "position_cap",
        status: "passed",
        symbol: s.symbol,
        detail: "已达到持仓数量上限，新增数量为零",
      });
      continue;
    }
    const stop = floorTick(
      big(close).minus(big(s.atr14!).times(policy.atrStopMultiple)),
    );
    const groups = s.groups.length ? s.groups : ["unknown"];
    const cost = (q: number) => amountAt("buy", q, cap, s, executeDate);
    const decisions = groups.map((industry) =>
      sizeEntryWithRisk({
        equity: equity.toNumber(),
        cash: cash.toNumber(),
        symbol: s.symbol,
        date: executeDate,
        price: cap,
        industry,
        stopPrice: stop,
        requestedQuantity: wanted.div(cap).toNumber(),
        state,
        policy,
        rule,
        cashCost: (q) => cost(q).cashRequiredCny,
        positions: holdings.map((h) => ({
          symbol: h.symbol,
          quantity: h.quantity,
          mark: h.mark,
          stopPrice: h.stopPrice,
          industry:
            industry === "unknown" ||
            !h.groups.length ||
            h.groups.includes(industry)
              ? industry
              : h.groups[0],
        })),
      }),
    );
    const quantity = Math.min(...decisions.map((d) => d.quantity));
    const reasons = [...new Set(decisions.flatMap((d) => d.reasons))];
    if (!quantity) {
      checks.push({
        code: "sizing",
        symbol: s.symbol,
        status: "passed",
        detail: "新增数量为零：" + reasons.join(", "),
      });
      continue;
    }
    const amount = cost(quantity);
    orders.push({
      side: "buy",
      symbol: s.symbol,
      quantity,
      atrStopPrice: stop,
      maxBuyPrice: cap,
      conditional: independentCash.lt(amount.cashRequiredCny),
      riskChecks: [
        estimateCheck({
          close,
          estimatePrice: cap,
          ...amount,
          atr14: s.atr14,
          settlementCycle: rule.settlementCycle,
          sizingReasons: reasons,
        }),
      ],
    });
    cash = cash.minus(amount.cashRequiredCny);
    independentCash = independentCash.minus(amount.cashRequiredCny);
    equity = equity.minus(amount.estimatedFeesCny);
    holdings.push({ ...s, quantity, mark: cap, stopPrice: stop });
  }
  return { orders, riskSummary };
}

export function projectRebalanceTicket(plan: RebalancePlanRecord, now: number) {
  const expired = plan.status !== "cancelled" && now >= plan.expiresAt;
  const frozen = readDetail(
    plan.riskSummary.checks,
    allocationCode,
    frozenAllocationSchema,
  );
  const executeDateBasis =
    readDetail(
      plan.riskSummary.checks,
      executeDateCode,
      executeDateEvidenceSchema,
    )?.executeDateBasis ?? null;
  return {
    ...plan,
    status: expired ? ("expired" as const) : plan.status,
    executeDateBasis,
    executeDateNote:
      executeDateBasis === "next-weekday-unconfirmed"
        ? unconfirmedExecuteDateDetail
        : null,
    providerLimits:
      "盘前复检使用分钟内行情和当日交易状态。涨跌停价按前收与品种规则估算，依据不足时保留待核验。卖款为扣费估算。",
    allocation:
      frozen?.asOfDate === plan.asOfDate &&
      frozen.sourceKind === plan.sourceKind &&
      frozen.sourceRefId === plan.sourceRefId
        ? frozen
        : null,
    orders: plan.orders.map((o) => ({
      ...o,
      estimate: readDetail(o.riskChecks, estimateCode, estimateSchema),
    })),
  };
}
export type RebalanceTicket = ReturnType<typeof projectRebalanceTicket>;
export type TicketQuote = {
  symbol: string;
  observedAt: number | null;
  price: number | null;
  tradingStatus: "trading" | "suspended" | "unknown";
  limitUp: number | null;
  limitDown: number | null;
  limitBasis?: string;
  source: string;
};

const etfTwentyPercent = /^(?:sh588\d{3}|sz159(?:915|949|781))$/;
const etfKnownStandard =
  /^(?:sh(?:510|511|513|518)\d{3}|sz159(?:919|922|934|937))$/;
export function ticketReferenceLimits(
  symbol: string,
  executeDate: string,
  preClose: number | null,
  name?: string,
  options?: InstrumentRuleOptions,
) {
  if (!validPrice(preClose) || !symbolSchema.safeParse(symbol).success)
    return null;
  const rule = resolveInstrumentRule(symbol, executeDate, options);
  if (rule.kind === "stock") {
    const { up, down } = computePriceLimits(symbol, preClose, {
      ruleDate: Number(executeDate.replaceAll("-", "")),
      name,
      tickSize: rule.priceTick,
    });
    return up !== null && down !== null && down > 0 && up > down
      ? { up, down }
      : null;
  }
  const fundName = name?.trim();
  const knownTwentyPercent = etfTwentyPercent.test(symbol);
  if (!fundName && !knownTwentyPercent && !etfKnownStandard.test(symbol))
    return null;
  const nameUsesTwentyPercent =
    fundName &&
    /创业板|创业50|创50|创成长|科创|双创/.test(fundName) &&
    !/债|货币/.test(fundName);
  const rate = knownTwentyPercent || nameUsesTwentyPercent ? 0.2 : 0.1;
  const rounded = (factor: number) =>
    big(preClose)
      .times(factor)
      .div(rule.priceTick)
      .round(0, 1)
      .times(rule.priceTick)
      .toNumber();
  const up = rounded(1 + rate),
    down = rounded(1 - rate);
  return down > 0 && up > down ? { up, down } : null;
}

export function isFreshTicketQuoteTime(
  observedAt: number | null | undefined,
  executeDate: string,
  now: number,
): observedAt is number {
  if (
    observedAt == null ||
    !Number.isSafeInteger(observedAt) ||
    observedAt > now ||
    now - observedAt >= 60_000
  )
    return false;
  const quote = chinaClock(observedAt);
  return (
    quote.date === executeDate && quote.time >= "09:15" && quote.time < "09:30"
  );
}

export function recheckTicketEvidence(
  ticket: RebalanceTicket,
  now: number,
  current: ReturnType<typeof buildRebalanceTicket> | null,
  quotes: readonly TicketQuote[],
  executeDateBasis: ExecuteDateBasis | null = ticket.executeDateBasis,
): RebalanceRecheckResult {
  const checks: RebalanceRecheckResult["checks"] = [];
  const check = (
    code: string,
    status: (typeof checks)[number]["status"],
    detail: string,
    symbol?: string,
  ) => checks.push({ code, status, detail, ...(symbol && { symbol }) });
  const clock = chinaClock(now);
  if (
    ticket.status !== "confirmed" ||
    !ticket.confirmedAt ||
    now < ticket.confirmedAt ||
    now >= ticket.expiresAt
  )
    check("status", "blocked", "只允许已确认且未到期的票据复检");
  if (
    clock.date !== ticket.executeDate ||
    clock.time < "09:15" ||
    clock.time >= "09:30"
  )
    check("window", "blocked", "仅在执行日北京时间 09:15–09:30 盘前复检");
  if (!ticket.orders.length || !ticket.allocation)
    check("ticket", "blocked", "缺少可执行调仓项或经校验的冻结目标");
  if (executeDateBasis === "next-weekday-unconfirmed")
    check("calendar", "unknown", "无交易所日历确认执行日，请核对当日是否开市");
  for (const c of [
    ...ticket.riskSummary.checks,
    ...ticket.orders.flatMap((o) => o.riskChecks),
    ...(current?.riskSummary.checks ?? []),
  ])
    if (c.status !== "passed") checks.push(c);
  if (!current) check("risk", "unknown", "缺少当前账户风险与资金校验");
  else if (
    ticket.riskSummary.status !== current.riskSummary.status ||
    current.orders.length !== ticket.orders.length ||
    ticket.orders.some((o, i) => {
      const next = current.orders[i];
      return (
        !next ||
        o.side !== next.side ||
        o.symbol !== next.symbol ||
        o.quantity !== next.quantity ||
        o.conditional !== next.conditional ||
        (o.side === "buy" &&
          next.side === "buy" &&
          (o.maxBuyPrice !== next.maxBuyPrice ||
            o.atrStopPrice !== next.atrStopPrice))
      );
    })
  )
    check(
      "risk",
      "blocked",
      "当前账户风险、可卖数量或资金校验与冻结调仓项不一致",
    );
  else check("risk", "passed", "已按当前账本重算资金、风险和定仓上限");
  const cashEvidence = current?.riskSummary.metrics?.cashCny;
  let cash = cashEvidence == null ? null : big(cashEvidence);
  for (const o of ticket.orders) {
    const matches = quotes.filter((q) => q.symbol === o.symbol);
    const q = matches.length === 1 ? matches[0] : undefined;
    if (q?.tradingStatus === "suspended")
      check("halt", "blocked", "当日停牌", o.symbol);
    else if (q?.tradingStatus !== "trading")
      check("halt", "unknown", "当日交易状态待核验", o.symbol);
    if (!o.estimate)
      check("estimate", "blocked", "缺少已校验订单估算", o.symbol);
    const qt = q?.observedAt;
    if (
      !q ||
      !isFreshTicketQuoteTime(qt, ticket.executeDate, now) ||
      !validPrice(q.price)
    ) {
      check(
        "quote",
        "blocked",
        "缺少执行日一分钟内的有效盘前报价：" + (q?.source ?? "无本地报价"),
        o.symbol,
      );
      continue;
    }
    check(
      "quote",
      "passed",
      q.source + " " + new Date(qt).toISOString() + " " + q.price,
      o.symbol,
    );
    const limitEvidence = q.limitBasis
      ? `${q.limitBasis} · 参考涨停 ${q.limitUp} / 跌停 ${q.limitDown}`
      : null;
    if (
      !validPrice(q.limitUp) ||
      !validPrice(q.limitDown) ||
      q.limitUp <= q.limitDown
    )
      check("limits", "unknown", "缺少有效前收价或适用的涨跌幅规则", o.symbol);
    else if (
      q.price > q.limitUp ||
      q.price < q.limitDown ||
      (o.side === "buy" ? q.price === q.limitUp : q.price === q.limitDown)
    )
      check(
        "limits",
        "blocked",
        ["报价超出有效范围或已触及本方向涨跌停", limitEvidence]
          .filter(Boolean)
          .join(" · "),
        o.symbol,
      );
    else if (limitEvidence) check("limits", "passed", limitEvidence, o.symbol);
    if (o.side === "buy") {
      if (q.price > o.maxBuyPrice || q.price <= o.atrStopPrice)
        check(
          "price_band",
          "blocked",
          "报价超过拒追价或已触发 ATR 止损",
          o.symbol,
        );
      if (o.estimate && cash) cash = cash.minus(o.estimate.cashRequiredCny);
    } else if (cash) {
      cash = cash.plus(
        amountAt(
          "sell",
          o.quantity,
          q.price,
          { symbol: o.symbol },
          ticket.executeDate,
        ).netSaleProceedsCny,
      );
    }
  }
  if (cash?.lt(0))
    check("cash", "blocked", "按最新卖价扣费后的资金不足以覆盖买入限价及费用");
  const conditional = ticket.orders.some((o) => o.conditional);
  if (conditional)
    check("sale_proceeds", "passed", "买入仍以先卖出且收到足额净款为条件");
  return {
    checks,
    outcome: checks.some((c) => c.status === "blocked")
      ? "blocked"
      : checks.some((c) => c.status === "unknown" || c.status === "warning")
        ? "warning"
        : conditional
          ? "conditional"
          : "passed",
  };
}
