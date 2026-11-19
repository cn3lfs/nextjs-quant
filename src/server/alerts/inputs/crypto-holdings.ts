import { readRecordSnapshot } from "../../db";
import { AlertRepository } from "../../db/alert-repository";
import { type HoldingProtection } from "../observations";
import { type BotState } from "../../crypto-trading/model";
import { type AlertInputContext } from "./context";

export function readCryptoBots(market: AlertInputContext["market"]) {
  return market === "crypto"
    ? readRecordSnapshot("crypto-bot", (rows: Iterable<BotState>) => [...rows])
    : [];
}
export async function watchCryptoHoldings(
  repo: AlertRepository,
  bots: ReturnType<typeof readCryptoBots>,
  watchHolding: (
    id: string,
    symbol: string,
    quantity: number,
    protection: HoldingProtection,
    sleeve: string,
  ) => Promise<void>,
) {
  for (const bot of bots)
    for (const [symbol, quantity] of Object.entries(bot.positions)) {
      if (Number(quantity) <= 0) continue;
      const protection = repo.state<HoldingProtection & { sleeve: string }>(
        `protection:crypto:${bot.id}:${symbol}`,
      );
      await watchHolding(
        `${bot.id}:${symbol}`,
        symbol,
        Number(quantity),
        protection ?? { stop: null, target: null, trailing: null },
        protection?.sleeve ?? "swing",
      );
    }
}
