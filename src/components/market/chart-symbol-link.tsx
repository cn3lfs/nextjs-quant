import { chartSymbolHref } from "~/lib/chart-symbol";

/**
 * A full navigation on purpose: the workbench reads `?symbol=` once on mount, so
 * a cached client-side panel would ignore a new selection.
 */
export function ChartSymbolLink({
  symbol,
  name,
}: {
  symbol: string;
  name: string;
}) {
  return (
    <a
      className="text-primary underline underline-offset-2 hover:no-underline"
      href={chartSymbolHref(symbol)}
      title={`查看 ${name} 的K线`}
    >
      {name} · {symbol.toUpperCase()}
    </a>
  );
}
