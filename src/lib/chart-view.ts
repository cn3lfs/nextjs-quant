import { z } from "zod";
import { symbolSchema } from "./domain";
export const chartPeriodSchema = z.enum(["day", "week", "month", "5m"]);
export type ChartPeriod = z.infer<typeof chartPeriodSchema>;
export const periodLabels = {
  day: "日线",
  week: "周线",
  month: "月线",
  "5m": "5 分钟",
};
const n = z.number().int().min(1).max(500);
export const indicatorParametersSchema = z
  .object({
    ma: z.tuple([n, n, n, n]),
    macd: z.tuple([n, n, n]),
    kdj: z.tuple([n, n, n]),
    rsi: z.tuple([n, n, n]),
    boll: z.tuple([n.min(2), z.number().finite().min(0).max(20)]),
  })
  .strict();
export type IndicatorParameters = z.infer<typeof indicatorParametersSchema>;
export const defaultParameters: IndicatorParameters = {
  ma: [5, 10, 20, 60],
  macd: [12, 26, 9],
  kdj: [9, 3, 3],
  rsi: [6, 12, 24],
  boll: [20, 2],
};
// Anchors use exchange bar timestamps, not viewport pixels or suffix indices.
const point = z
  .object({
    date: z
      .string()
      .min(10)
      .max(40)
      .refine((d) => Number.isFinite(Date.parse(d))),
    price: z.number().finite().positive(),
  })
  .strict();
export const drawingSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["trend", "horizontal", "rectangle", "fibonacci"]),
    a: point,
    b: point,
    color: z.string().regex(/^#[\da-fA-F]{6}$/),
  })
  .strict();
export type Drawing = z.infer<typeof drawingSchema>;
export const chartViewSchema = z
  .object({
    parameters: indicatorParametersSchema,
    logarithmic: z.boolean(),
    dark: z.boolean(),
    showBoll: z.boolean(),
    subchart: z.enum(["none", "volume", "macd", "kdj", "rsi", "rps"]),
    rps: z
      .object({
        periods: z
          .array(
            z.union([
              z.literal(5),
              z.literal(10),
              z.literal(20),
              z.literal(50),
              z.literal(120),
              z.literal(250),
            ]),
          )
          .max(6),
        threshold: z.number().finite().min(0).max(100),
      })
      .default({ periods: [50, 120, 250], threshold: 90 }),
    drawings: z.array(drawingSchema).max(200),
  })
  .strict();
export type ChartView = z.infer<typeof chartViewSchema>;
export const defaultChartView: ChartView = {
  parameters: defaultParameters,
  logarithmic: false,
  dark: false,
  showBoll: false,
  subchart: "volume",
  rps: { periods: [50, 120, 250], threshold: 90 },
  drawings: [],
};
export const chartKeySchema = z.object({
  symbol: symbolSchema,
  period: chartPeriodSchema,
});
export const chartSaveSchema = chartKeySchema.extend({ view: chartViewSchema });
export function indicatorLabel(name: string, p: IndicatorParameters) {
  const maIndex = ["MA5", "MA10", "MA20", "MA60"].indexOf(name),
    rsiIndex = ["RSI6", "RSI12", "RSI24"].indexOf(name);
  return maIndex >= 0
    ? `MA${p.ma[maIndex]}`
    : rsiIndex >= 0
      ? `RSI${p.rsi[rsiIndex]}`
      : name;
}
export function keyboardRange(
  range: { from: number; to: number },
  key: string,
) {
  const width = Math.max(2, range.to - range.from),
    center = (range.from + range.to) / 2;
  if (key === "ArrowLeft" || key === "ArrowRight") {
    const d = width * 0.1 * (key === "ArrowLeft" ? -1 : 1);
    return { from: range.from + d, to: range.to + d };
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    const half = Math.max(2, width * (key === "ArrowUp" ? 0.8 : 1.25)) / 2;
    return { from: center - half, to: center + half };
  }
  return null;
}
export function chartCost(
  position: { quantity: number; adjustedCost: number | null } | undefined,
) {
  return position &&
    position.quantity > 0 &&
    position.adjustedCost != null &&
    position.adjustedCost > 0
    ? position.adjustedCost
    : null;
}
export function structureAvailability(period: ChartPeriod) {
  return {
    czsc: period === "day" || period === "5m",
    breakout: period === "day",
  };
}
