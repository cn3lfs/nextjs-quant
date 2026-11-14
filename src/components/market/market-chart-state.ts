import type { RefObject } from "react";
import type { Bar } from "~/lib/domain";
import type {
  ChartPeriod as Period,
  ChartView,
  Drawing,
  Subchart,
} from "~/lib/chart/chart-view";
import type { CrosshairLink } from "~/lib/chart/crosshair-link";
import type { CzscResult } from "trading-strategies/research/chan/czsc";
import type { attachDrawings } from "~/lib/chart/chart-drawings";
import type {
  createChart,
  ISeriesApi,
  ISeriesMarkersPluginApi,
  IPriceLine,
  LogicalRange,
  SeriesType,
  Time,
} from "lightweight-charts";

export type MarketChartState = {
  chart: ReturnType<typeof createChart>;
  candles: ISeriesApi<"Candlestick">;
  setDrawings: ReturnType<typeof attachDrawings>;
  /** Drawings shared from other periods: dashed and read-only. */
  setShared: ReturnType<typeof attachDrawings>;
  markers: ISeriesMarkersPluginApi<Time>;
  /** What the structure primitive paints; replaced per content pass. */
  structure: { czsc: CzscResult | null; bars: Bar[]; start: number };
  bars: Bar[];
  start: number;
  asOf: number;
  byTime: Map<Time, number>;
  renderBase: () => void;
  renderIndicators: () => void;
  baseLines: ISeriesApi<"Line">[];
  compareLines: ISeriesApi<"Line">[];
  indicatorLines: ISeriesApi<"Line">[];
  /** One pane per selected subchart, identified by its anchor series. */
  panes: Map<
    Subchart,
    { anchor: ISeriesApi<SeriesType>; threshold: IPriceLine | null }
  >;
  costLine: IPriceLine | null;
  /** Keyboard cursor bar index (TDX ←/→), null when not in cursor mode. */
  cursor: number | null;
  /** Range to apply after the next data change; undefined = keep. */
  pendingRange?: LogicalRange | null;
};
export type ChartViewport = {
  bars: Bar[];
  period: Period;
  start: number;
  asOf: number;
  range: LogicalRange | null;
};
export type ChartHover = { bars: Bar[]; index: number } | null;
export type ChartLiveOptions = {
  drawingTool: Drawing["kind"] | "none";
  drawingPoints?: readonly Drawing["a"][];
  drawingText?: string;
  onAnchor?: (point: Drawing["a"]) => void;
  onHistoryRequest?: () => void;
  dark: boolean;
  view?: ChartView;
  onViewChange?: (view: ChartView) => void;
};
export type ChartInstanceOptions = {
  period: Period;
  pricePrecision: number;
  viewportKey?: string;
  live: RefObject<ChartLiveOptions>;
  viewport: RefObject<ChartViewport | null>;
  linkRef: RefObject<{ hub: CrosshairLink; id: string } | undefined>;
  linking: RefObject<boolean>;
  setHover: (hover: ChartHover) => void;
  setSelected: (id: string | null) => void;
  setHistoryStart: (start: number) => void;
};

export type ChartCompare = { symbol: string; label: string; bars: Bar[] };
