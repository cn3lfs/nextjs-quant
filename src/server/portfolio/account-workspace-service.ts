import { forwardDefinitionHash } from "../db/forward-reference-repository";
import { createHash } from "node:crypto";
import { strategyObjectSchema } from "trading-strategies";
import type { Bar } from "~/lib/domain";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";
import { positionFor } from "~/lib/portfolio/trade-ledger";
import { reviewTrades } from "~/lib/portfolio/trade-review";
import {
  accountPageSchema,
  decayFlag,
  positionMetrics,
  tradeLinkSchema,
  accountTradeFingerprint,
  industryGroupsFor,
  type AccountPosition,
  type AccountTrade,
} from "~/lib/portfolio/account-workspace";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import { AlertRepository } from "../db/alert-repository";
import { settings } from "../infra/settings";
import { readBars } from "../market/bar-store/read-bars";
import { tradeContext } from "./trade-ledger-service";
import { pageHoldingsCorrelation } from "./holdings-correlation-service";
import { pagePositionRisk } from "./position-risk-service";
import { binanceArchiveSource } from "../market/bar-store/binance-archive-source";
import { readIndustryBlocks } from "../market/industry-blocks";
import { reviewTradeNav } from "~/lib/portfolio/trade-review-nav";
import { bindHoldingProtection } from "./holding-protection-link";
import { HoldingProtectionRepository } from "../db/holding-protection-repository";
import { alertReference } from "~/lib/strategy-facts/alert-reference";

export type AccountFacts = ReturnType<AccountWorkspaceRepository["snapshot"]>;
export type AccountBook = Awaited<ReturnType<typeof loadAccountBook>>;
function tradeSource(trade: AccountTrade, book: AccountBook) {
  const event = book.facts.events.find((e) => e.key === trade.alertKey);
  return { ...trade, alert: event ? alertReference(event) : null };
}
const strategyHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(strategyObjectSchema.parse(value)))
    .digest("hex");
const tradeTime = (
  date: string,
  time: string | null,
  market: "cn-equity" | "crypto",
) =>
  Date.parse(
    date.includes("T")
      ? date
      : `${date}T${time || "00:00:00"}${market === "cn-equity" ? "+08:00" : "Z"}`,
  );

function calendarDays(dates: readonly string[]) {
  const ordered = [...new Set(dates.map((d) => d.slice(0, 10)))].sort();
  if (!ordered.length) return [];
  const start = Date.parse(ordered[0]!),
    end = Date.parse(ordered.at(-1)!);
  return Array.from(
    { length: Math.floor((end - start) / 86400000) + 1 },
    (_, i) => new Date(start + i * 86400000).toISOString().slice(0, 10),
  );
}
function paperDailyBars(book: AccountBook, account: string) {
  const state = book.facts.paper.find((p) => p.account.id === account)?.state;
  return Object.fromEntries(
    (state?.request.instruments ?? []).map((i) => {
      const days = new Map<string, Bar>(),
        last = i.bars.at(-1)?.date;
      for (const b of i.bars) {
        const date = b.date.slice(0, 10);
        if (b.date.length > 10 && last && date === last.slice(0, 10)) continue;
        days.set(date, { ...b, date });
      }
      return [i.symbol, [...days.values()]];
    }),
  );
}

