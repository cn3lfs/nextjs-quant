import { MarketSourceSelect } from "../market/market-source-select";
import { ChartAdjustmentSelect } from "../market/chart-adjustment-select";
import { ArrowUpRight, Plus, X } from "lucide-react";
import { useState } from "react";
import {
  chartPeriodSchema,
  periodLabels,
  type ChartPeriod,
} from "~/lib/chart-view";
import {
  chartAdjustmentLabels,
  type ChartAdjustment,
} from "~/lib/chart-adjustment";
import { securityDisplayName } from "~/lib/security-display";
import { ChartWorkspace } from "../market/chart-workspace";
import { SecuritySelect } from "../market/security-select";
import { MarketPoolBrowser } from "../market/market-pool-browser";
import { isMarketIndex } from "~/lib/market-indices";
import { isSectorChartSymbol } from "~/lib/chart-symbol";
import { Button } from "../ui/button";

import { Empty } from "./shared";
import { type WorkbenchState } from "./use-workbench-state";

export function MarketView({
  state,
}: {
  state: Pick<
    WorkbenchState,
    | "marketSource"
    | "setMarketSource"
    | "symbol"
    | "setSymbol"
    | "period"
    | "setPeriod"
    | "loaded"
    | "names"
    | "load"
    | "watch"
    | "last"
    | "change"
    | "watchlist"
  >;
}) {
  const {
    marketSource,
    setMarketSource,
    symbol,
    setSymbol,
    period,
    loaded,
    names,
    load,
    watch,
    watchlist,
  } = state;
  const [chartPeriod, setChartPeriod] = useState<ChartPeriod>(period);
  const [chartAdjustment, setChartAdjustment] =
    useState<ChartAdjustment>("none");
  const effectiveAdjustment =
    isMarketIndex(symbol) || isSectorChartSymbol(symbol)
      ? "none"
      : chartAdjustment;
  const displayedPeriod = chartPeriod;
  return (
    <>
      <div className="market-layout">
        <section className="panel chart-panel">
          <div className="panel-toolbar">
            <SecuritySelect
              symbol={symbol}
              name={
                loaded?.symbol === symbol
                  ? securityDisplayName(symbol, names, loaded.name)
                  : names[symbol]
              }
              period={period}
              disabled={load.isPending}
              onSelect={(next) => {
                setSymbol(next);
                load.mutate({
                  symbol: next,
                  period,
                  source: marketSource,
                });
              }}
            />
            <MarketSourceSelect
              value={marketSource}
              disabled={load.isPending}
              onChange={(source) => {
                setMarketSource(source);
                load.mutate({ symbol, period, source });
              }}
            />
            <ChartAdjustmentSelect
              value={effectiveAdjustment}
              disabled={
                load.isPending ||
                isMarketIndex(symbol) ||
                isSectorChartSymbol(symbol)
              }
              onChange={setChartAdjustment}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={load.isPending}
              onClick={() =>
                load.mutate({ symbol, period, source: marketSource })
              }
            >
              刷新行情
            </Button>
            <div className="segmented">
              {chartPeriodSchema.options.map((p) => (
                <Button
                  variant="plain"
                  className={displayedPeriod === p ? "selected" : ""}
                  key={p}
                  disabled={load.isPending}
                  onClick={() => {
                    setChartPeriod(p);
                  }}
                >
                  {p === "day" ? "日 K" : periodLabels[p]}
                </Button>
              ))}
            </div>
          </div>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 pt-3 pb-1">
            <h2 className="text-lg font-semibold">
              {loaded
                ? securityDisplayName(loaded.symbol, names, loaded.name)
                : "加载行情"}
            </h2>
            <div className="eyebrow">
              {loaded?.symbol.toUpperCase() ?? "本地行情"}{" "}
              <span className="tag">
                {chartAdjustmentLabels[effectiveAdjustment]}
              </span>
              {loaded?.historicalAsOf && (
                <span className="tag">
                  历史快照 · 截至 {loaded.historicalAsOf}
                </span>
              )}
            </div>
          </div>

          {load.error && !load.isPending ? (
            <div role="alert" className="p-5 text-sm">
              所选数据源读取失败：{load.error.message}
              <Button
                variant="outline"
                onClick={() =>
                  load.mutate({ symbol, period, source: marketSource })
                }
              >
                重试
              </Button>
            </div>
          ) : loaded && !load.isPending ? (
            <ChartWorkspace
              key={`${loaded.id}:${displayedPeriod}:${effectiveAdjustment}`}
              snapshot={loaded}
              period={displayedPeriod}
              adjustment={effectiveAdjustment}
            />
          ) : (
            <Empty>
              {load.isPending
                ? "正在读取行情…"
                : "输入 sh600519 等证券代码加载本地行情"}
            </Empty>
          )}
          <div className="source-line">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => watch.mutate([...watchlist, symbol])}
              disabled={isSectorChartSymbol(symbol)}
            >
              <Plus size={13} />
              加入自选
            </Button>
          </div>
          {(isMarketIndex(symbol) || isSectorChartSymbol(symbol)) && (
            <p className="text-sm text-muted-foreground">
              指数行情 · 价格单位：点
            </p>
          )}
        </section>
      </div>
      <MarketPoolBrowser
        symbol={symbol}
        disabled={load.isPending}
        onSelect={(next) => {
          setSymbol(next);
          load.mutate({ symbol: next, period, source: marketSource });
        }}
      />
      <section className="panel">
        <div className="panel-title">
          <h3>我的自选</h3>
          <span className="muted">{watchlist.length} 个标的</span>
        </div>
        <div className="watchlist">
          {watchlist.map((s) => (
            <div className="watch-item" key={s}>
              <Button
                variant="plain"
                onClick={() => {
                  setSymbol(s);
                  load.mutate({ symbol: s, period, source: marketSource });
                }}
              >
                <span className="stock-avatar">
                  {s.slice(0, 2).toUpperCase()}
                </span>
                <span>
                  <strong>{securityDisplayName(s, names)}</strong>
                  <small>{s.toUpperCase()}</small>
                </span>
                <ArrowUpRight size={16} />
              </Button>
              <Button
                variant="plain"
                className="icon-button"
                aria-label={`移除 ${s}`}
                onClick={() => watch.mutate(watchlist.filter((v) => v !== s))}
              >
                <X size={13} />
              </Button>
            </div>
          ))}
        </div>
      </section>
    </>
  );
}
