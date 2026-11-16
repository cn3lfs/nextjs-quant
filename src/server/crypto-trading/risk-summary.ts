import { AlertRepository } from "../db/alert-repository";
import { settings } from "../infra/settings";
import type { Settings } from "~/lib/domain";
import type { BotState } from "./model";
import type { AccountSnapshot } from "./account-model";

/** Strategy inventory is valued separately; wallet totals must never be added to it. */
export function cryptoRiskSummary(
  repo = new AlertRepository(),
  config: Settings = settings(),
) {
  const bots = repo.records.all<BotState>("crypto-bot").map((bot) => {
    const revision = repo.records.read<string>(
      `crypto-account-credential-revision-${bot.id}`,
    );
    const snapshot = revision
      ? repo.records.read<AccountSnapshot>(
          `crypto-account-snapshot-${bot.id}-${revision}`,
        )
      : undefined;
    const holdings = Object.entries(bot.positions)
      .filter(([, quantity]) => Number(quantity) > 0)
      .map(([symbol, quantity]) => {
        const price =
          snapshot?.positions.find((p) => p.symbol === symbol)?.price ?? null;
        return {
          symbol,
          quantity: Number(quantity),
          value:
            price !== null && Number.isFinite(Number(price))
              ? Number(quantity) * Number(price)
              : null,
        };
      });
    return {
      id: bot.id,
      status: bot.status,
      validated: false as const,
      exposure: holdings.every((h) => h.value !== null)
        ? holdings.reduce((n, h) => n + h.value!, 0)
        : null,
      holdings,
      at: snapshot?.at ?? bot.updatedAt,
    };
  });
  const breakout = config.alerts.sleeves.find(
    (s) => s.market === "crypto" && s.id === "breakout",
  );
  const qualified = repo.definitions().filter((s) => {
    const qualification = repo.records.read<{
      status: string;
      strategyVersion?: number;
    }>(`strategy-qualification-${s.id}`);
    return (
      s.market === "crypto" &&
      s.sleeve === "breakout" &&
      qualification?.status === "live-candidate" &&
      (qualification.strategyVersion ?? 1) === s.version
    );
  });
  return {
    bots,
    breakout: {
      share: breakout?.share ?? 0,
      budget: config.alerts.capital.crypto * (breakout?.share ?? 0),
      idle: qualified.length === 0,
    },
    basis:
      "机器人库存单列，未通过现行策略验证；不与模拟钱包或已验证分仓重复相加",
  };
}