/** No remote balance refresh, writes, notification or order calls on this path. */
export async function loadAccountBook(
  repo = new AccountWorkspaceRepository(),
  config = settings(),
  now = Date.now(),
  dependencies: {
    context?: Awaited<ReturnType<typeof tradeContext>>;
    bars?: Record<string, Bar[]>;
    localOnly?: boolean;
  } = {},
) {
  const facts = repo.snapshot(),
    context = dependencies.context ?? (await tradeContext());
  const today = chinaClock(now),
    bars: Record<string, Bar[]> = {};
  const symbols = [
    ...new Set([
      ...facts.fills.map((f) => f.symbol ?? f.code),
      ...facts.local.map((t) => t.symbol),
      ...facts.crypto.flatMap(
        (c) => c.snapshot?.positions.map((p) => p.symbol) ?? [],
      ),
    ]),
  ];
  for (const symbol of symbols) {
    const market = /USDT$/.test(symbol) ? "crypto" : "cn-equity";
    try {
      const result = dependencies.bars
        ? { bars: dependencies.bars[symbol] ?? [] }
        : market === "crypto"
          ? await binanceArchiveSource({
              symbol: `cx${symbol}`,
              period: "day",
              configuredRoot: config.binancePublicDataRoot,
              now,
            })
          : await readBars({
              instrument: { market, symbol },
              root: config.tdxRoot,
              period: "day",
              adjustment: "none",
              ...(dependencies.localOnly
                ? { live: false, source: "local" as const }
                : {}),
            });
      bars[symbol] = (result?.bars ?? []).filter(
        (b) =>
          b.date.slice(0, 10) <
            (market === "crypto"
              ? new Date(now).toISOString().slice(0, 10)
              : today.date) ||
          (market === "cn-equity" &&
            b.date.slice(0, 10) === today.date &&
            today.time >= "15:05"),
      );
    } catch {
      bars[symbol] = [];
    }
  }
  const positions: AccountPosition[] = [],
    trades: AccountTrade[] = [];
  const linkById = new Map(facts.links.map((l) => [l.tradeId, l]));
  const linked = (trade: AccountTrade) => ({
    ...trade,
    ...(() => {
      const l = linkById.get(trade.id);
      return l && l.tradeFingerprint === accountTradeFingerprint(trade)
        ? {
            strategyId: l.strategyId,
            strategyVersion: l.strategyVersion,
            sleeve: l.sleeve,
            planId: l.planId,
            alertKey: l.alertKey,
          }
        : {};
    })(),
  });
  const stopFor = (
    account: string,
    symbol: string,
    activeIds?: readonly string[],
  ) => {
    const buys = trades.filter(
      (t) =>
        t.account === account &&
        t.symbol === symbol &&
        t.side === "buy" &&
        (!activeIds || activeIds.includes(t.id)),
    );
    const identities = new Set(
      buys.map((t) =>
        JSON.stringify([
          t.strategyId,
          t.strategyVersion,
          t.sleeve,
          t.planId,
          t.alertKey,
        ]),
      ),
    );
    const t = identities.size === 1 ? buys.at(-1) : undefined;
    const plan = facts.plans.find((p) => p.id === t?.planId);
    const alert = facts.events.find((e) => e.key === t?.alertKey);
    return { trade: t, stop: plan?.stop ?? alert?.stop ?? null };
  };
  for (const account of [...new Set(facts.batches.map((b) => b.account))]) {
    const fills = facts.fills.filter((f) => f.account === account),
      cashFlows = facts.cashFlows.filter((f) => f.account === account);
    const review = reviewTrades({
      fills,
      cashFlows,
      bars,
      tradingDays: context.calendar,
    });
    for (const f of fills)
      trades.push(
        linked({
          id: `delivery:${f.id}`,
          account,
          kind: "real",
          market: "cn-equity",
          symbol: f.symbol ?? f.code,
          side: f.kind,
          date: f.tradeDate,
          time: tradeTime(f.tradeDate, f.tradeTime, "cn-equity"),
          timePrecision: f.tradeTime ? "instant" : "day",
          sourceOrder: { source: f.batchId, index: f.rowIndex },
          price: f.price,
          quantity: f.quantity,
          strategyId: null,
          strategyVersion: null,
          sleeve: "未知",
          planId: null,
          alertKey: null,
        }),
      );
    for (const p of review.movingAverage.openPositions) {
      const unitUnknown = p.instrument === "convertible";
      const quote = bars[p.security]?.at(-1),
        source = stopFor(
          account,
          p.security,
          p.fillIndices.map((i) => `delivery:${fills[i]!.id}`),
        );
      const events = context.evidence(p.security),
        since = p.openingDate;
      const corporateUnknown =
        !since ||
        !events.coverageEnd ||
        events.coverageEnd < (quote?.date.slice(0, 10) ?? today.date) ||
        events.events.some(
          (e) =>
            e.date > since &&
            e.date <= (quote?.date.slice(0, 10) ?? today.date) &&
            [1, 11, 12].includes(e.category),
        );
      const cost =
        !unitUnknown &&
        !corporateUnknown &&
        !p.openingUnknown &&
        p.remainingCost.value !== null
          ? p.remainingCost.value / p.remainingQuantity
          : null;
      positions.push({
        id: `delivery:${account}:${p.security}`,
        account,
        kind: "real",
        market: "cn-equity",
        currency: "CNY",
        symbol: p.security,
        sleeve: source.trade?.sleeve ?? "未知",
        industry: "未知",
        quantity: p.remainingQuantity,
        cost,
        price: unitUnknown ? null : (quote?.close ?? null),
        value:
          !unitUnknown && !corporateUnknown && quote
            ? p.remainingQuantity * quote.close
            : null,
        stop: source.stop,
        at: quote?.date ?? null,
        strategyId: source.trade?.strategyId ?? null,
        strategyVersion: source.trade?.strategyVersion ?? null,
        reasons: [
          ...(unitUnknown
            ? ["可转债数量/价格单位须在原交割单复盘核对，统一风险估值留空"]
            : []),
          ...(corporateUnknown
            ? ["交割单股份未认证除权/到账，估值与R留空"]
            : []),
          ...(!quote ? ["缺原价日线"] : []),
        ],
      });
    }
  }
  for (const t of facts.local)
    trades.push(
      linked({
        id: `local:${t.id}`,
        account: "手工账本",
        kind: "real",
        market: "cn-equity",
        symbol: t.symbol,
        side: t.side,
        date: t.date,
        time: tradeTime(t.date, null, "cn-equity"),
        timePrecision: "day",
        price: t.price,
        quantity: t.quantity,
        strategyId: null,
        strategyVersion: null,
        sleeve: "未知",
        planId: null,
        alertKey: null,
      }),
    );
  for (const symbol of [...new Set(facts.local.map((t) => t.symbol))]) {
    const quote = bars[symbol]?.at(-1),
      p = positionFor(
        symbol,
        facts.local,
        today.date,
        context.calendar,
        context.evidence(symbol),
        quote ? { price: quote.close, date: quote.date } : null,
      );
    if (p.quantity <= 0) continue;
    let held = 0;
    const activeIds: string[] = [];
    for (const t of facts.local.filter((t) => t.symbol === symbol)) {
      held += t.side === "buy" ? t.quantity : -t.quantity;
      if (t.side === "buy") activeIds.push(`local:${t.id}`);
      if (held === 0) activeIds.length = 0;
    }
    const source = stopFor("手工账本", symbol, activeIds),
      protection = new AlertRepository(repo.db).state<{
        stop: number | null;
        sleeve: string;
      }>(`protection:cn-equity:${symbol}`);
    positions.push({
      id: `local:${symbol}`,
      account: "手工账本",
      kind: "real",
      market: "cn-equity",
      currency: "CNY",
      symbol,
      sleeve:
        source.trade?.sleeve !== "未知"
          ? (source.trade?.sleeve ?? "未知")
          : (protection?.sleeve ?? "未知"),
      industry: "未知",
      quantity: p.quantity,
      cost: p.adjustedCost,
      price: quote?.close ?? null,
      value: quote ? p.quantity * quote.close : null,
      stop: source.stop ?? protection?.stop ?? p.stop,
      at: quote?.date ?? null,
      strategyId: source.trade?.strategyId ?? null,
      strategyVersion: source.trade?.strategyVersion ?? null,
      reasons: ["手工账本独立于导入账户；请勿将同一成交重复登记到两个账户"],
    });
  }
  for (const { account, state } of facts.paper) {
    if (!state) continue;
    for (const [i, f] of state.result.fills.entries()) {
      const strategy = account.candidates.find(
        (c) => c.strategy.id === f.strategyId,
      )?.strategy;
      const event = facts.events.find(
        (e) => e.paperFillId === `${account.id}:${i}`,
      );
      trades.push({
        id: `paper:${account.id}:${i}`,
        account: account.id,
        kind: "paper",
        market: account.market,
        symbol: f.symbol,
        side: f.side,
        date: f.date,
        time: tradeTime(f.date, null, account.market),
        price: f.price,
        quantity: f.quantity,
        strategyId: f.strategyId,
        strategyVersion: strategy?.version ?? null,
        sleeve: f.sleeve,
        planId: event?.planId ?? null,
        alertKey: event?.key ?? null,
      });
    }
    for (const p of state.result.positions) {
      const strategy = account.candidates.find(
        (c) => c.strategy.id === p.strategyId,
      )?.strategy;
      const last = state.decisions
        .filter((d) => d.strategyId === p.strategyId && d.symbol === p.symbol)
        .at(-1);
      positions.push({
        id: `paper:${account.id}:${p.key}`,
        account: account.id,
        kind: "paper",
        market: account.market,
        currency: account.currency,
        symbol: p.symbol,
        sleeve: p.sleeve,
        industry: "未知",
        quantity: p.quantity,
        cost: p.quantity > 0 ? p.cost / p.quantity : null,
        price: p.mark,
        value: p.mark * p.quantity,
        stop: last?.stop ?? null,
        at: account.lastBar,
        strategyId: p.strategyId,
        strategyVersion: strategy?.version ?? null,
        reasons: ["本地模拟记账；不代表场所成交"],
      });
    }
  }
  for (const c of facts.crypto) {
    for (const t of c.trades)
      trades.push(
        linked({
          id: `crypto:${c.bot.id}:${c.revision}:${t.symbol}:${t.orderId}:${t.id}`,
          account: c.bot.id,
          kind: "exchange-simulation",
          market: "crypto",
          symbol: t.symbol,
          side: t.side === "BUY" ? "buy" : "sell",
          date: new Date(t.time).toISOString(),
          time: t.time,
          timePrecision: "instant",
          price: Number(t.price),
          quantity: Number(t.quantity),
          strategyId: null,
          strategyVersion: null,
          sleeve: "未知",
          planId: null,
          alertKey: null,
        }),
      );
    for (const p of c.snapshot?.positions ?? []) {
      if (Number(p.total) <= 0) continue;
      const source = stopFor(c.bot.id, p.symbol),
        protection = new AlertRepository(repo.db).state<{
          stop: number | null;
          sleeve: string;
        }>(`protection:crypto:${c.bot.id}:${p.symbol}`);
      positions.push({
        id: `crypto:${c.bot.id}:${p.symbol}`,
        account: c.bot.id,
        kind: "exchange-simulation",
        market: "crypto",
        currency: "USDT",
        symbol: p.symbol,
        sleeve: source.trade?.sleeve ?? protection?.sleeve ?? "未知",
        industry: "数字货币",
        quantity: Number(p.total),
        cost: null,
        price: p.price === null ? null : Number(p.price),
        value: p.marketValue === null ? null : Number(p.marketValue),
        stop: source.stop ?? protection?.stop ?? null,
        at: new Date(c.snapshot!.at).toISOString(),
        strategyId: source.trade?.strategyId ?? null,
        strategyVersion: source.trade?.strategyVersion ?? null,
        reasons: ["模拟钱包全部余额；历史覆盖不证明期初成本，R留空"],
      });
    }
  }
  const industryBySymbol = new Map<string, string[]>();
  let industrySource: {
    hash: string;
    basis: "current-labelled";
    grouping: "all-known-groups";
  } | null = null;
  if (config.industryBlocksRoot) {
    try {
      const blocks = await readIndustryBlocks(config.industryBlocksRoot);
      industrySource = {
        hash: blocks.hash,
        basis: "current-labelled",
        grouping: "all-known-groups",
      };
      for (const file of blocks.files)
        for (const symbol of file.members)
          industryBySymbol.set(symbol, [
            ...new Set([...(industryBySymbol.get(symbol) ?? []), file.name]),
          ]);
    } catch {
      /* Missing classification is surfaced on each position and cap check. */
    }
  }
  for (const p of positions.filter((p) => p.market === "cn-equity")) {
    const industries = industryGroupsFor({
      industryGroups: industryBySymbol.get(p.symbol) ?? [],
    });
    p.industryGroups = industries;
    p.industry = industries.join("、") || "未知";
    p.reasons.push(
      industries.length
        ? "行业组为当前Blocks成分，各已知组分别校验，不代表历史归属"
        : "行业组缺失，无法确认行业组敞口",
    );
  }
  for (const p of positions.filter((p) => p.market === "crypto"))
    p.industryGroups = industryGroupsFor(p);
  repo.assertVersion(facts.version);
  return {
    facts,
    positions,
    trades,
    bars,
    calendar: context.calendar,
    context,
    config,
    industryBySymbol,
    industrySource,
  };
}

