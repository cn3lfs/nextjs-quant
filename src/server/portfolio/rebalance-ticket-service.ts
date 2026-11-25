import { randomUUID } from "node:crypto";
import {
  lotAvailable,
  resolveInstrumentRule,
  wilderAtr14,
} from "quant-execution";
import type { Bar } from "trading-strategy-core/bars";
import { readSnapshot, securityNames } from "tstdx/local";
import { z } from "zod";
import {
  buildRebalanceTicket,
  isFreshTicketQuoteTime,
  maxGapSchema,
  nextTicketSession,
  projectRebalanceTicket,
  recheckTicketEvidence,
  ticketReferenceLimits,
  type FrozenAllocation,
  type RebalanceTicket,
  type TicketAccountEvidence,
  type TicketInstrument,
  type TicketQuote,
} from "~/lib/portfolio/rebalance-ticket";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import {
  cancelRebalancePlan,
  confirmRebalancePlan,
  createRebalancePlan,
  expireStaleRebalancePlans,
  getRebalancePlan,
  listRebalancePlans,
  recordRebalanceRecheck,
  type RebalancePlanAccount,
} from "../db/rebalance-plan-repository";
import { storedSecurityTradingStatus } from "../market/security-trading-status";
import { storedSecurityName } from "../market/securities";
import { fetchOverviewQuotes } from "../market/overview-quotes";
import { thsdkCallAuction } from "../data-sources/thsdk/thsdk-adapter";
import type { StockEvents } from "../research/stock-events";
import { checkTicketUnlockEvents } from "./ticket-unlock-check";
import {
  rebalanceSourceSchema,
  resolveRebalanceTargets,
} from "../paper/rebalance-targets";
import type { AccountBook } from "./account-workspace/load-book";
import {
  evaluateAccountPortfolioRisk,
  loadPortfolioRiskBook,
  readAccountSourceBars,
} from "./portfolio-risk-service";

const id = z.string().trim().min(1).max(200);
const accountSchema = z
  .object({ accountScope: z.enum(["real", "paper"]), accountId: id })
  .strict();
export const generateTicketSchema = accountSchema.extend({
  asOfDate: z.string().date(),
  source: rebalanceSourceSchema,
  maxGap: maxGapSchema.default(0.02),
});
export const ticketIdSchema = z.object({ id }).strict();
export const listTicketsSchema = accountSchema.extend({
  limit: z.number().int().min(1).max(100).default(20),
  after: accountSchema
    .extend({
      id,
      executeDate: z.string().date(),
      createdAt: z.number().int().safe().nonnegative(),
    })
    .optional(),
});
export type GenerateTicketInput = z.input<typeof generateTicketSchema>;
export type TicketIdInput = z.input<typeof ticketIdSchema>;
export type ListTicketsInput = z.input<typeof listTicketsSchema>;

// Only accept explicit free shares from an unambiguous broker line. Share
// balance is total ownership and cannot establish freezes or availability.
function realSellable(
  book: AccountBook,
  account: string,
  symbol: string,
  day: string,
  quantity: number,
) {
  const rows = book.facts.fills.filter(
    (f) => f.account === account && f.symbol === symbol && f.tradeDate === day,
  );
  if (!rows.length || (rows.length > 1 && rows.some((f) => !f.tradeTime)))
    return null;
  rows.sort((a, b) => (b.tradeTime ?? "").localeCompare(a.tradeTime ?? ""));
  const last = rows[0]!;
  if (
    (rows.length > 1 && last.tradeTime === rows[1]!.tradeTime) ||
    last.balanceShares !== quantity
  )
    return null;
  const batch = book.facts.batches.find(
    (b) => b.id === last.batchId && b.account === account,
  );
  const indices =
    batch?.payload.sourceHeader?.flatMap((h, i) =>
      ["可卖数量", "可用股份", "可卖股份"].includes(h.trim()) ? [i] : [],
    ) ?? [];
  if (indices.length !== 1) return null;
  const cell = batch?.payload.rawRows[last.rowIndex - 1]?.[indices[0]!]?.trim();
  if (!cell || !/^\d+(\.0+)?$/.test(cell)) return null;
  const n = Number(cell);
  return Number.isSafeInteger(n) && n <= quantity ? n : null;
}

