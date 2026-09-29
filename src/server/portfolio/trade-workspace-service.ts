import { tradePositionState } from "./trade-ledger-service";
import { tradeWorkspaceVersion } from "./trade-workspace-query";
import { tradePositionPageSchema } from "~/lib/portfolio/trade-workspace";
import { tradedSignalComparison } from "~/lib/portfolio/trade-ledger";
import { TradeLedgerStore } from "./trade-ledger-store";
import { SignalLedgerStore } from "../monitoring/signal-ledger-store";
import { sqlite } from "../db";

export async function tradeWorkspacePositions(raw: unknown) {
  const input = tradePositionPageSchema.parse(raw),
    db = sqlite();
  const version = tradeWorkspaceVersion(db),
    state = await tradePositionState();
  if (version !== tradeWorkspaceVersion(db))
    throw new Error("计算期间账本已更新，请刷新持仓");
  const open = state.positions.filter((p) => p.quantity > 0);
  const matching = state.positions
    .filter((p) => p.symbol.toLowerCase().includes(input.query.toLowerCase()))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return {
    today: state.today,
    calendarSource: state.calendarSource,
    version,
    summary: {
      holdings: open.length,
      trades: state.trades.length,
      linkedTrades: state.trades.filter((t) => t.signalId).length,
      marketValue: open.every((p) => p.quote !== null)
        ? open.reduce((sum, p) => sum + p.quantity * p.quote!.price, 0)
        : null,
      knownMarketValue: open.reduce(
        (sum, p) => sum + (p.quote ? p.quantity * p.quote.price : 0),
        0,
      ),
      missingQuotes: open.filter((p) => !p.quote).length,
      floating: open.every((p) => p.floating !== null)
        ? open.reduce((sum, p) => sum + p.floating!, 0)
        : null,
      unknownFloating: open.filter((p) => p.floating === null).length,
      sellable: open.reduce((sum, p) => sum + p.sellable, 0),
    },
    count: matching.length,
    page: input.page,
    items: matching
      .slice((input.page - 1) * 20, input.page * 20)
      .map(({ adjustments, ...position }) => ({
        ...position,
        adjustmentCount: adjustments.length,
      })),
    hasMore: input.page * 20 < matching.length,
  };
}
export function tradeWorkspaceComparison() {
  const db = sqlite();
  return tradedSignalComparison(
    new SignalLedgerStore(db).rows(),
    new TradeLedgerStore(db).trades(),
  );
}