export function pageAccountBook(book: AccountBook, raw: unknown) {
  const input = accountPageSchema.parse(raw);
  const positions = book.positions
    .filter(
      (p) =>
        (input.kind === "all" || p.kind === input.kind) &&
        (input.market === "all" || p.market === input.market) &&
        (!input.sleeve || p.sleeve === input.sleeve),
    )
    .sort(
      (a, b) =>
        String(a[input.group]).localeCompare(String(b[input.group])) ||
        a.account.localeCompare(b.account) ||
        a.id.localeCompare(b.id),
    );
  const totals = (["CNY", "USDT"] as const).map((currency) => {
    const rows = positions.filter((p) => p.currency === currency);
    return {
      currency,
      count: rows.length,
      value: rows.every((p) => p.value !== null)
        ? rows.reduce((n, p) => n + p.value!, 0)
        : null,
      missing: rows.filter((p) => p.value === null).length,
    };
  });
  const groupNames = (
    position: AccountPosition,
    dimension: "market" | "sleeve" | "industry",
  ) => {
    if (dimension !== "industry") return [position[dimension]];
    const names = industryGroupsFor(position);
    return names.length ? names : ["未知"];
  };
  const exposure = (["market", "sleeve", "industry"] as const).flatMap(
    (dimension) =>
      [
        ...new Set(
          positions.flatMap((p) =>
            groupNames(p, dimension).map((group) => `${p.currency}:${group}`),
          ),
        ),
      ].map((key) => {
        const rows = positions.filter((p) =>
          groupNames(p, dimension).some(
            (group) => `${p.currency}:${group}` === key,
          ),
        );
        return {
          dimension,
          overlapping: dimension === "industry",
          key,
          value: rows.every((p) => p.value !== null)
            ? rows.reduce((n, p) => n + p.value!, 0)
            : null,
        };
      }),
  );
  return {
    total: positions.length,
    totals,
    exposure,
    industrySource: book.industrySource,
    items: positions
      .slice(input.page * 20, (input.page + 1) * 20)
      .map((p) => ({ ...p, ...positionMetrics(p) })),
    missingAccounts: book.facts.crypto
      .filter((c) => !c.snapshot)
      .map((c) => `${c.bot.id} 尚无完整钱包快照`),
  };
}

