export {
  actionPrice,
  type PortfolioAction,
  type PortfolioLot,
  type PortfolioPosition,
} from "quant-execution";

/** All replay profiles share the same ordered event clock. Policies supply
 * decisions at open/close; this function owns ordering, not market-specific rules.
 */
export function replayPortfolioEvents(
  dates: readonly string[],
  handlers: {
    beforeOpen?: (index: number, date: string) => void;
    open: (index: number, date: string) => void;
    close: (index: number, date: string) => void;
  },
) {
  let previous = "";
  dates.forEach((date, index) => {
    if (date <= previous || !Number.isFinite(Date.parse(date)))
      throw new Error("Invalid event calendar");
    previous = date;
    handlers.beforeOpen?.(index, date);
    handlers.open(index, date);
    handlers.close(index, date);
  });
}