function closeAndAtr(
  bars: readonly Bar[],
  days: readonly string[],
  asOf: string,
) {
  const byDate = new Map<string, Bar | null>();
  for (const b of bars)
    if (b.date <= asOf)
      byDate.set(b.date, byDate.has(b.date) || !(b.volume > 0) ? null : b);
  const sequence: Bar[] = [];
  for (const d of [...new Set(days)]
    .filter((d) => d <= asOf)
    .sort()
    .reverse()) {
    const bar = byDate.get(d);
    if (!bar) break;
    sequence.push(bar);
  }
  const last = sequence[0];
  return {
    close: last?.date === asOf ? last.close : null,
    closeDate: last?.date ?? null,
    atr14: wilderAtr14(sequence.reverse()),
  };
}

export async function readTicketAccountEvidence(
  book: AccountBook,
  account: RebalancePlanAccount,
  allocation: FrozenAllocation,
  executeDate: string,
  at: number,
): Promise<TicketAccountEvidence> {
  const { accountId, accountScope } = account,
    day = allocation.asOfDate;
  const paper =
    accountScope === "paper"
      ? book.facts.paper.find(
          (p) =>
            p.account.id === accountId &&
            p.account.market === "cn-equity" &&
            p.account.currency === "CNY",
        )
      : undefined;
  const state = paper?.state;
  const risk = evaluateAccountPortfolioRisk(
    book,
    {
      scope: accountScope,
      account: accountId,
      policy: state?.request.riskPolicy,
    },
    at,
  );
  const issues =
    risk.status === "complete" ? [] : [...risk.reasons, "账户风控快照不完整"];
  if (accountScope === "real") {
    const fills = book.facts.fills.filter((f) => f.account === accountId);
    const flows = book.facts.cashFlows.filter((f) => f.account === accountId);
    if (
      ![
        ...fills.filter((f) => f.tradeDate === day),
        ...flows.filter((f) => f.flowDate === day),
      ].some((f) => f.balanceCash != null && Number.isFinite(f.balanceCash))
    )
      issues.push("真实交割单缺少决策日柜台现金余额依据");
    if (
      book.facts.batches.some(
        (b) => b.account === accountId && b.payload.unresolved.length > 0,
      )
    )
      issues.push("账户交割单存在未解析流水");
  } else if (!state || paper?.account.lastBar?.slice(0, 10) !== day)
    issues.push("纸面检查点不是决策日收盘");
  else if (state.result.orders.some((o) => o.status === "pending"))
    issues.push("纸面账本存在待处理委托，资金或股份可能已占用");
  const positions = book.positions.filter(
    (p) =>
      p.kind === accountScope &&
      p.account === accountId &&
      p.market === "cn-equity" &&
      p.currency === "CNY" &&
      p.quantity !== 0,
  );
  const instruments: TicketInstrument[] = [];
  for (const symbol of new Set([
    ...Object.keys(allocation.targets),
    ...positions.map((p) => p.symbol),
  ])) {
    const held = positions.filter((p) => p.symbol === symbol);
    const quantity = held.reduce((n, p) => n + p.quantity, 0);
    const instrument = state?.request.instruments.find(
      (i) => i.symbol === symbol,
    );
    const ruleOptions = instrument
      ? {
          instrumentKind: instrument.instrumentKind,
          settlementCycle: instrument.settlementCycle,
          stampDutyExempt: instrument.stampDutyExempt,
        }
      : undefined;
    const rule = resolveInstrumentRule(symbol, executeDate, ruleOptions);
    const daily = instrument?.bars.filter((b) => b.date.length === 10) ?? [];
    const local = book.bars[symbol];
    const bars = daily.some((b) => b.date === day)
      ? daily
      : local?.some((b) => b.date === day)
        ? local
        : await readAccountSourceBars(book.config.tdxRoot, symbol);
    const quote = closeAndAtr(bars, book.calendar, day);
    if (
      held.some(
        (p) =>
          p.at?.slice(0, 10) !== day ||
          p.price !== quote.close ||
          !Number.isSafeInteger(p.quantity) ||
          p.quantity < 0,
      )
    )
      issues.push(symbol + " 账面持仓日期、原价或股数未对齐");
    let sellable: number | null = 0;
    if (quantity && accountScope === "real")
      sellable = realSellable(book, accountId, symbol, day, quantity);
    if (quantity && accountScope === "paper") {
      const lots =
        state?.result.positions
          .filter((p) => p.symbol === symbol)
          .flatMap((p) => p.lots ?? []) ?? [];
      sellable =
        lots.every(
          (l) =>
            Number.isSafeInteger(l.quantity) &&
            l.quantity > 0 &&
            l.bought?.slice(0, 10) <= day &&
            z.string().date().safeParse(l.bought.slice(0, 10)).success &&
            (!l.availableOn ||
              z.string().date().safeParse(l.availableOn.slice(0, 10)).success),
        ) && lots.reduce((n, l) => n + l.quantity, 0) === quantity
          ? lots
              .filter((l) => lotAvailable(l, executeDate, rule.settlementDays))
              .reduce((n, l) => n + l.quantity, 0)
          : null;
    }
    // A single conservative stop also covers several sleeves of one symbol.
    const stops = held.map(
      (p) =>
        p.stop ??
        (p.price && risk.policy.missingStopFraction !== null
          ? p.price * (1 - risk.policy.missingStopFraction)
          : null),
    );
    instruments.push({
      symbol,
      ...quote,
      ruleOptions,
      quantity,
      sellable,
      stopPrice:
        stops.length && stops.every((v): v is number => v !== null && v > 0)
          ? Math.min(...stops)
          : null,
      groups: book.industryBySymbol.get(symbol) ?? [],
    });
  }
  const cap = state?.request.accountMaxSymbolWeight ?? 1;
  const policy = {
    ...risk.policy,
    maxSingleInstrumentWeight: Math.min(
      cap,
      risk.policy.maxSingleInstrumentWeight,
    ),
    maxEtfWeight: Math.min(
      cap,
      risk.policy.maxEtfWeight ?? risk.policy.maxSingleInstrumentWeight,
    ),
  };
  return {
    asOfDate: risk.asOf,
    equityCny: risk.equityCny,
    cashCny: risk.cashCny,
    state: risk.state,
    policy,
    instruments,
    issues,
    maxPositions: Math.min(10, state?.request.accountMaxUniqueSymbols ?? 10),
  };
}

