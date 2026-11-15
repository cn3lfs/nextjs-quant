import { formatNumber as displayNumber } from "trading-strategy-core/format-number";
import { Button } from "../ui/button";
import { PopoverTrigger, PopoverContent } from "../ui/popover";
import { PanelPopover as Popover } from "../workbench/panel-popover";
import { chineseChartLocalization } from "~/lib/chart/chart-localization";
import {
  chartTime,
  breakoutChartData,
  type chartLegend,
  type IndicatorName,
} from "~/lib/chart/chart-data";
import {
  indicatorLabel,
  parameterSummary,
  type IndicatorParameters,
  type ChartPeriod,
} from "~/lib/chart/chart-view";
import type { Bar } from "~/lib/domain";
import type { BreakoutResult } from "trading-strategies/research/breakout/breakout";
import type { ChartCompare } from "./market-chart-state";
import { colors, compareColors } from "./market-chart-palette";

/** Legend groups: indicator lines sharing one parameter set and header. */
const legendGroups: {
  key: keyof IndicatorParameters | "obv";
  names: IndicatorName[];
}[] = [
  { key: "ma", names: ["MA5", "MA10", "MA20", "MA60"] },
  { key: "ema", names: ["EMA1", "EMA2", "EMA3"] },
  { key: "boll", names: ["BOLL中", "BOLL上", "BOLL下"] },
  { key: "macd", names: ["DIF", "DEA", "MACD"] },
  { key: "kdj", names: ["K", "D", "J"] },
  { key: "rsi", names: ["RSI6", "RSI12", "RSI24"] },
  { key: "wr", names: ["WR1", "WR2"] },
  { key: "bias", names: ["BIAS1", "BIAS2", "BIAS3"] },
  { key: "cci", names: ["CCI"] },
  { key: "obv", names: ["OBV"] },
];
/** Sub-chart pane that hosts an indicator line; main-chart lines use pane 0. */
const formatValue = (value: number | null | undefined, precision = 2) =>
  value == null ? "—" : displayNumber(value, precision);

export function MarketChartLegend({
  legend,
  period,
  pricePrecision,
  showVolume,
  volumeUnit,
  compare,
  parameters,
  onEdit,
  showBreakout,
  breakout,
  bars,
  breakoutIndex,
}: {
  legend: ReturnType<typeof chartLegend>;
  period: ChartPeriod;
  pricePrecision: number;
  showVolume: boolean;
  volumeUnit: string;
  compare?: readonly ChartCompare[];
  parameters: IndicatorParameters;
  onEdit: (key: keyof IndicatorParameters) => void;
  showBreakout: boolean;
  breakout?: BreakoutResult;
  bars: Bar[];
  breakoutIndex: number;
}) {
  return (
    <>
      <div
        data-testid="chart-legend"
        className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1 text-xs"
        style={{ fontVariantNumeric: "tabular-nums" }}
      >
        {legend ? (
          <>
            <span>
              {chineseChartLocalization.timeFormatter(
                chartTime(legend.bar.date, period),
              )}
            </span>
            <span>开 {formatValue(legend.bar.open, pricePrecision)}</span>
            <span>高 {formatValue(legend.bar.high, pricePrecision)}</span>
            <span>低 {formatValue(legend.bar.low, pricePrecision)}</span>
            <span>收 {formatValue(legend.bar.close, pricePrecision)}</span>
            {showVolume && (
              <span>
                量 {formatValue(legend.bar.volume)} {volumeUnit}
              </span>
            )}
            {compare?.map((item, i) => {
              const bar = item.bars.find((b) => b.date === legend.bar.date);
              return (
                <span
                  key={item.symbol}
                  style={{ color: compareColors[i % compareColors.length] }}
                >
                  {item.label}{" "}
                  {bar ? formatValue(bar.close, pricePrecision) : "—"}
                </span>
              );
            })}
            {legendGroups.map(({ key, names: group }) => {
              const items = legend.indicators.filter(({ name }) =>
                group.includes(name),
              );
              if (!items.length) return null;
              return (
                <span key={key} className="inline-flex gap-2">
                  {key === "obv" ? (
                    <span className="opacity-70">OBV</span>
                  ) : (
                    <Button
                      variant="plain"
                      type="button"
                      className="cursor-pointer opacity-70 hover:underline"
                      title="点击修改参数"
                      onClick={() => onEdit(key)}
                    >
                      {parameterSummary(key, parameters)}
                    </Button>
                  )}
                  {items.map(({ name, value }) => (
                    <span key={name} style={{ color: colors[name] }}>
                      {indicatorLabel(name, parameters)}{" "}
                      {formatValue(value, name === "OBV" ? 0 : 2)}
                    </span>
                  ))}
                </span>
              );
            })}
          </>
        ) : (
          <span>暂无行情</span>
        )}
        {showBreakout && breakout && (
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="plain" className="text-xs underline">
                关键位说明
              </Button>
            </PopoverTrigger>
            <PopoverContent aria-label="双突破关键位与趋势线">
              <div
                data-testid="chart-level-legend"
                className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs tabular-nums"
                aria-label="双突破关键位与趋势线"
              >
                {breakoutChartData(
                  breakout,
                  bars,
                  0,
                  breakoutIndex,
                  period,
                ).lines.map((line) => (
                  <span key={line.title} style={{ color: line.color }}>
                    {line.title}
                  </span>
                ))}
              </div>
            </PopoverContent>
          </Popover>
        )}
      </div>
    </>
  );
}
