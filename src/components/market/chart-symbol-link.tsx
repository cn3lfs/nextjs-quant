"use client";

import { chartSymbolHref } from "~/lib/chart/chart-symbol";
import { useOpenChart } from "./open-chart";

/**
 * Inside the workbench the chart opens in place (no reload, the surrounding
 * table becomes the PageUp/PageDown list). Elsewhere it is a full navigation:
 * the workbench reads `?symbol=` once on mount.
 */
export function ChartSymbolLink({
  symbol,
  name,
}: {
  symbol: string;
  name?: string;
}) {
  const openChart = useOpenChart();
  return (
    <a
      className="text-primary underline underline-offset-2 hover:no-underline"
      href={chartSymbolHref(symbol)}
      title={`查看 ${name ?? symbol.toUpperCase()} 的K线`}
      onClick={(event) => {
        if (
          !openChart ||
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        openChart(symbol);
      }}
    >
      {name ? `${name} · ` : ""}
      {symbol.toUpperCase()}
    </a>
  );
}
