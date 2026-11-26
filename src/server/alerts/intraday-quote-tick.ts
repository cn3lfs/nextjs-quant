import { beijingClock } from "~/lib/market/market-session";
import {
  activeHoldingRound,
  holdingProtectionCurrent,
  protectionPositionKey,
  type HoldingProtectionProjection,
} from "~/lib/portfolio/holding-protection";
import type {
  IntradayAlertConfig,
  IntradayAlertStatus,
  IntradayHoldingPreview,
  IntradayTriggerEvent,
  IntradayWatchRule,
} from "~/lib/strategy-facts/intraday-alerts";
import {
  alertKey,
  type AlertEvent,
  type AlertKind,
} from "~/lib/strategy-facts/alerts";
import { AccountWorkspaceRepository } from "../db/account-workspace-repository";
import type { AlertRepository } from "../db/alert-repository";
import { HoldingProtectionRepository } from "../db/holding-protection-repository";
import { markIntradayWatchRuleTriggered } from "../db/intraday-alert-config-repository";
import { settings } from "../infra/settings";
import type { OverviewQuote } from "../market/overview-quotes";
import { knownCnSession } from "../pipeline/cn-trading-calendar";
import { loadAccountBook } from "../portfolio/account-workspace/load-book";
import { systemWatch } from "./inputs/context";

type Kind = IntradayTriggerEvent["triggerKind"];
type Condition = {
  symbol: string;
  kind: Kind;
  threshold: number;
  label: string;
  ruleId?: string;
  planId?: string;
  createdAt?: number;
  expiresAt?: number;
};
type Holding = Pick<
  IntradayHoldingPreview,
  "positionId" | "account" | "kind" | "symbol" | "stopPrice" | "targetPrice"
>;
export type QuoteMark = { price: number; quoteAt: number | null };
const symbols = /^(?:sh|sz|bj)\d{6}$/;
const positive = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n > 0;

export function localTradingDay(date: string, repo: AlertRepository) {
  const official = knownCnSession(repo.db, date);
  if (official !== null) return official;
  const days = repo.records.days();
  if (days.includes(date)) return true;
  return days.some((d) => d < date) && days.some((d) => d > date)
    ? false
    : null;
}

export function sessionAt(
  now: number,
  repo: AlertRepository,
  allowUnconfirmedDay = false,
): IntradayAlertStatus["session"] {
  const { date, weekday } = beijingClock(now);
  const offset = now - Date.parse(date + "T00:00:00+08:00");
  if (
    weekday === 0 ||
    weekday === 6 ||
    offset < 565 * 60_000 ||
    offset > 900 * 60_000
  )
    return "closed";
  const day = localTradingDay(date, repo);
  if (day === false || (day === null && !allowUnconfirmedDay)) return "closed";
  return offset > 690 * 60_000 && offset < 780 * 60_000
    ? "lunch-break"
    : "trading";
}

export function quoteMark(q: OverviewQuote): QuoteMark | undefined {
  if (!positive(q.price)) return;
  // Tencent supplies Beijing date and time. A TDX time of day alone cannot prove today's trade.
  const stamp =
    q.quoteTime && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(q.quoteTime)
      ? Date.parse(q.quoteTime.replace(" ", "T") + "+08:00")
      : NaN;
  return { price: q.price, quoteAt: Number.isFinite(stamp) ? stamp : null };
}
export function isFresh(mark: QuoteMark, now: number) {
  if (
    mark.quoteAt === null ||
    mark.quoteAt > now ||
    now - mark.quoteAt > 300_000
  )
    return false;
  const at = beijingClock(mark.quoteAt);
  return (
    at.date === beijingClock(now).date &&
    ((at.hhmm >= "09:25" && at.hhmm <= "11:30") ||
      (at.hhmm >= "13:00" && at.hhmm <= "15:00"))
  );
}

async function readHoldings(
  repo: AlertRepository,
  now: number,
): Promise<Holding[]> {
  const book = await loadAccountBook(
    new AccountWorkspaceRepository(repo.db),
    settings(),
    now,
    { bars: {}, localOnly: true },
  );
  const bindings = new Map(
    new HoldingProtectionRepository(repo.db).all().map((b) => [b.id, b]),
  );
  const holdings: Holding[] = [];
  for (const p of book.positions) {
    if (p.market !== "cn-equity" || p.quantity <= 0 || !symbols.test(p.symbol))
      continue;
    const binding = bindings.get(
      protectionPositionKey(p.kind, p.account, p.market, p.symbol),
    );
    let stopPrice = p.stop,
      targetPrice: number | null = null;
    if (binding) {
      if (
        binding.protection.version !== "plan-protection-1" ||
        !holdingProtectionCurrent(binding, book.trades)
      )
        continue;
      const previous = repo.state<HoldingProtectionProjection>(
        `holding-protection:${binding.id}`,
      );
      stopPrice =
        previous?.bindingAt === binding.boundAt
          ? (previous.task.newStop ??
            previous.backupStop ??
            binding.protection.initialStop)
          : binding.protection.initialStop;
      targetPrice = binding.protection.target;
    } else if (p.kind === "real" && p.account === "手工账本") {
      targetPrice =
        repo.state<{ target: number | null }>(
          `protection:cn-equity:${p.symbol}`,
        )?.target ?? null;
    } else if (p.kind === "local-sim") {
      // v26 local-sim fills carry planId; the legacy binding table cannot store this account kind.
      const round = activeHoldingRound(book.trades, p);
      const plans = new Set(
        round.trades.filter((t) => t.side === "buy").map((t) => t.planId),
      );
      if (!round.ambiguous && plans.size === 1) {
        const [id] = plans;
        const plan = book.facts.plans.find(
          (item) => item.id === id && item.symbol === p.symbol,
        );
        stopPrice = plan?.stop ?? stopPrice;
        targetPrice = plan?.target ?? null;
      }
    }
    if (!positive(stopPrice) && !positive(targetPrice)) continue;
    holdings.push({
      positionId: p.id,
      account: p.account,
      kind: p.kind,
      symbol: p.symbol,
      stopPrice: positive(stopPrice) ? stopPrice : null,
      targetPrice: positive(targetPrice) ? targetPrice : null,
    });
  }
  return holdings;
}

