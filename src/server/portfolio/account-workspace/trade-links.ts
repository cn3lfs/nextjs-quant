import {
  tradeLinkSchema,
  accountTradeFingerprint,
} from "~/lib/portfolio/account-workspace";
import { AccountWorkspaceRepository } from "../../db/account-workspace-repository";
import { bindHoldingProtection } from "../holding-protection-link";
import { HoldingProtectionRepository } from "../../db/holding-protection-repository";
import { type AccountBook } from "./load-book";

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
