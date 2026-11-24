import { validateLocalDate, readLocalTradingDates } from "tstdx/local";
import type { TdxXdxr } from "tstdx/wire";
import type { Bar } from "trading-strategy-core/bars";
import type { EtfRotationInstrument } from "trading-strategies";
import type { PortfolioExecution } from "quant-backtest";
import { readWindowSnapshot } from "../../market/market-panel/window";
import type { MarketPanelHandle } from "../../market/market-panel/handle";
import { missingAtoms } from "../../market/market-panel/format";
import { readResearchPriceActions } from "../causal-price-basis";

export type EtfRotationDailySource = Readonly<{
  bars: readonly Readonly<Bar>[];
  events: readonly Readonly<TdxXdxr>[];
  /** Optional pre-open exchange facts from a frozen source. */
  execution?: Readonly<Record<string, Readonly<PortfolioExecution>>>;
}>;

export type EtfRotationMarketData = Readonly<{
  calendar: readonly string[];
  calendarBasis: string;
  actionsSource: string;
  series: Readonly<Partial<Record<string, EtfRotationDailySource>>>;
}>;

export type EtfRotationDataSource =
  | { kind: "tdx"; root?: string }
  | {
      kind: "market-panel";
      panel: Pick<MarketPanelHandle, "sliceSymbol" | "events"> & {
        manifest: Pick<
          MarketPanelHandle["manifest"],
          "dates" | "symbols" | "sources"
        >;
      };
    }
  | { kind: "frozen"; data: EtfRotationMarketData };

const historyStart = "1990-01-01";
const gbbqFile = "T0002/hq_cache/gbbq";

function loadPanel(
  panel: Extract<EtfRotationDataSource, { kind: "market-panel" }>["panel"],
  universe: readonly EtfRotationInstrument[],
  end: string,
): EtfRotationMarketData {
  const { dates, symbols, sources } = panel.manifest;
  if (!sources[gbbqFile]) throw new Error("ETF panel has no GBBQ evidence");
  if (!dates.includes(end))
    throw new Error("ETF panel lacks the completed end session");
  const series = Object.fromEntries(
    universe.map(({ symbol }) => {
      const metadata = symbols.find((item) => item.symbol === symbol);
      if (metadata?.kind !== "etf")
        throw new Error("ETF panel is missing " + symbol);
      const bars: Bar[] = [];
      if (end >= metadata.firstDate) {
        const to = end < metadata.lastDate ? end : metadata.lastDate;
        const slice = panel.sliceSymbol(symbol, metadata.firstDate, to);
        const scale = metadata.priceScale;
        for (const [i, date] of slice.dates.entries()) {
          const close = slice.closeAtoms[i]!;
          const volume = slice.volume[i]!;
          if (close === missingAtoms || volume === 0) continue;
          const amount = slice.amount[i]!;
          if (!Number.isFinite(slice.adjFactor[i]!))
            throw new Error(
              `Missing causal ETF panel factor: ${symbol} ${date}`,
            );
          bars.push({
            date,
            volume,
            // The engine accepts numeric amount; 0 keeps an unknown positive-volume
            // session out of execution reality ADV without discarding its close.
            amount: Number.isNaN(amount) ? 0 : amount,
            open: slice.openAtoms[i]! / scale,
            high: slice.highAtoms[i]! / scale,
            low: slice.lowAtoms[i]! / scale,
            close: close / scale,
          });
        }
      }
      const events = panel
        .events(symbol, end)
        .flatMap((event) => (event.kind === "gbbq" ? [event.raw] : []));
      return [symbol, { bars, events }] as const;
    }),
  );
  return {
    calendar: dates,
    calendarBasis: "MarketPanelStore union of accepted local daily sessions",
    actionsSource: "GBBQ:" + sources[gbbqFile],
    series,
  };
}

export async function loadEtfRotationMarketData(
  source: EtfRotationDataSource,
  universe: readonly EtfRotationInstrument[],
  end: string,
  signal?: AbortSignal,
): Promise<EtfRotationMarketData> {
  validateLocalDate(end);
  signal?.throwIfAborted();
  if (source.kind === "frozen") return source.data;
  if (source.kind === "market-panel")
    return loadPanel(source.panel, universe, end);
  const root = source.root ?? "E:/new_tdx64";
  const [calendar, gbbq] = await Promise.all([
    readLocalTradingDates(root),
    readResearchPriceActions(root),
  ]);
  const pool = new Set(universe.map(({ symbol }) => symbol));
  if (gbbq.issues.some(({ symbol }) => !symbol || pool.has(symbol)))
    throw new Error("Unresolved GBBQ evidence for ETF rotation");
  const series: Record<string, EtfRotationDailySource> = {};
  for (const { symbol } of universe) {
    signal?.throwIfAborted();
    const snapshot = await readWindowSnapshot(root, symbol, "day", {
      from: historyStart,
      to: end,
      chartFunds: true,
    });
    series[symbol] = {
      bars: snapshot.bars,
      events: gbbq.events.get(symbol) ?? [],
    };
  }
  return {
    calendar: calendar.days,
    calendarBasis: calendar.source,
    actionsSource: "GBBQ:" + gbbq.sourceSha256,
    series,
  };
}