export function validateAccountTradeLink(raw: unknown, book: AccountBook) {
  const input = tradeLinkSchema.parse(raw),
    trade = book.trades.find((t) => t.id === input.tradeId);
  if (!trade || trade.kind === "paper")
    throw new Error("成交不存在或纸面归属由记账事实固定");
  const strategy = book.facts.definitions.find(
    (s) => s.id === input.strategyId && s.version === input.strategyVersion,
  );
  if (
    !strategy ||
    strategy.market !== trade.market ||
    strategy.sleeve !== input.sleeve
  )
    throw new Error("策略市场、版本或分仓不符");
  const plan = input.planId
    ? book.facts.plans.find((p) => p.id === input.planId)
    : null;
  const event = input.alertKey
    ? book.facts.events.find((e) => e.key === input.alertKey)
    : null;
  if (
    input.planId &&
    (!plan ||
      plan.symbol !== trade.symbol ||
      plan.strategyId !== input.strategyId ||
      plan.strategyVersion !== input.strategyVersion ||
      plan.createdAt === undefined ||
      plan.createdAt > trade.time)
  )
    throw new Error("计划标的、版本或创建时间不符");
  if (
    input.alertKey &&
    (!event ||
      event.symbol !== trade.symbol ||
      event.strategyId !== input.strategyId ||
      event.version !== input.strategyVersion ||
      event.observedAt > trade.time)
  )
    throw new Error("提醒标的、版本或观察时间不符");
  if (
    trade.side === "buy" &&
    plan?.expiresAt &&
    trade.time > Date.parse(plan.expiresAt)
  )
    throw new Error("成交超出计划有效期，不能继承该计划保护");
  if (plan && event && plan.triggerKey !== event.key)
    throw new Error("计划与提醒来源冲突");
  return { input, trade, plan };
}
export function persistAccountTradeLink(
  validated: ReturnType<typeof validateAccountTradeLink>,
  book: AccountBook,
  repo: AccountWorkspaceRepository,
  linkedAt: number,
) {
  const { input, trade, plan } = validated;
  const link = repo.link({
    ...input,
    linkedAt,
    tradeFingerprint: accountTradeFingerprint(trade),
  });
  if (plan)
    bindHoldingProtection(
      { ...trade, ...input },
      plan,
      book,
      new HoldingProtectionRepository(repo.db),
      linkedAt,
    );
  return link;
}
export function linkAccountTrade(
  raw: unknown,
  book: AccountBook,
  repo = new AccountWorkspaceRepository(),
) {
  const validated = validateAccountTradeLink(raw, book);
  return repo.atomic(() => {
    repo.assertVersion(book.facts.version);
    return persistAccountTradeLink(validated, book, repo, Date.now());
  });
}

