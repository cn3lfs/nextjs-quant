import {
  createChart,
  ColorType,
  type ChartOptions,
  type DeepPartial,
} from "lightweight-charts";

/**
 * Canvas palette. lightweight-charts paints on a canvas and cannot resolve CSS
 * variables, so these values mirror `src/styles/tokens.css`; the
 * `chart-theme` test fails if the two drift apart. Components never write
 * chart hex values themselves.
 */
export const chartColor = {
  /** --nc-card: the panel ground the chart sits on. */
  ground: "#ffffff",
  /** --nc-bg: deeper ground for the 加深背景 view option. */
  groundDeep: "#f5f7fa",
  /** --nc-text-3 */
  text: "#475569",
  /** --nc-text-2 */
  textStrong: "#334155",
  /** --nc-border-soft */
  grid: "#e8edf3",
  /** --nc-inset */
  gridDeep: "#f0f4f8",
  /** --nc-border */
  border: "#d8e0ea",
  /** --nc-text-4 */
  muted: "#5b677a",
  /** --nc-up / --nc-down: red rises, green falls. */
  up: "#d92d42",
  down: "#147d64",
  upSoft: "#d92d4233",
  downSoft: "#147d6433",
  upFaint: "#d92d4220",
  downFaint: "#147d6420",
  /** --nc-accent / --nc-accent-light */
  accent: "#2457c5",
  accentLight: "#2457c5",
  /** --nc-series-1…4: categorical indicator lines. */
  series1: "#9a6700",
  series2: "#635bbd",
  series3: "#247b94",
  series4: "#a14480",
} as const;

/** CSS variable behind each mirrored color (tested against tokens.css). */
export const chartColorTokens: Partial<
  Record<keyof typeof chartColor, string>
> = {
  ground: "--nc-card",
  groundDeep: "--nc-bg",
  text: "--nc-text-3",
  textStrong: "--nc-text-2",
  grid: "--nc-border-soft",
  gridDeep: "--nc-inset",
  border: "--nc-border",
  muted: "--nc-text-4",
  up: "--nc-up",
  down: "--nc-down",
  accent: "--nc-accent",
  accentLight: "--nc-accent-light",
  series1: "--nc-series-1",
  series2: "--nc-series-2",
  series3: "--nc-series-3",
  series4: "--nc-series-4",
};

/** Shared light defaults for every chart; explicit options still win. */
export const nocturneChartOptions: DeepPartial<ChartOptions> = {
  layout: {
    background: { type: ColorType.Solid, color: chartColor.ground },
    textColor: chartColor.text,
    fontSize: 13,
    fontFamily: '"Inter", "Segoe UI", "Microsoft YaHei", sans-serif',
  },
  grid: {
    vertLines: { color: chartColor.grid },
    horzLines: { color: chartColor.grid },
  },
  rightPriceScale: { borderColor: chartColor.border },
  leftPriceScale: { borderColor: chartColor.border },
  timeScale: { borderColor: chartColor.border },
  crosshair: {
    vertLine: {
      color: chartColor.muted,
      labelBackgroundColor: chartColor.border,
    },
    horzLine: {
      color: chartColor.muted,
      labelBackgroundColor: chartColor.border,
    },
  },
};

type Options = DeepPartial<ChartOptions>;
function merge<T extends object>(base: T, extra: T): T {
  const out = { ...base } as Record<string, unknown>;
  for (const [key, value] of Object.entries(extra)) {
    const current = out[key];
    out[key] =
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      current &&
      typeof current === "object"
        ? merge(current as object, value as object)
        : value;
  }
  return out as T;
}

/** `createChart` with the workbench palette underneath the caller's options. */
export function createNocturneChart(
  container: HTMLElement,
  options: Options = {},
) {
  return createChart(container, merge(nocturneChartOptions, options));
}
