import { relatedNewsEvents } from "../db/news-workspace-query";
import { settings } from "../infra/settings";
import { storedSecurityName } from "../market/securities";
import { loadAccountBook } from "../portfolio/account-workspace-service";
import { AlertRepository } from "../db/alert-repository";
import { chinaClock } from "~/lib/strategy-facts/notification-policy";

function termsFor(symbol: string) {
  const clean = symbol.replace(/^cx/, "").toUpperCase();
  if (clean === "BTCUSDT") return ["BTC", "比特币", "Bitcoin"];
  if (clean === "ETHUSDT") return ["ETH", "以太坊", "Ethereum"];
  return [
    ...new Set(
      [
        symbol,
        symbol.replace(/^(sh|sz|bj)/, ""),
        storedSecurityName(symbol),
      ].filter((v): v is string => !!v && v.length >= 2),
    ),
  ];
}
export function intelEvents(input: {
  symbol: string;
  from: number;
  to: number;
}) {
  return relatedNewsEvents(
    settings().clsDbPath,
    termsFor(input.symbol),
    input.from,
    input.to,
  ).map((event) => ({
    ...event,
    sessionDate: new Date(
      Date.parse(event.publishedAt) +
        (input.symbol.startsWith("cx") ? 0 : 8 * 3600000),
    )
      .toISOString()
      .slice(0, 10),
  }));
}
export async function todayIntel(now = Date.now()) {
  const book = await loadAccountBook();
  const symbols = [
    ...new Set([
      ...book.positions.filter((p) => p.quantity > 0).map((p) => p.symbol),
      ...new AlertRepository().plans(true).map((p) => p.symbol),
    ]),
  ];
  const date = chinaClock(now).date,
    from = Date.parse(`${date}T00:00:00+08:00`);
  return {
    symbols,
    from,
    to: now,
    events: relatedNewsEvents(
      settings().clsDbPath,
      [...new Set(symbols.flatMap(termsFor))],
      from,
      now,
    ),
    notice:
      "仅按已保存持仓及未完成计划的名称/代码匹配本地新闻；摘要为原文节选，不表示已核实利好利空。最多显示最近100条。",
  };
}