/** Comparable entry cohort: entry price -> 20th market-day close, gross/raw.
 * This deliberately measures selection, not strategy/account realized P&L. */
export function entryCohortReturn(
  symbol: string,
  date: string,
  price: number,
  bars: Record<string, readonly Bar[]>,
  calendar: readonly string[],
  events: readonly { date: string; category: number }[],
  coverage: string | null,
  market: "cn-equity" | "crypto",
) {
  const day = date.slice(0, 10),
    index = calendar.indexOf(day),
    target = calendar[index + 19];
  if (index < 0 || !target || !(price > 0)) return null;
  if (
    market === "cn-equity" &&
    (!coverage ||
      coverage < target ||
      events.some(
        (e) =>
          e.date > day && e.date <= target && [1, 11, 12].includes(e.category),
      ))
  )
    return null;
  const candidates = (bars[symbol] ?? []).filter(
    (b) => b.date.slice(0, 10) === target,
  );
  return candidates.length === 1 && candidates[0]!.close > 0
    ? candidates[0]!.close / price - 1
    : null;
}

export function accountAttribution(
  book: AccountBook,
  strategyId?: string,
  version?: number,
) {
  const defs = book.facts.definitions.filter(
    (s) =>
      (!strategyId || s.id === strategyId) &&
      (version === undefined || s.version === version),
  );
  const cohorts = defs.map((s) => {
    const unavailable = book.facts.expectationStatuses.find(
      (e) =>
        e.definitionHash === forwardDefinitionHash(s) &&
        e.status === "unavailable",
    );
    const expected = unavailable
      ? undefined
      : book.facts.expectations.find(
          (e) =>
            e.strategyId === s.id &&
            e.version === s.version &&
            e.strategyHash === strategyHash(s),
        );
    const alerts = book.facts.events
      .filter(
        (e) =>
          e.strategyId === s.id &&
          e.version === s.version &&
          e.type === "entry",
      )
      .flatMap((e) =>
        e.outcomes
          .filter((o) => o.horizon === 20 && o.settled && o.returnPct !== null)
          .map((o) => o.returnPct! / 100),
      );
    const samples = (kind: AccountTrade["kind"]) =>
      book.trades
        .filter(
          (t) =>
            t.kind === kind &&
            t.side === "buy" &&
            t.strategyId === s.id &&
            t.strategyVersion === s.version,
        )
        .flatMap((t) => {
          if (
            t.id.startsWith("delivery:") &&
            book.facts.fills.find((f) => `delivery:${f.id}` === t.id)
              ?.instrument === "convertible"
          )
            return [];
          let bars = book.bars,
            calendar = book.calendar,
            coverage = book.context.evidence(t.symbol).coverageEnd,
            actions = book.context.evidence(t.symbol).events;
          if (kind === "paper") {
            const paper = book.facts.paper.find(
              (p) => p.account.id === t.account,
            );
            bars = paperDailyBars(book, t.account);
            calendar = [
              ...new Set(
                paper?.state?.request.calendar.map((d) => d.slice(0, 10)) ?? [],
              ),
            ];
            // Crypto has no equity corporate actions. A-share proof remains required.
          }
          if (t.market === "crypto")
            calendar = calendarDays((bars[t.symbol] ?? []).map((b) => b.date));
          const value = entryCohortReturn(
            t.symbol,
            t.date,
            t.price,
            bars,
            calendar,
            actions,
            coverage,
            t.market,
          );
          return value === null ? [] : [value];
        });
    const paper = samples("paper"),
      actual = samples("real"),
      simulation = samples("exchange-simulation"),
      values = expected?.samples ?? [];
    return {
      observations: { alerts, paper, actual, simulation },
      strategyId: s.id,
      version: s.version,
      sleeve: s.sleeve,
      market: s.market,
      expected: expected ?? null,
      expectationReason: expected
        ? null
        : (unavailable?.reason ?? "缺少已选择验证来源的同参数二十日冻结分布"),
      alerts: decayFlag(values, alerts, book.config.accountReview),
      paper: decayFlag(values, paper, book.config.accountReview),
      actual: decayFlag(values, actual, book.config.accountReview),
      simulation: decayFlag(values, simulation, book.config.accountReview),
      flagged: [alerts, paper, actual].some(
        (v) => decayFlag(values, v, book.config.accountReview).flagged,
      ),
      basis:
        "入场后第20个市场日收盘/入场价−1；原价无费用，选择归因，非策略净业绩。提醒T+1开盘；实际/纸面用实际入场价。",
    };
  });
  const rows = cohorts.map(({ observations: _observations, ...row }) => row);
  if (strategyId) return rows;
  for (const key of [
    ...new Set(cohorts.map((r) => `${r.market}:${r.sleeve}`)),
  ]) {
    const members = cohorts.filter((r) => `${r.market}:${r.sleeve}` === key),
      first = members[0]!;
    const complete = members.every((r) => r.expected !== null);
    const values = complete ? members.flatMap((r) => r.expected!.samples) : [];
    const observations = {
      alerts: members.flatMap((r) => r.observations.alerts),
      paper: members.flatMap((r) => r.observations.paper),
      actual: members.flatMap((r) => r.observations.actual),
      simulation: members.flatMap((r) => r.observations.simulation),
    };
    rows.push({
      ...first,
      strategyId: `分仓合计 ${first.sleeve}`,
      version: 0,
      expectationReason: complete ? null : "部分分仓成员缺少可核验冻结分布",
      expected: complete
        ? {
            ...first.expected!,
            samples: values,
            source: `同分仓${members.length}个策略版本的同期限入场样本`,
            excluded: members.reduce((n, r) => n + r.expected!.excluded, 0),
          }
        : null,
      alerts: decayFlag(values, observations.alerts, book.config.accountReview),
      paper: decayFlag(values, observations.paper, book.config.accountReview),
      actual: decayFlag(values, observations.actual, book.config.accountReview),
      simulation: decayFlag(
        values,
        observations.simulation,
        book.config.accountReview,
      ),
      flagged: [
        observations.alerts,
        observations.paper,
        observations.actual,
      ].some((v) => decayFlag(values, v, book.config.accountReview).flagged),
      basis:
        "同分仓同期限入场样本等权合并，非账户收益相加；相关/重叠样本不宣称独立。缺任一成员的同参数分布则整体不判衰减。",
    });
  }
  return rows;
}

