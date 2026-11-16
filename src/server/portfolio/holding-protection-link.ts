import type { AccountBook } from "./account-workspace-service";
import type { AccountTrade } from "~/lib/portfolio/account-workspace";
import {
  activeHoldingRound,
  holdingTradeFingerprint,
  protectionPositionKey,
} from "~/lib/portfolio/holding-protection";
import { HoldingProtectionRepository } from "../db/holding-protection-repository";
import type { TradePlan } from "../db/strategy-repository";

export function bindHoldingProtection(
  trade: AccountTrade,
  plan: TradePlan,
  book: AccountBook,
  repo: HoldingProtectionRepository,
  now: number,
) {
  const trades = book.trades.map((t) => (t.id === trade.id ? trade : t));
  const round = activeHoldingRound(trades, trade);
  const active = round.trades;
  if (!active.some((t) => t.id === trade.id)) return;
  const same = active
    .filter((t) => t.side === "buy")
    .every(
      (t) =>
        t.planId === plan.id &&
        t.strategyId === plan.strategyId &&
        t.strategyVersion === plan.strategyVersion,
    );
  const protection = plan.protection ?? {
    version: "unavailable" as const,
    reason: "旧计划未提供完整退出规格",
  };
  const buys = active.filter((t) => t.side === "buy");
  return repo.save({
    id: protectionPositionKey(
      trade.kind,
      trade.account,
      trade.market,
      trade.symbol,
    ),
    kind: trade.kind,
    account: trade.account,
    market: trade.market,
    symbol: trade.symbol,
    strategyId: plan.strategyId,
    version: plan.strategyVersion,
    planId: plan.id,
    sleeve: plan.sleeve,
    trades: active.map((t) => ({
      id: t.id,
      fingerprint: holdingTradeFingerprint(t),
    })),
    entryDate: buys[0]!.date,
    entryTime: buys[0]!.timePrecision === "instant" ? buys[0]!.time : null,
    entryPrice: Math.max(
      ...buys.filter((t) => t.time === buys[0]!.time).map((t) => t.price),
    ),
    boundAt: now,
    protection,
    status:
      !round.ambiguous && same && protection.version === "plan-protection-1"
        ? "active"
        : "needs-review",
    reason: round.ambiguous
      ? "同时间买卖缺少可核验来源行序，持仓轮次未知，须人工核验"
      : !same
        ? "同账户持仓来自不同或未关联计划，请统一核验保护"
        : protection.version === "unavailable"
          ? protection.reason
          : null,
  });
}
