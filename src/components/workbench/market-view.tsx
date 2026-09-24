import { MarketSourceSelect } from "../market/market-source-select";
import { ChartAdjustmentSelect } from "../market/chart-adjustment-select";
import { ArrowUpRight, Plus, X } from "lucide-react";
import { useState } from "react";
import {
  chartPeriodSchema,
  periodLabels,
  type ChartPeriod,
} from "~/lib/chart/chart-view";
import {
  chartAdjustmentLabels,
  type ChartAdjustment,
} from "~/lib/chart/chart-adjustment";
import { securityDisplayName } from "~/lib/market/security-display";
import { ChartWorkspace } from "../market/chart-workspace";
import { SecuritySelect } from "../market/security-select";
import { MarketPoolBrowser } from "../market/market-pool-browser";
import { isMarketIndex } from "~/lib/market/market-indices";
import { isSectorChartSymbol } from "~/lib/chart/chart-symbol";
import { Button } from "../ui/button";
import Link from "next/link";
import {
  ArrowClockwise,
  Broadcast,
  Flask,
  Sparkle,
  Star,
} from "@phosphor-icons/react/ssr";
import { GridTable, PageGrid, Panel, SecurityCell } from "../panels";
import { TdxSidePanel } from "../market/tdx-side-panel";
import { SymbolRpsBars } from "../market/symbol-rps-bars";

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
    <PageGrid>
      <section className="panel chart-panel nc-span-9">
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
            <ArrowClockwise size={13} />
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
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 pt-3 pb-1">
          <h2 className="text-[15px] font-medium">
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
          {loaded && (
            <nav
              aria-label="对此快照"
              className="ml-auto flex items-center gap-1 text-[11.5px] text-nc-text-4"
            >
              对此快照
              {(
                [
                  ["/analysis", Sparkle, "证据分析"],
                  ["/backtest", Flask, "策略回测"],
                  ["/signals", Broadcast, "建立监控"],
                ] as const
              ).map(([href, Glyph, label]) => (
                <Button key={href} asChild size="sm" variant="ghost">
                  <Link href={href} scroll={false}>
                    <Glyph size={12} />
                    {label}
                  </Link>
                </Button>
              ))}
            </nav>
          )}
        </div>

        {load.error && !load.isPending ? (
          <div role="alert" className="p-4 text-[12px] text-nc-bad">
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
          {loaded
            ? `数据源 ${loaded.source} · 快照于 ${new Date(loaded.createdAt).toLocaleString("zh-CN", { hour12: false })} · 历史导入与回测不会发送通知`
            : "历史导入与回测不会发送通知"}
          {(isMarketIndex(symbol) || isSectorChartSymbol(symbol)) &&
            " · 指数行情 · 价格单位：点"}
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
      </section>
      <Panel
        span={3}
        icon={Broadcast}
        title={
          loaded ? securityDisplayName(loaded.symbol, names, loaded.name) : "盘口"
        }
        meta={loaded?.symbol.toUpperCase()}
        className="self-start"
      >
        {loaded ? (
          <TdxSidePanel symbol={loaded.symbol} />
        ) : (
          <Empty>先加载一只证券</Empty>
        )}
      </Panel>
      <SymbolRpsBars symbol={symbol} />
      <Panel
        span={8}
        icon={Star}
        title="我的自选"
        actions={<span className="muted">{watchlist.length} 个标的</span>}
      >
        <GridTable
          label="我的自选"
          rows={watchlist}
          rowKey={(s) => s}
          empty="在上方加载证券后加入自选"
          columns={[
            {
              key: "security",
              header: "证券",
              width: "3fr",
              cell: (s) => (
                <Button
                  variant="plain"
                  className="flex items-center gap-[9px] text-left"
                  onClick={() => {
                    setSymbol(s);
                    load.mutate({ symbol: s, period, source: marketSource });
                  }}
                >
                  <span className="stock-avatar">
                    {s.slice(0, 2).toUpperCase()}
                  </span>
                  <SecurityCell
                    name={securityDisplayName(s, names)}
                    code={s.toUpperCase()}
                  />
                  <ArrowUpRight size={14} className="text-nc-text-4" />
                </Button>
              ),
            },
            {
              key: "actions",
              header: "",
              width: "1fr",
              align: "right",
              cell: (s) => (
                <Button
                  variant="plain"
                  className="icon-button"
                  aria-label={`移除 ${s}`}
                  onClick={() => watch.mutate(watchlist.filter((v) => v !== s))}
                >
                  <X size={13} />
                </Button>
              ),
            },
          ]}
        />
      </Panel>
      <div className="nc-span-12 min-w-0">
        <MarketPoolBrowser
          symbol={symbol}
          disabled={load.isPending}
          onSelect={(next) => {
            setSymbol(next);
            load.mutate({ symbol: next, period, source: marketSource });
          }}
        />
      </div>
    </PageGrid>
  );
}