export async function readTicketQuotes(
  book: AccountBook,
  ticket: RebalanceTicket,
  at: number,
  instruments: readonly TicketInstrument[] = [],
): Promise<TicketQuote[]> {
  const marketSource = book.config.marketDataSource;
  const symbols = [...new Set(ticket.orders.map(({ symbol }) => symbol))];
  const live =
    marketSource === "auto" || marketSource === "tencent"
      ? await fetchOverviewQuotes(
          symbols,
          marketSource === "tencent" ? { tdxFallback: async () => [] } : {},
        ).catch(() => null)
      : null;
  const liveBySymbol = new Map(
    live?.quotes.map((quote) => [quote.symbol, quote]),
  );
  const bySymbol = new Map(
    instruments.map((instrument) => [instrument.symbol, instrument]),
  );
  const localNames = new Map<string, ReturnType<typeof securityNames>>();
  async function readName(symbol: string) {
    const market = symbol.slice(0, 2);
    let names = localNames.get(market);
    if (!names) {
      names = securityNames(book.config.tdxRoot, market).catch(
        () => new Map<string, string>(),
      );
      localNames.set(market, names);
    }
    return (await names).get(symbol);
  }
  return Promise.all(
    symbols.map(async (symbol) => {
      let observedAt: number | null = null,
        price: number | null = null;
      const quote = liveBySymbol.get(symbol);
      let source = live?.source as string | undefined;
      let observedBy = Math.max(at, live?.fetchedAt ?? at);
      let hasTradingActivity = false;
      let providerPreClose: number | null = null;
      if (quote?.quoteTime) {
        const timestamp = Date.parse(
          quote.quoteTime.replace(" ", "T") + "+08:00",
        );
        if (isFreshTicketQuoteTime(timestamp, ticket.executeDate, observedBy)) {
          observedAt = timestamp;
          price = quote.price;
          if (Number.isFinite(quote.preClose) && quote.preClose > 0)
            providerPreClose = quote.preClose;
          hasTradingActivity =
            quote.amount > 0 ||
            (providerPreClose !== null && quote.price !== providerPreClose);
        }
      }
      if (marketSource === "thsdk") {
        const auction = await thsdkCallAuction(
          symbol,
          "opening",
          ticket.executeDate,
        ).catch(() => null);
        const latest = auction?.points.reduce<
          NonNullable<typeof auction>["points"][number] | null
        >(
          (last, point) =>
            last === null || point.timestamp > last.timestamp ? point : last,
          null,
        );
        observedBy = Math.max(observedBy, auction?.fetchedAt ?? at);
        if (
          latest &&
          isFreshTicketQuoteTime(
            latest.timestamp,
            ticket.executeDate,
            observedBy,
          )
        ) {
          observedAt = latest.timestamp;
          price = latest.price;
          hasTradingActivity = latest.curVolume > 0;
          source = "同花顺集合竞价";
        }
      }
      try {
        const snapshot =
          observedAt === null
            ? await readSnapshot(book.config.tdxRoot, symbol, "5m", {
                chartFunds: true,
              })
            : null;
        const bar = snapshot?.bars
          .slice()
          .reverse()
          .find((b) => Date.parse(b.date) <= at);
        if (bar && bar.volume > 0) {
          observedAt = Date.parse(bar.date);
          price = bar.close;
          hasTradingActivity = true;
          source = "通达信本地五分钟原价";
        }
      } catch {
        /* Local files may be absent. Leave price and clock unknown. */
      }
      const instrument = bySymbol.get(symbol);
      const rule = resolveInstrumentRule(
        symbol,
        ticket.executeDate,
        instrument?.ruleOptions,
      );
      const status = storedSecurityTradingStatus(symbol);
      const sameDayStatus =
        status?.version === "security-trading-status-1" &&
        status.symbol === symbol &&
        status.asOf === ticket.executeDate &&
        status.fetchedAt <= observedBy;
      const freshStatus =
        sameDayStatus && observedBy - status.fetchedAt < 60_000;
      const freshQuote =
        isFreshTicketQuoteTime(observedAt, ticket.executeDate, observedBy) &&
        price !== null &&
        Number.isFinite(price) &&
        price > 0;
      let tradingStatus: TicketQuote["tradingStatus"] = freshStatus
        ? status.status
        : "unknown";
      if (rule.kind === "etf") {
        if (sameDayStatus && status.status === "suspended")
          tradingStatus = "suspended";
        else if (freshQuote && hasTradingActivity) tradingStatus = "trading";
      }
      const localPreClose =
        instrument?.closeDate === ticket.asOfDate ? instrument.close : null;
      const preClose = providerPreClose ?? localPreClose;
      const name =
        preClose !== null && freshQuote
          ? ((rule.kind === "stock" ? storedSecurityName(symbol) : undefined) ??
            (await readName(symbol)))
          : undefined;
      const limits = freshQuote
        ? ticketReferenceLimits(
            symbol,
            ticket.executeDate,
            preClose,
            name,
            instrument?.ruleOptions,
          )
        : null;
      return {
        symbol,
        observedAt,
        price,
        tradingStatus,
        limitUp: limits?.up ?? null,
        limitDown: limits?.down ?? null,
        ...(limits && {
          limitBasis:
            providerPreClose === null
              ? "按本地决策日原价收盘推导"
              : "按行情前收价推导",
        }),
        source: source ?? "盘前行情不可用",
      };
    }),
  );
}
export type TicketServiceSources = {
  now: () => number;
  loadBook: typeof loadPortfolioRiskBook;
  readQuotes: typeof readTicketQuotes;
  /** 仅测试注入；缺省按需读取个股事件。 */
  readEvents?: (symbol: string, signal?: AbortSignal) => Promise<StockEvents>;
};
const sources: TicketServiceSources = {
  now: Date.now,
  loadBook: loadPortfolioRiskBook,
  readQuotes: readTicketQuotes,
};
const cutoff = (day: string, time: string) =>
  Date.parse(day + "T" + time + ":00+08:00");
