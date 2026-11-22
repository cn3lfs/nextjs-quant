import type { AlertEvent } from "~/lib/strategy-facts/alerts";
import { alertKey } from "~/lib/strategy-facts/alerts";
import { horizons } from "~/lib/strategy-facts/signal-ledger";
import { PaperRepository } from "../db/paper-repository";
import { AlertRepository } from "../db/alert-repository";
import { settings } from "../infra/settings";
import { enqueueAlert } from "../infra/notifications";
import { paperCompletedAt } from "./advance-clock";
import { closeScanOpen } from "~/lib/market/close-scan-window";

/** A bounded current advance only; historical catch-up is accounting, never delivery. */
export function recordPaperAlerts(
  repo: PaperRepository,
  id: string,
  now: number,
  deliver = enqueueAlert,
) {
  const account = repo.account(id)!;
  const state = repo.state(id);
  if (!state || !account.lastBar) return;
  const alerts = new AlertRepository(repo.db);
  const advance = repo.factValue<{ catchUp: boolean; at: number }>(
    id,
    "advance",
    account.lastBar,
  );
  if (!advance || advance.at !== now) return;
  const recent = state.result.fills
    .map((fill, index) => ({ fill, index }))
    .filter(({ fill }) => fill.date === account.lastBar);
  alerts.atomic(() => {
    const mode = settings().alerts.mode;
    if (mode === "off") return;
    const missed =
      advance.catchUp ||
      now < paperCompletedAt(account, account.lastBar!) ||
      (account.market === "cn-equity"
        ? !closeScanOpen(
            account.lastBar!.slice(0, 10),
            now,
            alerts.records.days(),
          )
        : now - paperCompletedAt(account, account.lastBar!) >
          (account.candidates[0]!.strategy.period === "day" ? 12 * 60 : 5) *
            60000);
    for (const { fill, index } of recent) {
      const strategy = account.candidates.find(
        (c) => c.strategy.id === fill.strategyId,
      )!.strategy;
      const identity = {
        type: "paper-fill" as const,
        price: fill.price,
        strategyId: strategy.id,
        version: strategy.version,
        market: account.market,
        symbol: fill.symbol,
        bar: fill.date,
        paperFillId: `${id}:${index}`,
      };
      const event: AlertEvent = {
        ...identity,
        key: alertKey(identity),
        sleeve: fill.sleeve,
        stop: null,
        target: null,
        observedAt: now,
        mode,
        status: missed ? "missed" : mode,
        wouldSend: !missed,
        reason: `模拟 ${fill.side} ${fill.quantity}，成交${fill.price}，持仓${fill.holdingAfter}；${state.result.orders.find((o) => o.id === fill.orderId)!.trigger}${missed ? "；补推或过期，仅记账不补发" : ""}`,
        source: `本地纸面账户 ${id}; 同回测撮合`,
        outcomes: horizons.map((horizon) => ({
          horizon,
          settled: true,
          entryDate: null,
          exitDate: null,
          entry: null,
          exit: null,
          returnPct: null,
          action: "除权状态未知",
          reasons: ["纸面成交收益见账户权益；不是价格观察样本"],
          calendarSource: "不适用",
          actionSource: "不适用",
        })),
      };
      alerts.record(strategy, event, (committed) => {
        if (mode === "live" && !missed) deliver(committed);
      });
    }
  });
}
