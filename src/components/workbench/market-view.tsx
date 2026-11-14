import { MarketSourceSelect } from "../market/market-source-select";
import { ChartAdjustmentSelect } from "../market/chart-adjustment-select";
import { ArrowUpRight, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { chartPeriodSchema, periodLabels } from "~/lib/chart/chart-view";
import { securityDisplayName } from "~/lib/market/security-display";
import { MarketSecurityViews } from "../market/market-security-views";
import { SecuritySelect } from "../market/security-select";
import { usePeriodHotkey } from "../market/chart-hotkeys";
import { isMarketIndex } from "~/lib/market/market-indices";
import { isSectorChartSymbol } from "~/lib/chart/chart-symbol";
import { Button } from "../ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
import { PopoverTrigger, PopoverContent, PopoverClose } from "../ui/popover";
import { PanelPopover as Popover } from "./panel-popover";
import Link from "next/link";
import {
  ArrowClockwise,
  Broadcast,
  Flask,
  Sparkle,
  Star,
} from "@phosphor-icons/react/ssr";
import { GridTable, PageGrid, Panel, SecurityCell, Segmented } from "../panels";
import { TdxSidePanel } from "../market/tdx-side-panel";
import { SymbolRpsBars } from "../market/symbol-rps-bars";

import { Empty } from "./shared";
import { type MarketState } from "../market/use-market-state";
import { useBrowseHotkey } from "../market/use-browse-hotkey";
import { useSecurityNames } from "../market/use-security-names";
import { api } from "~/trpc/react";
import { useTaskVisible } from "./use-task-visible";

export function MarketView({
  state,
  notify,
}: {
  notify: (text: string) => void;
  state: Pick<
    MarketState,
    | "marketSource"
    | "marketView"
    | "setMarketView"
    | "setMarketSource"
    | "symbol"
    | "setSymbol"
    | "period"
    | "loaded"
    | "load"
    | "browse"
    | "setBrowse"
    | "chartPeriod"
    | "setChartPeriod"
    | "adjustment"
    | "setAdjustment"
  >;
}) {
  const {
    marketSource,
    marketView,
    setMarketView,
    setMarketSource,
    symbol,
    setSymbol,
    period,
    loaded,
    load,
    browse,
    setBrowse,
    chartPeriod,
    setChartPeriod,
    adjustment: chartAdjustment,
    setAdjustment: setChartAdjustment,
  } = state;
  const visible = useTaskVisible();
  const savedWatchlist = api.status.useQuery(undefined, {
    enabled: visible,
    refetchInterval: visible ? 30000 : false,
    select: (value) => value.watchlist,
  });
  const watchlist = savedWatchlist.data ?? [];
  const utils = api.useUtils();
  const watch = api.watchlist.useMutation({
    onSuccess: () => void utils.status.invalidate(),
    onError: (error) => notify(error.message),
  });
  const watchUnavailable =
    !savedWatchlist.data || !!savedWatchlist.error || watch.isPending;
  const names = useSecurityNames().data ?? {};
  const chartSymbol = loaded?.symbol ?? symbol;
  const effectiveAdjustment =
    isMarketIndex(chartSymbol) || isSectorChartSymbol(chartSymbol)
      ? "none"
      : chartAdjustment;
  const displayedPeriod = chartPeriod;
  usePeriodHotkey(
    chartPeriod,
    setChartPeriod,
    !visible || load.isPending || marketView === "financial",
  );
  const [browseEdge, setBrowseEdge] = useState("");
  const [listSource, setListSource] = useState<"candidates" | "watch">(
    "candidates",
  );
  const [candidatePage, setCandidatePage] = useState(1);
  const [listsOpen, setListsOpen] = useState(false);
  useEffect(() => {
    setCandidatePage(Math.floor((browse?.index ?? 0) / 50) + 1);
  }, [browse?.index, browse?.label]);
  const candidatePages = Math.max(
    1,
    Math.ceil((browse?.symbols.length ?? 0) / 50),
  );
  const displayedCandidatePage = Math.min(candidatePage, candidatePages);
  useBrowseHotkey(
    browse,
    (next) => {
      setBrowseEdge("");
      setBrowse(next);
      const target = next.symbols[next.index]!;
      setSymbol(target);
      load.mutate({ symbol: target, period, source: marketSource });
    },
    // Not blocked while a load is in flight: rapid PageDown is how TDX users
    // skim a list, and only the last mutate call's callbacks apply.
    (first) => setBrowseEdge(first ? "已是第一只" : "已是最后一只"),
  );
  return (
    <div className="nc-market-workspace">
      <aside className="nc-market-candidates">
        <Button
          variant="outline"
          className="nc-market-list-toggle"
          aria-expanded={listsOpen}
          aria-controls="market-candidate-lists"
          onClick={() => setListsOpen((open) => !open)}
        >
          自选与候选
        </Button>
        <div
          id="market-candidate-lists"
          className="nc-market-list-content space-y-3"
          data-expanded={listsOpen}
        >
          {browse && (
            <Segmented
              label="行情候选来源"
              value={listSource}
              onChange={setListSource}
              options={[
                { value: "candidates", label: "来源列表" },
                { value: "watch", label: "我的自选" },
              ]}
            />
          )}
          <div hidden={!browse || listSource !== "candidates"}>
            {browse && (
              <Panel
                title={browse.label}
                meta={`${browse.index + 1} / ${browse.symbols.length} · PgUp/PgDn连续翻股`}
              >
                <GridTable
                  label="来源候选"
                  rows={browse.symbols.slice(
                    (displayedCandidatePage - 1) * 50,
                    displayedCandidatePage * 50,
                  )}
                  rowKey={(value) => value}
                  columns={[
                    {
                      key: "security",
                      header: "证券",
                      cell: (value) => (
                        <Button
                          variant="plain"
                          className="w-full text-left"
                          aria-current={symbol === value ? "true" : undefined}
                          onClick={() => {
                            const index = browse.symbols.indexOf(value);
                            setBrowse({ ...browse, index });
                            setBrowseEdge("");
                            setSymbol(value);
                            load.mutate({
                              symbol: value,
                              period,
                              source: marketSource,
                            });
                          }}
                        >
                          <SecurityCell
                            name={securityDisplayName(value, names)}
                            code={value.toUpperCase()}
                          />
                        </Button>
                      ),
                    },
                  ]}
                  rowClassName={(value) =>
                    symbol === value ? "bg-nc-accent-900" : undefined
                  }
                />
                <nav
                  aria-label="候选列表分页"
                  className="mt-3 flex items-center justify-between gap-2"
                >
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={displayedCandidatePage === 1}
                    onClick={() => setCandidatePage(displayedCandidatePage - 1)}
                  >
                    上一页
                  </Button>
                  <span className="text-[13px]">
                    {displayedCandidatePage}/{candidatePages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={displayedCandidatePage === candidatePages}
                    onClick={() => setCandidatePage(displayedCandidatePage + 1)}
                  >
                    下一页
                  </Button>
                </nav>
              </Panel>
            )}
          </div>
          <div hidden={!!browse && listSource === "candidates"}>
            <Panel
              span={8}
              icon={Star}
              title="我的自选"
              actions={
                <span className="muted">
                  {savedWatchlist.data
                    ? `${watchlist.length} 个标的`
                    : "尚未读取"}
                </span>
              }
            >
              {savedWatchlist.error && (
                <p role="alert">
                  自选列表未刷新：{savedWatchlist.error.message}{" "}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void savedWatchlist.refetch()}
                  >
                    重试自选列表
                  </Button>
                </p>
              )}
              <GridTable
                label="我的自选"
                rows={watchlist}
                rowKey={(s) => s}
                empty={
                  savedWatchlist.error
                    ? "暂时无法读取自选列表"
                    : !savedWatchlist.data
                      ? "正在读取自选列表…"
                      : "在上方加载证券后加入自选"
                }
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
                          load.mutate({
                            symbol: s,
                            period,
                            source: marketSource,
                          });
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
                        disabled={watchUnavailable}
                        onClick={() =>
                          watch.mutate(watchlist.filter((v) => v !== s))
                        }
                      >
                        <X size={13} />
                      </Button>
                    ),
                  },
                ]}
              />
            </Panel>
          </div>
        </div>
      </aside>
      <div className="min-w-0 space-y-4">
        <section className="panel chart-panel nc-span-12">
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
              onPeriod={setChartPeriod}
              onSelect={(next) => {
                setSymbol(next);
                load.mutate({
                  symbol: next,
                  period,
                  source: marketSource,
                });
              }}
            />
            {browse && (
              <span
                role="status"
                className="flex items-center gap-1 text-xs text-nc-text-3"
                title="PageUp/PageDown 切换上一只/下一只"
              >
                {browse.label} {browse.index + 1}/{browse.symbols.length} ·
                PgUp/PgDn 换股{browseEdge && ` · ${browseEdge}`}
                <Button
                  size="sm"
                  variant="plain"
                  aria-label="退出列表翻股"
                  onClick={() => {
                    setBrowse(null);
                    setBrowseEdge("");
                  }}
                >
                  ×
                </Button>
              </span>
            )}
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
                load.mutate(
                  { symbol, period, source: marketSource },
                  { fresh: true },
                )
              }
            >
              <ArrowClockwise size={13} />
              刷新行情
            </Button>
            <Select
              value={displayedPeriod}
              disabled={load.isPending}
              onValueChange={(value) =>
                setChartPeriod(chartPeriodSchema.parse(value))
              }
            >
              <SelectTrigger
                aria-label="行情周期"
                title="F8 切换周期"
                className="w-auto min-w-28"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {chartPeriodSchema.options.map((p) => (
                  <SelectItem key={p} value={p}>
                    {p === "day" ? "日 K" : periodLabels[p]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {load.error && !load.isPending ? (
            <div role="alert" className="p-4 text-[13px] text-nc-bad">
              所选数据源读取失败：{load.error.message}
              {loaded ? "；下方仍为已加载快照，并非本次读取结果。" : ""}
              <Button
                variant="outline"
                onClick={() =>
                  load.mutate({ symbol, period, source: marketSource })
                }
              >
                重试
              </Button>
            </div>
          ) : null}
          {load.isPending && (
            <p role="status" className="px-4 py-2 text-sm text-nc-text-3">
              正在读取所选行情；下方若有图表，仍为{" "}
              {loaded?.symbol.toUpperCase() ?? "原快照"}。
            </p>
          )}
          {loaded ? (
            <MarketSecurityViews
              snapshot={loaded}
              period={displayedPeriod}
              adjustment={effectiveAdjustment}
              view={marketView}
              onViewChange={setMarketView}
              heading={
                <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                  <h2 className="text-[15px] font-medium">
                    {securityDisplayName(loaded.symbol, names, loaded.name)}
                  </h2>
                  <span className="eyebrow">{loaded.symbol.toUpperCase()}</span>
                  {loaded.historicalAsOf && (
                    <span className="tag">
                      历史快照 · 截至 {loaded.historicalAsOf}
                    </span>
                  )}
                </div>
              }
              actions={
                <Popover>
                  <PopoverTrigger asChild>
                    <Button size="sm" variant="ghost" className="ml-auto">
                      继续研究
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent aria-label="继续研究">
                    <nav aria-label="继续研究" className="flex flex-col gap-2">
                      {(
                        [
                          ["/analysis", Sparkle, "证据分析"],
                          ["/backtest", Flask, "策略回测"],
                          ["/signals", Broadcast, "监控配置"],
                        ] as const
                      ).map(([href, Glyph, label]) => (
                        <PopoverClose key={href} asChild>
                          <Button asChild size="sm" variant="ghost">
                            <Link href={href} scroll={false}>
                              <Glyph size={12} />
                              {label}
                            </Link>
                          </Button>
                        </PopoverClose>
                      ))}
                    </nav>
                  </PopoverContent>
                </Popover>
              }
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
            {(isMarketIndex(chartSymbol) || isSectorChartSymbol(chartSymbol)) &&
              " · 指数行情 · 价格单位：点"}
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                loaded && watch.mutate([...watchlist, loaded.symbol])
              }
              disabled={
                !loaded ||
                watchUnavailable ||
                load.isPending ||
                isSectorChartSymbol(loaded.symbol) ||
                watchlist.includes(loaded.symbol)
              }
            >
              <Plus size={13} />
              加入自选
            </Button>
          </div>
        </section>
        <details className="rounded-lg border border-nc-border bg-nc-card p-4">
          <summary className="cursor-pointer text-sm font-medium">
            盘口、基本面与RPS · 展开查看
          </summary>
          <PageGrid>
            <Panel
              span={12}
              icon={Broadcast}
              title={
                loaded
                  ? securityDisplayName(loaded.symbol, names, loaded.name)
                  : "盘口"
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
            <SymbolRpsBars symbol={loaded?.symbol ?? symbol} />
          </PageGrid>
        </details>
      </div>
    </div>
  );
}