function activeTicket(input: TicketIdInput, at: number) {
  const { id } = ticketIdSchema.parse(input);
  const record = getRebalancePlan(id);
  if (!record) throw new Error("调仓票据不存在");
  return projectRebalanceTicket(record, at);
}
export async function generateRebalanceTicket(
  raw: GenerateTicketInput,
  deps = sources,
): Promise<RebalanceTicket> {
  const input = generateTicketSchema.parse(raw),
    at = deps.now();
  expireStaleRebalancePlans(at);
  const book = await deps.loadBook(input.accountScope, at);
  const { executeDate, executeDateBasis } = nextTicketSession(
    book.calendar,
    input.asOfDate,
    at,
  );
  const allocation = await resolveRebalanceTargets(
    input.source,
    input.asOfDate,
    book,
  );
  const account = await readTicketAccountEvidence(
    book,
    input,
    allocation,
    executeDate,
    at,
  );
  const draft = buildRebalanceTicket({
    allocation,
    account,
    executeDate,
    executeDateBasis,
    maxGap: input.maxGap,
  });
  const savedAt = deps.now();
  if (savedAt >= cutoff(executeDate, "09:30"))
    throw new Error("执行日盘前规划窗口已结束");
  const repo = new AccountWorkspaceRepository();
  return repo.atomic(() => {
    repo.assertVersion(book.facts.version);
    return projectRebalanceTicket(
      createRebalancePlan(
        {
          accountId: input.accountId,
          accountScope: input.accountScope,
          sourceKind: allocation.sourceKind,
          sourceRefId: allocation.sourceRefId,
          id: randomUUID(),
          asOfDate: input.asOfDate,
          executeDate,
          ...draft,
          expiresAt: cutoff(executeDate, "15:00"),
        },
        savedAt,
      ),
      savedAt,
    );
  });
}
export function listRebalanceTickets(raw: ListTicketsInput, at = Date.now()) {
  const { limit, after, ...account } = listTicketsSchema.parse(raw);
  const page = listRebalancePlans(account, limit, after);
  return {
    ...page,
    items: page.items.map((row) => projectRebalanceTicket(row, at)),
  };
}
export function confirmRebalanceTicket(input: TicketIdInput, at = Date.now()) {
  expireStaleRebalancePlans(at);
  const t = activeTicket(input, at);
  if (
    t.status !== "draft" ||
    at >= cutoff(t.executeDate, "09:30") ||
    !t.orders.length ||
    !t.allocation ||
    t.orders.some(
      (o) => !o.estimate || o.riskChecks.some((c) => c.status !== "passed"),
    ) ||
    t.riskSummary.checks.some((c) => c.status !== "passed")
  )
    throw new Error("仅可确认盘前窗口结束前、依据完整且有调仓项的草稿");
  return projectRebalanceTicket(confirmRebalancePlan(t.id, at), at);
}
export function cancelRebalanceTicket(input: TicketIdInput, at = Date.now()) {
  expireStaleRebalancePlans(at);
  return projectRebalanceTicket(
    cancelRebalancePlan(ticketIdSchema.parse(input).id, at),
    at,
  );
}
export async function recheckRebalanceTicket(
  input: TicketIdInput,
  deps = sources,
): Promise<RebalanceTicket> {
  const at = deps.now(),
    ticket = activeTicket(input, at),
    clock = chinaClock(at);
  if (
    ticket.status !== "confirmed" ||
    clock.date !== ticket.executeDate ||
    clock.time < "09:15" ||
    clock.time >= "09:30"
  )
    throw new Error("仅可在执行日 09:15–09:30 对已确认票据进行一次复检");
  const book = await deps.loadBook(ticket.accountScope, at);
  let current: ReturnType<typeof buildRebalanceTicket> | null = null;
  let instruments: TicketInstrument[] = [];
  let executeDateBasis = ticket.executeDateBasis;
  const gap = maxGapSchema.safeParse(ticket.riskSummary.metrics?.maxGap);
  if (ticket.allocation && gap.success) {
    const account = await readTicketAccountEvidence(
      book,
      ticket,
      ticket.allocation,
      ticket.executeDate,
      at,
    );
    instruments = account.instruments;
    try {
      const session = nextTicketSession(book.calendar, ticket.asOfDate, at);
      if (session.executeDate !== ticket.executeDate)
        account.issues.push("执行日日历已变更");
      else executeDateBasis = session.executeDateBasis;
    } catch {
      account.issues.push("决策日或执行日缺少当前日历依据");
    }
    current = buildRebalanceTicket({
      allocation: ticket.allocation,
      account,
      executeDate: ticket.executeDate,
      maxGap: gap.data,
    });
  }
  const quotes = await deps.readQuotes(book, ticket, at, instruments);
  // 限售解禁只覆盖票据内的个别 A 股买入标的，且仅提示、不阻断。
  const unlockChecks = await checkTicketUnlockEvents({
    symbols: ticket.orders.flatMap((order) =>
      order.side === "buy" ? [order.symbol] : [],
    ),
    executeDate: ticket.executeDate,
    readEvents: deps.readEvents,
  }).catch(() => [
    {
      code: "unlock",
      status: "unknown" as const,
      detail: "限售解禁事件暂不可查，请人工核对",
    },
  ]);
  const savedAt = deps.now();
  const result = recheckTicketEvidence(
    ticket,
    savedAt,
    current,
    quotes,
    executeDateBasis,
  );
  const advisory = unlockChecks.filter((check) => check.status !== "passed");
  if (advisory.length) {
    result.checks.push(...advisory);
    if (result.outcome !== "blocked") result.outcome = "warning";
  }
  const repo = new AccountWorkspaceRepository();
  return repo.atomic(() => {
    repo.assertVersion(book.facts.version);
    return projectRebalanceTicket(
      recordRebalanceRecheck(ticket.id, result, savedAt),
      savedAt,
    );
  });
}
