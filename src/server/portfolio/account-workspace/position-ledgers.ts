import {
  accountTradeFingerprint,
  type AccountPosition,
  type AccountTrade,
} from "~/lib/portfolio/account-workspace";
import { AccountWorkspaceRepository } from "../../db/account-workspace-repository";

export type AccountFacts = ReturnType<AccountWorkspaceRepository["snapshot"]>;
export const tradeTime = (
  date: string,
  time: string | null,
  market: "cn-equity" | "crypto",
) =>
  Date.parse(
    date.includes("T")
      ? date
      : `${date}T${time || "00:00:00"}${market === "cn-equity" ? "+08:00" : "Z"}`,
  );

export function createPositionLedgers(facts: AccountFacts) {
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

  return { positions, trades, linked, stopFor };
}
export type PositionLedgers = ReturnType<typeof createPositionLedgers>;
