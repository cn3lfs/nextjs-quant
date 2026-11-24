import {
  readWindowSnapshot as readTdxWindow,
  type LocalQuoteOptions,
  type TdxLocalPeriod,
} from "tstdx/local";

/** Research entry point for inclusive .day/.lc5 windows. The underlying
 * indexed reader still hashes and validates the complete source generation. */
export function readWindowSnapshot(
  root: string,
  symbol: string,
  period: TdxLocalPeriod,
  options: LocalQuoteOptions & { from: string; to?: string },
) {
  return readTdxWindow(root, symbol, period, {
    from: options.from,
    to: options.to,
    chartFunds: options.chartFunds === true || options.allowFunds === true,
  });
}