export async function monitorTargets(
  repo: AlertRepository,
  config: IntradayAlertConfig,
  rules: IntradayWatchRule[],
  now: number,
) {
  const holdings = config.monitorHoldingsStops
    ? await readHoldings(repo, now)
    : [];
  const conditions: Condition[] = [];
  for (const p of holdings) {
    const label = `持仓 ${p.account}`;
    if (p.stopPrice !== null)
      conditions.push({
        symbol: p.symbol,
        kind: "stop_loss",
        threshold: p.stopPrice,
        label,
      });
    if (p.targetPrice !== null)
      conditions.push({
        symbol: p.symbol,
        kind: "take_profit",
        threshold: p.targetPrice,
        label,
      });
  }
  if (config.monitorPlannedEntries) {
    for (const plan of repo.plans(true)) {
      const market =
        plan.market ??
        repo.strategies.strategy(plan.strategyId, plan.strategyVersion)?.market;
      if (
        market !== "cn-equity" ||
        !symbols.test(plan.symbol) ||
        (plan.expiresAt && Date.parse(plan.expiresAt) <= now) ||
        (plan.createdAt && plan.createdAt > now)
      )
        continue;
      const finished = repo.state<number[]>(`plan-stages:${plan.id}`) ?? [];
      for (const [i, stage] of (
        plan.stages ?? [{ entry: plan.entry }]
      ).entries()) {
        if (!finished.includes(i))
          conditions.push({
            symbol: plan.symbol,
            kind: "planned_entry",
            threshold: stage.entry,
            planId: plan.id,
            createdAt: plan.createdAt,
            expiresAt: plan.expiresAt ? Date.parse(plan.expiresAt) : undefined,
            label: `计划 ${plan.id} 第 ${i + 1} 档`,
          });
      }
    }
  }
  const today = beijingClock(now).date;
  if (config.monitorWatchlistRules) {
    for (const r of rules) {
      const symbol = r.symbol.trim().toLowerCase();
      if (
        r.enabled &&
        symbols.test(symbol) &&
        (!r.lastTriggeredDate || r.lastTriggeredDate < today)
      )
        conditions.push({
          symbol,
          kind: r.direction === "above" ? "watch_above" : "watch_below",
          threshold: r.thresholdPrice,
          ruleId: r.id,
          label: r.note || "自定义价格",
        });
    }
  }
  return {
    holdings,
    conditions,
    symbols: [...new Set(conditions.map((c) => c.symbol))],
  };
}

const subscriptionKind: Record<Kind, AlertKind> = {
  stop_loss: "stop",
  take_profit: "target",
  planned_entry: "plan-entry",
  watch_above: "regime",
  watch_below: "regime",
};

/** Caller holds an IMMEDIATE transaction for the daily claim, watch row and subscription outbox. */
export function recordQuoteTrigger(
  repo: AlertRepository,
  c: Condition,
  mark: QuoteMark,
  source: string,
  now: number,
  mode: "shadow" | "live",
  deliver: (event: AlertEvent) => void,
): IntradayTriggerEvent | null {
  if (!isFresh(mark, now)) return null;
  if (
    (c.expiresAt !== undefined && now >= c.expiresAt) ||
    (c.createdAt !== undefined && mark.quoteAt! < c.createdAt)
  )
    return null;
  const below = c.kind === "stop_loss" || c.kind === "watch_below";
  if (below ? mark.price > c.threshold : mark.price < c.threshold) return null;
  const date = beijingClock(now).date;
  if (c.ruleId && !markIntradayWatchRuleTriggered(c.ruleId, date, repo.db))
    return null;
  const dailyKey = ["intraday", date, c.symbol, c.kind, c.threshold].join(":");
  if (repo.state(dailyKey)) return null;
  // Native watch keys include observed price. Claim the price-independent condition as well.
  const strategy = systemWatch(
    `intraday-${c.kind}-${c.symbol}-${c.threshold}`,
    "cn-equity",
    c.symbol,
  );
  const identity = {
    strategyId: strategy.id,
    version: strategy.version,
    market: strategy.market,
    symbol: c.symbol,
    bar: date,
    type: subscriptionKind[c.kind],
    price: mark.price,
  };
  const eventKey = alertKey(identity);
  const observation: IntradayTriggerEvent = {
    alertKey: dailyKey,
    eventKey,
    symbol: c.symbol,
    triggerKind: c.kind,
    thresholdPrice: c.threshold,
    price: mark.price,
    priceBasis: "intraday_quote",
    source,
    quoteAt: mark.quoteAt!,
    observedAt: now,
    mode,
  };
  const event: AlertEvent & IntradayTriggerEvent = {
    ...identity,
    ...observation,
    key: eventKey,
    status: mode,
    sleeve: strategy.sleeve,
    stop: c.kind === "stop_loss" ? c.threshold : null,
    target: c.kind === "take_profit" ? c.threshold : null,
    planId: c.planId,
    reason: `${c.label} · 盘中实时报价 ${mark.price} ${below ? "≤" : "≥"} ${c.threshold}`,
    outcomes: [],
    wouldSend: true,
  };
  const inserted = repo.record(strategy, event, deliver);
  repo.saveState(dailyKey, eventKey);
  return inserted ? observation : null;
}