export function accountPositionDetail(
  book: AccountBook,
  id: string,
  tradePage = 0,
) {
  const position = book.positions.find((p) => p.id === id);
  if (!position) throw new Error("持仓不存在，请刷新账户");
  const trades = book.trades
    .filter(
      (t) => t.account === position.account && t.symbol === position.symbol,
    )
    .filter((t) => t.id.split(":", 1)[0] === position.id.split(":", 1)[0])
    .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  const attribution = accountAttribution(
    book,
    position.strategyId ?? undefined,
    position.strategyVersion ?? undefined,
  );
  const symbols = book.positions
    .filter((p) => p.market === position.market && p.kind === position.kind)
    .map((p) => p.symbol);
  let correlationBars = book.bars;
  if (position.kind === "paper")
    correlationBars = paperDailyBars(book, position.account);
  const calendar =
    position.market === "crypto"
      ? calendarDays(
          symbols.flatMap((s) => (correlationBars[s] ?? []).map((b) => b.date)),
        )
      : book.calendar;
  const quantities = Object.fromEntries(
    book.positions
      .filter((p) => symbols.includes(p.symbol))
      .map((p) => [p.symbol, p.quantity]),
  );
  const days = calendar
    .slice(-61)
    .map((date) => ({ date, positions: quantities }));
  const correlation = pageHoldingsCorrelation(
    { days, tradingDays: calendar, bars: correlationBars },
    {
      pageIndex: Math.floor(
        [...new Set(symbols)].sort().indexOf(position.symbol) / 20,
      ),
      pageSize: 20,
      desc: false,
    },
  );
  const imported = book.facts.fills.filter(
    (f) => f.account === position.account,
  );
  const nav =
    imported.length && imported.every((f) => f.instrument !== "convertible")
      ? reviewTradeNav({
          fills: imported,
          cashFlows: book.facts.cashFlows.filter(
            (f) => f.account === position.account,
          ),
          bars: book.bars,
          tradingDays: book.calendar,
        })
      : null;
  const concentration = pagePositionRisk(nav?.days ?? [], {
    pageIndex: 0,
    pageSize: 10,
    sort: "date",
    desc: true,
  });
  const selected = trades.slice(tradePage * 20, (tradePage + 1) * 20);
  return {
    position: { ...position, ...positionMetrics(position) },
    trades: selected.map((t) => tradeSource(t, book)),
    tradeCount: trades.length,
    attribution,
    correlation,
    concentration,
    suggestions: selected.map((t) => ({
      tradeId: t.id,
      plans: book.facts.plans
        .filter(
          (p) =>
            p.symbol === t.symbol &&
            p.market === t.market &&
            p.createdAt !== undefined &&
            p.createdAt <= t.time &&
            t.time - p.createdAt <= 7 * 86400000,
        )
        .slice(0, 10),
    })),
  };
}

export function accountTradePage(
  book: AccountBook,
  input: {
    page: number;
    kind: "real" | "paper" | "exchange-simulation" | "all";
    symbol: string;
    tradeId?: string;
  },
) {
  const trades = book.trades
    .filter(
      (t) =>
        (input.kind === "all" || t.kind === input.kind) &&
        (!input.symbol || t.symbol.includes(input.symbol)) &&
        (!input.tradeId || t.id === input.tradeId),
    )
    .sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  const selected = trades.slice(input.page * 20, (input.page + 1) * 20);
  return {
    trades: selected.map((t) => tradeSource(t, book)),
    tradeCount: trades.length,
    suggestions: selected.map((t) => ({
      tradeId: t.id,
      plans: book.facts.plans
        .filter(
          (p) =>
            p.symbol === t.symbol &&
            p.market === t.market &&
            p.createdAt !== undefined &&
            p.createdAt <= t.time &&
            t.time - p.createdAt <= 7 * 86400000,
        )
        .slice(0, 10),
    })),
  };
}
