import { MarketSourceSelect } from "../market-source-select";
import { MxDataQuery } from "../mx-data-query";
import { ArrowUpRight, Plus, X } from "lucide-react";
import { useState } from "react";
import {
  chartPeriodSchema,
  periodLabels,
  type ChartPeriod,
} from "~/lib/chart-view";
import { archivedNameHint, securityDisplayName } from "~/lib/security-display";
import { ChartWorkspace } from "../chart-workspace";
import { SecurityProfilePanel } from "../security-profile";
import { SecuritySelect } from "../security-select";
import { MarketPoolBrowser } from "../market-pool-browser";
import { isMarketIndex } from "~/lib/market-indices";
import { isSectorChartSymbol } from "~/lib/chart-symbol";
import { Button } from "../ui/button";

import { Empty, stamp } from "./shared";
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
    | "verifyIdentity"
    | "identity"
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
    verifyIdentity,
    identity,
    load,
    watch,
    watchlist,
  } = state;
  const [chartPeriod, setChartPeriod] = useState<ChartPeriod>(period);
  const displayedPeriod = chartPeriod;
  return (
    <>
      <MxDataQuery />
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
            <Button
              size="sm"
              variant="outline"
              disabled={
                verifyIdentity.isPending ||
                isMarketIndex(symbol) ||
                isSectorChartSymbol(symbol)
              }
              onClick={() => verifyIdentity.mutate(symbol)}
            >
              {verifyIdentity.isPending ? "核验中…" : "核验证券身份"}
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
            <h2
              className="text-lg font-semibold"
              title={
                loaded
                  ? archivedNameHint(loaded.symbol, names, loaded.name)
                  : undefined
              }
            >
              {loaded
                ? securityDisplayName(loaded.symbol, names, loaded.name)
                : "加载行情"}
            </h2>
            <div className="eyebrow">
              {loaded?.symbol.toUpperCase() ?? "本地行情"}{" "}
              <span className="tag">不复权</span>
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
              key={`${loaded.id}:${displayedPeriod}`}
              snapshot={loaded}
              period={displayedPeriod}
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
          {isMarketIndex(symbol) || isSectorChartSymbol(symbol) ? (
            <p className="text-sm text-muted-foreground">
              指数行情 · 价格单位：点
            </p>
          ) : (
            <SecurityProfilePanel key={symbol} symbol={symbol} />
          )}
          {identity && (
            <details className="notice">
              <summary>
                身份核验：
                {
                  {
                    confirmed: "双源一致",
                    partial: "单源确认",
                    conflict: "来源冲突",
                    unavailable: "未确认",
                  }[identity.status]
                }{" "}
                · {identity.name ?? identity.symbol}
              </summary>
              <p>
                {identity.reason} · {stamp(identity.checkedAt)}
              </p>
              <p>身份核验不代表当前正常交易；停复牌与行情时效需另外检查。</p>
              <pre>
                {JSON.stringify(
                  { tencent: identity.tencent, tdx: identity.tdx },
                  null,
                  2,
                )}
              </pre>
            </details>
          )}
        </section>
      </div>
      <p className="text-sm text-muted-foreground">
        自动模式按本地、东方财富、腾讯、tstdx顺序补齐；手动选择不跨源回退。RPS与历史研究仍使用本地数据。
      </p>
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
