import { replayPortfolioEvents } from "../portfolio-account.js";
import { type PortfolioRequest } from "./types.js";
import { createPortfolioPreparation } from "./preparation.js";
import { createPortfolioState } from "./state.js";
import { createOrderExecutor } from "./order-execution.js";
import { seedStrategyBooks } from "./book-seeds.js";
import { applyCorporateActions, matchOpeningOrders } from "./market-open.js";
import { observeClosingSignals } from "./close-signals.js";
import { scheduleClosingTargets } from "./close-targets.js";
import { rebalanceAndMarkEquity, portfolioResult } from "./equity.js";

/** Long-only, one market account, independent sleeve ledgers with cash transfers.
 * Calendar is explicit so suspension and absent bars do not become delayed buys.
 * A stop already known before this bar wins if stop and target both touch.
 */
export function runPortfolio(
  request: PortfolioRequest,
  progress: (done: number, total: number) => void = () => {},
  preparation?: ReturnType<typeof createPortfolioPreparation>,
  signal?: AbortSignal,
) {
  const state = createPortfolioState(request, preparation);
  const execute = createOrderExecutor(state);
  seedStrategyBooks(state);
  const { calendar } = state;
  replayPortfolioEvents(calendar, {
    beforeOpen: (_index, date) => applyCorporateActions(state, date),
    open: (_index, date) => matchOpeningOrders(state, date, execute),
    close: (index, date) => {
      signal?.throwIfAborted();
      const candidates = observeClosingSignals(state, index, date, execute);
      scheduleClosingTargets(state, index, date, candidates);
      rebalanceAndMarkEquity(state, index, date);
      if (index % 4096 === 0) progress(index + 1, calendar.length);
    },
  });
  progress(calendar.length, calendar.length);
  return portfolioResult(state);
}
