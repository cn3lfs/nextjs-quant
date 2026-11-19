"use client";
import { formatNumber as displayNumber } from "trading-strategy-core/format-number";

import { compactNumber } from "~/lib/market/tdx-fundamentals";
import type {
  QuoteBookDisplayModel,
  QuoteBookMetric,
} from "~/lib/market/quote-book-view";

const missing = (metric: QuoteBookMetric) =>
  `不可得：${metric.reason ?? "证据不足"}`;
const percent = (metric: QuoteBookMetric, digits = 2) =>
  metric.value === null
    ? missing(metric)
    : `${displayNumber(metric.value * 100, digits)}%`;
const signedPercent = (metric: QuoteBookMetric) =>
  metric.value === null
    ? missing(metric)
    : `${metric.value >= 0 ? "+" : ""}${displayNumber(metric.value * 100, 2)}%`;
const tone = (metric: QuoteBookMetric) =>
  metric.value === null
    ? ""
    : metric.value > 0
      ? "up"
      : metric.value < 0
        ? "down"
        : "";

function Stat({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-[1px]">
      <span className="shrink-0 text-[11px] text-nc-text-4">{label}</span>
      <span className="truncate text-right text-[12px] tabular-nums">
        {children}
      </span>
    </div>
  );
}

/**
 * 来源无关的五档盘口纯展示。所有可得性判断都来自展示模型：
 * 缺失显示破折号或原因，不补 0；`unknown` 只给出来源说明。
 */
export function QuoteBook({
  model,
  testId,
}: {
  model: QuoteBookDisplayModel;
  /** 保留调用方原有的可测试标识。 */
  testId?: string;
}) {
  const price = (value: number | null) =>
    value === null ? "—" : displayNumber(value, model.precision);
  // 档位价格按相对昨收着色，与通达信一致。
  const levelTone = (value: number | null) =>
    value === null ||
    model.preClose === null ||
    !Number.isFinite(model.preClose)
      ? ""
      : value > model.preClose
        ? "up"
        : value < model.preClose
          ? "down"
          : "";
  const levels = [...model.asks, ...model.bids];
  const hasPriceStats =
    model.open !== null ||
    model.preClose !== null ||
    model.high !== null ||
    model.low !== null ||
    model.riseSpeed !== null ||
    model.volume !== null ||
    model.amount !== null ||
    model.innerVolume !== null ||
    model.outerVolume !== null;
  const volumeText = (value: number | null) =>
    value === null ? "—" : (compactNumber(value) ?? "—");
  return (
    <div className="space-y-2.5" data-testid={testId}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span
          className={`text-2xl font-semibold tabular-nums ${tone(model.change)}`}
        >
          {price(model.lastPrice)}
        </span>
        {(model.lastPrice !== null ||
          model.change.value !== null ||
          model.changePercent.value !== null) && (
          <>
            <span className={`text-sm tabular-nums ${tone(model.change)}`}>
              {model.change.value === null
                ? missing(model.change)
                : `${model.change.value >= 0 ? "+" : ""}${displayNumber(model.change.value, model.precision)}`}
            </span>
            <span
              className={`text-sm tabular-nums ${tone(model.changePercent)}`}
            >
              {signedPercent(model.changePercent)}
            </span>
          </>
        )}
        <span className="w-full text-[11px] text-nc-text-4">
          {model.sessionLabel} · 快照时刻{" "}
          {model.quoteTime ?? model.quoteTimeNote}
        </span>
      </div>
      {model.state === "quoted" ? (
        <div
          className="border-y border-nc-border-soft py-1 text-[12px]"
          role="table"
          aria-label={
            model.volumeUnit
              ? `五档盘口（挂单量单位：${model.volumeUnit}）`
              : "五档盘口（挂单量为源单位）"
          }
        >
          <div className="flex justify-between px-1 pb-1 text-[11px] text-nc-text-4">
            <span>
              委比{" "}
              <span className={tone(model.imbalance.ratio)}>
                {signedPercent(model.imbalance.ratio)}
              </span>
            </span>
            <span>
              委差{" "}
              {model.imbalance.difference.value === null
                ? missing(model.imbalance.difference)
                : (compactNumber(model.imbalance.difference.value) ?? "—")}
            </span>
          </div>
          {levels.map((row, index) => {
            const side = index < model.asks.length ? "ask" : "bid";
            return (
              <div
                key={`${side}${row.level}`}
                role="row"
                className={`relative grid grid-cols-[3em_1fr_1fr] items-center px-1 leading-[20px] ${side === "bid" && index === model.asks.length ? "mt-1 border-t border-nc-border-soft pt-1" : ""}`}
              >
                <span
                  aria-hidden
                  className={`absolute inset-y-[3px] right-0 rounded-sm opacity-15 ${side === "ask" ? "bg-nc-down" : "bg-nc-up"}`}
                  style={{ width: `${Math.round(row.depth * 60)}%` }}
                />
                <span role="cell" className="text-nc-text-3">
                  {side === "ask" ? "卖" : "买"}
                  {row.level}
                </span>
                <span
                  role="cell"
                  className={`text-right tabular-nums ${levelTone(row.price)}`}
                >
                  {price(row.price)}
                </span>
                <span role="cell" className="text-right tabular-nums">
                  {row.volume === null
                    ? "—"
                    : (compactNumber(row.volume) ?? "—")}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[12px] text-nc-text-3">
          {model.bookNotice}
          {model.state === "empty" &&
            model.imbalance.ratio.value === null &&
            ` 委比${missing(model.imbalance.ratio)}`}
        </p>
      )}
      {hasPriceStats && (
        <div className="grid grid-cols-2 gap-x-4">
          <Stat label="今开">
            <span className={levelTone(model.open)}>{price(model.open)}</span>
          </Stat>
          <Stat label="昨收">{price(model.preClose)}</Stat>
          <Stat label="最高">
            <span className={levelTone(model.high)}>{price(model.high)}</span>
          </Stat>
          <Stat label="最低">
            <span className={levelTone(model.low)}>{price(model.low)}</span>
          </Stat>
          <Stat label="振幅">{percent(model.amplitude)}</Stat>
          <Stat label="涨速">
            {model.riseSpeed === null
              ? "—"
              : `${displayNumber(model.riseSpeed, 2)}%`}
          </Stat>
          <Stat label="总量">{volumeText(model.volume)}</Stat>
          <Stat label="金额">{volumeText(model.amount)}</Stat>
          <Stat label="外盘">
            <span className="up">{volumeText(model.outerVolume)}</span>
          </Stat>
          <Stat label="内盘">
            <span className="down">{volumeText(model.innerVolume)}</span>
          </Stat>
          <Stat label="外盘占比">{percent(model.activeBuyRatio)}</Stat>
        </div>
      )}
      <p
        className="text-[10.5px] leading-[1.5] text-nc-text-4"
        title={model.sourceNoteTitle}
      >
        {model.sourceNote}
      </p>
    </div>
  );
}
