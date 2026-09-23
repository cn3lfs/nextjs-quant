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
  ground: "#1f2130",
  /** --nc-bg: deeper ground for the 加深背景 view option. */
  groundDeep: "#161826",
  /** --nc-text-3 */
  text: "#9397ab",
  /** --nc-text-2 */
  textStrong: "#cfd3e5",
  /** --nc-border-soft */
  grid: "#292b31",
  /** --nc-inset */
  gridDeep: "#232532",
  /** --nc-border */
  border: "#3f424d",
  /** --nc-text-4 */
  muted: "#75798c",
  /** --nc-up / --nc-down: red rises, green falls. */
  up: "#e0897c",
  down: "#7fc2a0",
  upSoft: "#e0897c33",
  downSoft: "#7fc2a033",
  upFaint: "#e0897c20",
  downFaint: "#7fc2a020",
  /** --nc-accent / --nc-accent-light */
  accent: "#9184d9",
  accentLight: "#d2cefd",
  /** --nc-series-1…4: categorical indicator lines. */
  series1: "#e0b07c",
  series2: "#b5abfc",
  series3: "#7ab8d6",
  series4: "#d58fbf",
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

/** Nocturne defaults for every chart; explicit options still win. */
export const nocturneChartOptions: DeepPartial<ChartOptions> = {
  layout: {
    background: { type: ColorType.Solid, color: chartColor.ground },
    textColor: chartColor.text,
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

/** `createChart` with the Nocturne palette underneath the caller's options. */
export function createNocturneChart(
  container: HTMLElement,
  options: Options = {},
) {
  return createChart(container, merge(nocturneChartOptions, options));
}
